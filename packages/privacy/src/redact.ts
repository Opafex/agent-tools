/**
 * The redaction engine.
 *
 * Two entry points:
 *   redactText(str)   — tokenise PII inside a string (log line, stack trace, prose)
 *   scrubValue(value) — deep-walk arbitrary JSON, applying redactText to every
 *                       string and killing credential-named keys outright
 *
 * ---------------------------------------------------------------------------
 * WHY TOKENS, NOT MASKS
 * ---------------------------------------------------------------------------
 * The usual approach is to MASK (`j***@example.com`, `***-***-1234`).
 * Masking leaks — a masked email still shows the domain, a masked card the last
 * four. It also destroys the one property that makes a redacted log debuggable:
 * being able to see that the same value appeared twice. Tokens fix both. Within
 * a single redaction pass the same input always yields the same token, so
 * "[EMAIL_1] failed, retried [EMAIL_1]" still tells you it was one user.
 *
 * Tokens are per-pass, NOT global: a stable cross-log token would be a
 * pseudonymous identifier, which is still personal data under GDPR and would
 * quietly recreate the thing we are removing.
 */

import {
  PII_PATTERNS,
  SECRET_KEY_RE,
  API_KEY_RE,
  UUID_RE,
  type PiiKind,
} from './patterns.js';

export const REDACTED = '[redacted]';

/** Bounds on what `scrubValue` will walk, so a runaway payload cannot stall a logger. */
const MAX_STRING = 2000;
const MAX_ARRAY = 200;
const MAX_DEPTH = 8;

/**
 * Delimiter wrapped around UUID placeholders while patterns run.
 *
 * NUL is used deliberately: it cannot occur in any log line, error message or
 * JSON string we will ever be handed, so a placeholder can never be forged by
 * input data or collide with real content. A printable delimiter could be — a
 * log line containing the delimiter text would corrupt on restore.
 *
 * CONSTRUCTED, never typed as a literal control character in this file: a raw
 * NUL byte in source makes the file binary to git, which costs diffs, review
 * and blame.
 */
const SENTINEL = String.fromCharCode(0);
const RESTORE_RE = new RegExp(SENTINEL + 'UUID(\\d+)' + SENTINEL, 'g');

export interface RedactionCounts {
  /** How many DISTINCT values of each kind were replaced. */
  byKind: Partial<Record<PiiKind, number>>;
  total: number;
}

export interface RedactTextResult {
  text: string;
  counts: RedactionCounts;
}

/**
 * A per-pass token allocator. Keeps `value -> token` stable within one pass so
 * repeated values read as repeated, and resets between passes so tokens never
 * become durable pseudonyms.
 */
class TokenTable {
  private readonly assigned = new Map<string, string>();
  private readonly nextIndex = new Map<PiiKind, number>();

  tokenFor(kind: PiiKind, value: string): string {
    const key = `${kind}:${value}`;
    const existing = this.assigned.get(key);
    if (existing) return existing;

    const n = (this.nextIndex.get(kind) ?? 0) + 1;
    this.nextIndex.set(kind, n);
    const token = `[${kind}_${n}]`;
    this.assigned.set(key, token);
    return token;
  }

  counts(): RedactionCounts {
    const byKind: Partial<Record<PiiKind, number>> = {};
    for (const [kind, n] of this.nextIndex) byKind[kind] = n;
    return { byKind, total: this.assigned.size };
  }
}

/**
 * Replace UUIDs with inert placeholders before pattern matching, then restore.
 *
 * Without this, the CARD pattern (13-19 digits with optional separators) happily
 * eats an all-numeric UUID, and correlation IDs — the thing you most need in a
 * redacted log — vanish. UUIDs are handles, not personal data.
 */
function protectUuids(input: string): { text: string; restore: (s: string) => string } {
  const held: string[] = [];
  const text = input.replace(UUID_RE, (match) => {
    held.push(match);
    return `${SENTINEL}UUID${held.length - 1}${SENTINEL}`;
  });
  const restore = (s: string): string =>
    s.replace(RESTORE_RE, (_m, i: string) => held[Number(i)] ?? '');
  return { text, restore };
}

/**
 * Tokenise every PII match in a string. Credentials are killed outright rather
 * than tokenised — a stable token for a secret would still allow correlating it.
 */
export function redactTextWithCounts(input: string, table = new TokenTable()): RedactTextResult {
  if (!input) return { text: input, counts: table.counts() };

  const protectedInput = protectUuids(input);
  let out = protectedInput.text;

  // Credentials first, and unconditionally — never tokenised.
  out = out.replace(API_KEY_RE, REDACTED);

  for (const { kind, regex } of PII_PATTERNS) {
    // Fresh RegExp per use: the shared literals carry /g, and a module-level
    // lastIndex would make results depend on call order.
    const re = new RegExp(regex.source, regex.flags);
    out = out.replace(re, (match) => table.tokenFor(kind, match.trim()));
  }

  return { text: protectedInput.restore(out), counts: table.counts() };
}

/** Convenience wrapper when the caller only wants the text. */
export function redactText(input: string): string {
  return redactTextWithCounts(input).text;
}

function truncate(s: string): string {
  if (s.length <= MAX_STRING) return s;
  return `${s.slice(0, MAX_STRING)}…[+${s.length - MAX_STRING} chars]`;
}

/**
 * Deep-scrub an arbitrary JSON-ish value. Returns a new value; never mutates.
 *
 * Keys whose NAME proves a credential are killed regardless of their value —
 * this catches secrets that match no pattern (a random 32-char vault key looks
 * like nothing in particular).
 */
export function scrubValue<T>(value: T, depth = 0, table = new TokenTable()): T {
  if (value == null) return value;
  if (depth > MAX_DEPTH) return '[truncated]' as unknown as T;

  if (typeof value === 'string') {
    return truncate(redactTextWithCounts(value, table).text) as unknown as T;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;

  if (Array.isArray(value)) {
    const limited: unknown[] = value
      .slice(0, MAX_ARRAY)
      .map((v) => scrubValue(v, depth + 1, table));
    if (value.length > MAX_ARRAY) limited.push(`[+${value.length - MAX_ARRAY} more]`);
    return limited as unknown as T;
  }

  if (value instanceof Date) return value;

  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY_RE.test(k) ? REDACTED : scrubValue(v, depth + 1, table);
    }
    return out as unknown as T;
  }

  return value;
}

/**
 * Redact an Error for logging: message and any string-valued own properties are
 * tokenised, while `name` and `stack` are PRESERVED — a redactor that eats stack
 * traces gets turned off, and the stack is where the diagnosis lives.
 *
 * The stack's MESSAGE line is redacted, since Node prepends `message` to `stack`
 * and it would otherwise leak straight back out.
 */
export function redactError(error: Error): {
  name: string;
  message: string;
  stack?: string;
  code?: string;
} {
  const table = new TokenTable();
  const message = redactTextWithCounts(error.message, table).text;

  let stack = error.stack;
  if (stack && error.message) {
    // Replace only the message occurrence(s), leaving frame lines untouched.
    stack = stack.split(error.message).join(message);
  }

  return {
    name: error.name,
    message,
    stack,
    code: (error as { code?: string }).code,
  };
}

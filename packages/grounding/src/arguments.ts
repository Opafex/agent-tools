/**
 * Grounded tool arguments.
 *
 * The prose checks catch an invented value after the agent has said it. This
 * check catches one before it is acted on: a tool call that sends an email to
 * an address nobody gave, or updates a record id nobody returned. Those are
 * the invented values that do damage, and they are cheap to stop because the
 * call has not run yet.
 *
 * The rule is about provenance, not plausibility. An identifier-shaped
 * argument must appear in something the person wrote (or the operator's
 * instructions) or in the result of another tool. The model's own text never
 * counts, and neither does a result that merely echoed the value back.
 *
 * Measured on a 4B local model (qwen3.5:4b) over 21 business tasks: without a
 * check it sent mail to three addresses it had made up; with it, none.
 *
 * Method (deterministic, no model call):
 *   1. Walk the call's arguments and keep each string whose WHOLE value is
 *      identifier-shaped: an email address, a URL, a UUID, a prefixed record
 *      id (`ct_8f2k`, `INV-20931`), a long opaque id, or a phone number.
 *      Free text (an email body, a note) is not scanned: put the prose checks
 *      on it.
 *   2. Build the evidence from the transcript (see `argumentEvidence`).
 *   3. Report each value that does not occur in it as a whole token. An email
 *      address must occur whole: a pattern-built `first.last@firm.com` is
 *      ungrounded even when `firm.com` is in the evidence. A phone number is
 *      compared on its digits, so `+44 20 7946 0811` matches `020 7946 0811`.
 *
 * Refuse the call when the result fails, and send `message` back to the model
 * as the tool result so it can look the value up or ask. Never repair the
 * call by guessing a replacement.
 */

import { lower } from './text.js';
import { argumentEvidence, type EvidenceOptions, type TranscriptTurn } from './transcript.js';

export type ArgumentKind = 'email' | 'url' | 'uuid' | 'id' | 'phone';

export interface ToolCall {
  tool: string;
  /** The arguments object, or its JSON string. */
  args: unknown;
}

export interface ArgumentCheckOptions extends EvidenceOptions {
  /** Which shapes to check. Default: all five. */
  kinds?: readonly ArgumentKind[];
  /**
   * The shape of a record id in your system, matched against the whole value.
   * Default: a short alphabetic prefix, `_` or `-`, then at least 3
   * characters including a digit (`ct_8f2k`, `dl_e8p1`, `INV-20931`), or any
   * run of 16+ letters, digits, `_` or `-` that contains a digit.
   */
  idPattern?: RegExp;
  /**
   * Argument paths never checked, e.g. `['subject', 'body']` or
   * `['items[].note']`. Matched against the path in `UngroundedArgument.path`
   * with array indexes written as `[]`.
   */
  ignorePaths?: readonly string[];
}

export interface UngroundedArgument {
  /** Where the value was, e.g. `to[0]` or `contact.email`. */
  path: string;
  value: string;
  kind: ArgumentKind;
}

export interface ArgumentCheckResult {
  /** `skipped` when the call carried no identifier-shaped value. */
  status: 'passed' | 'failed' | 'skipped';
  /** Distinct values checked. */
  checked: number;
  ungrounded: UngroundedArgument[];
  /** A refusal to send back to the model as the tool result; empty unless `failed`. */
  message: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[A-Za-z]{2,24}$/;
const URL_RE = /^https?:\/\/\S+$/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// The tail may carry further separators: a guessed id is often a slug
// (`dl_corvane_2026`), and that is exactly the value to catch.
const PREFIXED_ID_RE = /^[A-Za-z]{1,8}[_-][A-Za-z0-9_-]{3,}$/;
const LONG_ID_RE = /^[A-Za-z0-9_-]{16,}$/;
const PHONE_RE = /^\+?[\d\s().-]{7,20}$/;
const ALL_KINDS: readonly ArgumentKind[] = ['email', 'url', 'uuid', 'id', 'phone'];
const DATE_LIKE_RE = /^\d{4}-\d{2}-\d{2}/;

function defaultIsId(v: string): boolean {
  if (!/\d/.test(v)) return false;
  return PREFIXED_ID_RE.test(v) || LONG_ID_RE.test(v);
}

/** The kind of an identifier-shaped value, or `null` for anything else. */
export function argumentKind(value: string, idPattern?: RegExp): ArgumentKind | null {
  const v = value.trim();
  if (!v || v.length > 2048) return null;
  if (EMAIL_RE.test(v)) return 'email';
  if (URL_RE.test(v)) return 'url';
  if (UUID_RE.test(v)) return 'uuid';
  if (DATE_LIKE_RE.test(v)) return null;
  if (idPattern ? idPattern.test(v) : defaultIsId(v)) return 'id';
  if (PHONE_RE.test(v) && digitsOf(v).length >= 7 && /[\s().+-]/.test(v)) return 'phone';
  return null;
}

function digitsOf(s: string): string {
  return s.replace(/\D+/g, '');
}

function normalisePath(path: string): string {
  return path.replace(/\[\d+\]/g, '[]');
}

/** Every identifier-shaped string value in `args`, with its path. */
export function identifierArguments(
  args: unknown,
  options: Pick<ArgumentCheckOptions, 'kinds' | 'idPattern' | 'ignorePaths'> = {},
): UngroundedArgument[] {
  const kinds = new Set(options.kinds ?? ALL_KINDS);
  const ignore = new Set((options.ignorePaths ?? []).map(normalisePath));
  const out: UngroundedArgument[] = [];
  const seen = new Set<string>();
  let root = args;
  if (typeof root === 'string') {
    try {
      root = JSON.parse(root);
    } catch {
      return out;
    }
  }
  const walk = (v: unknown, path: string, depth: number): void => {
    if (depth > 8) return;
    if (path && ignore.has(normalisePath(path))) return;
    if (typeof v === 'string') {
      const kind = argumentKind(v, options.idPattern);
      const key = lower(v.trim());
      if (kind && kinds.has(kind) && !seen.has(key)) {
        seen.add(key);
        out.push({ path, value: v.trim(), kind });
      }
    } else if (Array.isArray(v)) {
      v.forEach((item, i) => walk(item, `${path}[${i}]`, depth + 1));
    } else if (v && typeof v === 'object') {
      for (const [k, child] of Object.entries(v)) walk(child, path ? `${path}.${k}` : k, depth + 1);
    }
  };
  walk(root, '', 0);
  return out;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Does `value` occur in the (lower-cased) evidence as a whole token? */
export function valueInEvidence(value: string, kind: ArgumentKind, evidence: string): boolean {
  if (!evidence) return false;
  if (kind === 'phone') {
    const digits = digitsOf(value);
    // Compare the national number: the last 9 digits survive a country code
    // or a trunk zero being added or dropped.
    const tail = digits.slice(-Math.min(9, digits.length));
    return phoneRuns(evidence).some((run) => run.endsWith(tail));
  }
  const needle = lower(value);
  // Bounded on both sides, so `ct_8f2` is not grounded by `ct_8f2k` and
  // `sam@acme.com` is not grounded by `jsam@acme.com`.
  return new RegExp(`(?<![\\w.+@-])${escapeRe(needle)}(?![\\w@-])`).test(evidence);
}

/** Digit runs in text that look like phone numbers, digits only. */
function phoneRuns(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\+?\d[\d\s().-]{5,22}\d/g)) out.push(digitsOf(m[0]));
  return out;
}

export function ungroundedArgumentMessage(values: readonly UngroundedArgument[]): string {
  const list = values.map((v) => v.value).join(', ');
  const verb = values.length === 1 ? 'appears' : 'appear';
  return (
    `Refused: ${list} ${verb} in no message from the user and in no tool result, so it was supplied by you. ` +
    'Nothing was run. Use only values the user gave or a tool returned: look the value up with a tool first, ' +
    'and never construct an email address or id from a pattern. If you cannot find it, ask the user.'
  );
}

/** Check one proposed tool call before it runs. Pure. */
export function checkToolArguments(
  input: { call: ToolCall; transcript: readonly TranscriptTurn[] },
  options: ArgumentCheckOptions = {},
): ArgumentCheckResult {
  const values = identifierArguments(input.call?.args, options);
  if (values.length === 0) return { status: 'skipped', checked: 0, ungrounded: [], message: '' };
  const evidence = argumentEvidence(input.transcript, input.call.tool, options);
  const ungrounded = values.filter((v) => !valueInEvidence(v.value, v.kind, evidence));
  return {
    status: ungrounded.length > 0 ? 'failed' : 'passed',
    checked: values.length,
    ungrounded,
    message: ungrounded.length > 0 ? ungroundedArgumentMessage(ungrounded) : '',
  };
}

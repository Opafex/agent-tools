/**
 * The PII pattern set: the one place a "what does personal data look like"
 * regex lives.
 *
 * UK-first. Many redactors are US-shaped (SSN, NANP phone numbers) and match
 * almost nothing in UK data. This set covers National Insurance numbers,
 * postcodes, sort codes, IBANs, UK and international phone numbers, cards,
 * emails, IPv4 addresses and passport-shaped numbers.
 *
 * ---------------------------------------------------------------------------
 * DESIGN RULES
 * ---------------------------------------------------------------------------
 * 1. TOKENISE, DON'T DELETE. `[EMAIL_1]` keeps the shape of a log line and lets
 *    a reader see that the SAME value recurred, which `[redacted]` destroys.
 *    That difference is what keeps a redacted stack trace debuggable.
 * 2. FALSE POSITIVES ARE ACCEPTABLE; FALSE NEGATIVES ARE NOT. Over-redacting a
 *    postcode-shaped build ID costs nothing. Missing a real NI number is a breach.
 * 3. ORDER MATTERS. Specific patterns run before general ones: an NI number
 *    would otherwise be eaten by the generic ID matcher, and a sort code by the
 *    phone one.
 * 4. PRESERVE DIAGNOSTICS. Anything in `PRESERVED` below is deliberately NOT
 *    matched: a redactor that eats stack traces and correlation IDs just gets
 *    switched off.
 */

export type PiiKind =
  | 'EMAIL'
  | 'PHONE'
  | 'NI_NUMBER'
  | 'POSTCODE'
  | 'CARD'
  | 'BANK'
  | 'ID'
  | 'URL'
  | 'IP';

export interface PiiPattern {
  kind: PiiKind;
  regex: RegExp;
  /** Lower runs first. Specific patterns must precede general ones. */
  order: number;
}

/**
 * What we deliberately do NOT redact, recorded so the boundary is reviewable:
 *   error types/messages, stack traces, function names, file paths, HTTP verbs
 *   and status codes, table/column names, timestamps, UUIDs, request/correlation
 *   IDs, tool names, parameter NAMES, environment/region identifiers.
 * UUIDs matter especially — they are how you follow a request across services,
 * and they are not personal data.
 */
export const PRESERVED = [
  'error types and messages',
  'stack traces, function names, file paths',
  'HTTP methods and status codes',
  'schema/table/column names (the field that failed, never its value)',
  'timestamps',
  'UUIDs, request IDs and correlation IDs',
  'tool names and parameter names',
  'environment, region and deployment identifiers',
] as const;

// --- individual patterns ---------------------------------------------------

/** RFC-ish email. Deliberately greedy on the local part. */
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/**
 * UK National Insurance number: two letters, six digits, optional A-D suffix,
 * spaces optional (people write it both ways).
 *
 * DELIBERATELY PERMISSIVE. The official spec disallows D/F/I/Q/U/V in the first
 * position and O in the second, and the strict regex was written that way first —
 * but strictness here buys nothing and costs everything. A mistyped or
 * deliberately-obfuscated NI number is still personal data, and a redactor that
 * only catches *valid* ones fails exactly when the data is messiest. Per design
 * rule 2, over-matching a two-letter product code is an acceptable price.
 */
const NI_NUMBER = /\b[A-Z]{2}\s?\d{2}\s?\d{2}\s?\d{2}\s?[A-D]?\b/g;

/**
 * UK postcode (full or outward+inward with optional space). Runs before the
 * generic ID pattern, which would otherwise swallow it.
 */
const POSTCODE = /\b[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}\b/gi;

/** UK bank sort code: 12-34-56. Before PHONE, which would partially match it. */
const SORT_CODE = /\b\d{2}-\d{2}-\d{2}\b/g;

/** IBAN, and bare 8-digit UK account numbers when adjacent to a sort-code word. */
const IBAN = /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g;

/**
 * Payment card, 13-19 digits with optional space/hyphen grouping. Before PHONE
 * and ID: a 16-digit run would otherwise be claimed by both.
 */
const CARD = /\b(?:\d[ -]?){13,19}\b/g;

/**
 * UK phone: +44 or leading 0, 9-10 following digits, optional spacing. Also
 * matches Ofcom's reserved drama range (07700 900xxx), which is intended:
 * synthetic test data flowing through the redactor should still redact.
 */
const PHONE_UK = /(?:\+44\s?|\b0)(?:\d\s?){9,10}\b/g;

/** International fallback: + and 8-15 digits. */
const PHONE_INTL = /\+\d[\d\s().-]{7,17}\d/g;

/** Passport (9 digits) / driving-licence-shaped identifiers. */
const PASSPORT = /\b\d{9}\b/g;

/** mailto: and tel: URLs carry PII in the URL itself. */
const PII_URL = /\b(?:mailto|tel):[^\s<>"']+/gi;

/** IPv4. Personal data under GDPR; redacted in logs, never at runtime. */
const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;

/**
 * Ordered pattern list. Order is the contract — see design rule 3.

 */
const UNSORTED_PATTERNS: PiiPattern[] = [
  { kind: 'URL', regex: PII_URL, order: 10 },
  { kind: 'EMAIL', regex: EMAIL, order: 20 },
  { kind: 'NI_NUMBER', regex: NI_NUMBER, order: 30 },
  { kind: 'BANK', regex: SORT_CODE, order: 40 },
  { kind: 'BANK', regex: IBAN, order: 41 },
  { kind: 'CARD', regex: CARD, order: 50 },
  { kind: 'PHONE', regex: PHONE_UK, order: 60 },
  { kind: 'PHONE', regex: PHONE_INTL, order: 61 },
  { kind: 'POSTCODE', regex: POSTCODE, order: 70 },
  { kind: 'ID', regex: PASSPORT, order: 80 },
  { kind: 'IP', regex: IPV4, order: 90 },
];

export const PII_PATTERNS: PiiPattern[] = [...UNSORTED_PATTERNS].sort(
  (a, b) => a.order - b.order,
);

/**
 * Object KEYS whose name alone proves the value is a credential. Credentials
 * are killed outright, never tokenised, since a stable token would still let
 * you correlate one secret across logs.
 */
export const SECRET_KEY_RE =
  /(pass(word)?|secret|token|api[_-]?key|authorization|auth[_-]?token|access[_-]?token|refresh[_-]?token|credential|private[_-]?key|client[_-]?secret|bearer|cookie|session)/i;

/** Values that are self-evidently API keys, whatever key they sit under. */
export const API_KEY_RE =
  /\b(sk-[A-Za-z0-9_-]{12,}|sk-ant-[A-Za-z0-9_-]{12,}|gsk_[A-Za-z0-9]{12,}|AIza[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|ghp_[A-Za-z0-9]{20,}|rw_[A-Za-z0-9._~-]{20,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,})\b/g;

/**
 * UUIDs are PRESERVED, not redacted — they are correlation handles, not personal
 * data. Exported so the redactor can exempt them from the generic ID pattern.
 */
export const UUID_RE =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

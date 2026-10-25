/**
 * Correlation masking — deliberately NOT redaction.
 *
 * `maskSecret` exists for values that are TENANT identifiers rather than personal
 * data: license keys, product keys, API-key prefixes. In a log you need enough of
 * one to tell two tenants apart while chasing a bug, and not enough to reuse it.
 *
 * This is the one place masking is the right tool, and the distinction is worth
 * holding onto: everywhere else in this package we TOKENISE, because a mask of
 * personal data still leaks (`j***@example.com` gives you the domain). A license
 * key is not personal data, so a partial reveal is a correlation aid rather than
 * a leak — and unlike a token it stays stable across log lines and processes,
 * which is the entire point.
 *
 * Do NOT reach for this for emails, phone numbers or names. Use `redactText`.
 */

/**
 * Mask a tenant/credential identifier for logs.
 * `XXXX-YYYY-ZZZZ-EXMPL` → `XXXX…MPL`
 */
export function maskSecret(value: string | null | undefined): string {
  if (!value) return '∅';
  if (value.length <= 8) return '***';
  return `${value.slice(0, 4)}…${value.slice(-3)}`;
}

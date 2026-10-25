/**
 * Small text helpers shared by every check.
 */

/** Lower-case any value as a string. `null` and `undefined` become `''`. */
export function lower(value: unknown): string {
  if (value == null) return '';
  try {
    return String(value).toLowerCase();
  } catch {
    return '';
  }
}

/**
 * A short window of prose around a match, with whitespace collapsed, so a
 * finding can quote the exact phrase that needs fixing.
 */
export function contextWindow(text: string, at: number, length: number, max = 120): string {
  const start = Math.max(0, at - 30);
  const end = Math.min(text.length, at + length + 30);
  return text.slice(start, end).replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * Split prose into sentences. A boundary is sentence-ending punctuation
 * followed by whitespace, or a newline, so each markdown bullet is its own
 * sentence.
 */
export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

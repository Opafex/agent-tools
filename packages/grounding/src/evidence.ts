/**
 * Evidence: what the agent could legitimately have read.
 *
 * Every check compares prose (or written values) against the tool results the
 * agent actually received. Evidence is passed as a list of items: a string is
 * used as-is, anything else is serialised with `JSON.stringify`. Citation
 * sources (see `CitationIndex`) count as evidence too.
 */

import { lower } from './text.js';

/**
 * One citable tool result. Keyed in a `CitationIndex` by the id your citation
 * marker captures (with the default marker, `[tc3]` cites the key `tc3`).
 */
export interface CitationSource {
  /** The tool result text the agent saw, or the part of it you retained. */
  content?: string;
  /**
   * How many rows or items the tool returned, when you know it. Used only by
   * `checkCitationCounts`. `null` or absent means unknown.
   */
  rowCount?: number | null;
  /** Free-form label for your own reporting, such as the tool name. Never read. */
  label?: string;
}

/** Citation id to the tool result it refers to. */
export type CitationIndex = Record<string, CitationSource>;

/** Serialise one evidence item to text, or `null` when it cannot be. */
export function serialiseEvidence(item: unknown): string | null {
  if (item === undefined || item === null) return null;
  if (typeof item === 'string') return item;
  try {
    return JSON.stringify(item) ?? null;
  } catch {
    // Circular or otherwise unserialisable. Nothing in it can back a claim.
    return null;
  }
}

/**
 * Build one lower-cased blob of every piece of evidence. The checks test for
 * substring presence in it: cheap, deterministic, and easy to reason about.
 */
export function buildEvidenceText(
  evidence: readonly unknown[] | undefined,
  citations?: CitationIndex,
): string {
  const parts: string[] = [];
  for (const item of evidence ?? []) {
    const text = serialiseEvidence(item);
    if (text) parts.push(text);
  }
  if (citations) {
    for (const source of Object.values(citations)) {
      if (source?.content) parts.push(source.content);
    }
  }
  return lower(parts.join('\n'));
}

/**
 * Is `token` present in the (already lower-cased) evidence text?
 *
 * A short hex prefix counts as present when the evidence holds a longer hex
 * string starting with it: an API returns a full commit hash and the agent
 * abbreviates it to the conventional seven characters, which is not invention.
 */
export function appearsInEvidence(token: string, evidenceText: string): boolean {
  if (evidenceText.length === 0) return false;
  const needle = lower(token);
  if (evidenceText.includes(needle)) return true;
  if (/^[0-9a-f]{7,9}$/.test(needle)) {
    // Safe to build a pattern from: the needle is hex only.
    if (new RegExp(`\\b${needle}[0-9a-f]+\\b`).test(evidenceText)) return true;
  }
  return false;
}

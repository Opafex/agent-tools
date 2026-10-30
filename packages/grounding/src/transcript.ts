/**
 * Transcript: the conversation a tool call is checked against.
 *
 * The prose checks take a flat list of evidence. The argument checks need to
 * know who said what, because the rule is about provenance: a value may come
 * from the person (or the operator's instructions) or from a tool result, and
 * never from the model itself. So they take the conversation as turns.
 *
 * Map your own message format onto `TranscriptTurn`. Every field but `role`
 * and `content` is optional, and each one you fill in makes the checks
 * stricter in a specific, documented way.
 */

import { stripEchoedIdentifiers } from './echoes.js';
import { serialiseEvidence } from './evidence.js';
import { lower } from './text.js';

export interface TranscriptTurn {
  role: 'user' | 'system' | 'assistant' | 'tool';
  /** The message text, or a tool's result (any JSON value). */
  content: unknown;
  /** For a `tool` turn: the tool that produced it. */
  tool?: string;
  /**
   * For a `tool` turn: the arguments of the call that produced it. When given,
   * identifiers the result merely repeated from these arguments are masked
   * (see `stripEchoedIdentifiers`), so an invented value cannot back itself by
   * being echoed.
   */
  args?: unknown;
  /**
   * For a `tool` turn: `false` when the call failed. A failed call's result is
   * not evidence, because an error message usually quotes the value it refused
   * ("no contact with id ct_x9x9").
   */
  ok?: boolean;
}

/** Which system turns count as evidence. */
export type SystemEvidence = 'first' | 'all' | 'none';

export interface EvidenceOptions {
  /**
   * Which `system` turns count. Default `'first'`: the operator's own prompt
   * (which often holds the owner's address or account id) counts, but later
   * system turns do not, because a harness usually injects those and they can
   * quote the model's own words back to it (a plan it wrote, a nudge).
   */
  systemEvidence?: SystemEvidence;
}

/**
 * The text a value passed to `tool` may be grounded in, lower-cased: user
 * turns, the chosen system turns, and the results of OTHER tools' calls that
 * did not fail, with echoes masked. Assistant turns never count, and neither
 * do results of the same tool, which echo the values they were given (a second
 * call with an invented value would otherwise ground itself on the first).
 */
export function argumentEvidence(
  transcript: readonly TranscriptTurn[] | undefined,
  tool: string,
  options: EvidenceOptions = {},
): string {
  const systemMode = options.systemEvidence ?? 'first';
  const parts: string[] = [];
  let seenSystem = false;
  for (const turn of transcript ?? []) {
    if (!turn) continue;
    if (turn.role === 'user') {
      const text = serialiseEvidence(turn.content);
      if (text) parts.push(text);
    } else if (turn.role === 'system') {
      const counts = systemMode === 'all' || (systemMode === 'first' && !seenSystem);
      seenSystem = true;
      const text = counts ? serialiseEvidence(turn.content) : null;
      if (text) parts.push(text);
    } else if (turn.role === 'tool') {
      if (turn.ok === false) continue;
      if (turn.tool !== undefined && turn.tool === tool) continue;
      const text = turn.args === undefined ? serialiseEvidence(turn.content) : stripEchoedIdentifiers(turn.content, turn.args);
      if (text) parts.push(text);
    }
  }
  return lower(parts.join('\n'));
}

/** The text of every user turn, lower-cased. */
export function userText(transcript: readonly TranscriptTurn[] | undefined): string {
  const parts: string[] = [];
  for (const turn of transcript ?? []) {
    if (turn?.role !== 'user') continue;
    const text = serialiseEvidence(turn.content);
    if (text) parts.push(text);
  }
  return lower(parts.join('\n'));
}

/** A tool turn's result as a JSON value: parsed when it is a JSON string. */
export function resultValue(content: unknown): unknown {
  if (typeof content !== 'string') return content;
  const t = content.trim();
  if (!t.startsWith('{') && !t.startsWith('[')) return content;
  try {
    return JSON.parse(t);
  } catch {
    return content;
  }
}

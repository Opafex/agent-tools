/**
 * Ambiguous targets: acting on one of several records the person's words fit.
 *
 * The grounded-arguments check confirms a value came from somewhere. It cannot
 * tell whether it was the right one. "Send Sam the revised schedule": a search
 * for "Sam" returns Sam Ellery and Sam Okoro, the agent picks one, and every
 * value in the call is grounded. The email still goes to a stranger half the
 * time. A person would ask which Sam; a small model rarely does, and a large
 * one not always.
 *
 * The rule: when a call's identifier was chosen from a tool result listing
 * several records, the person's own words must pick it out. If every word of
 * theirs that matches the chosen record also matches another record in that
 * list, the choice was a guess, and the call should become a question.
 *
 * Method (deterministic, no model call):
 *   1. For each identifier-shaped argument (see `identifierArguments`), find
 *      the earliest tool result (of another tool, not failed) holding a list
 *      of two or more records, one of which contains that value as a field.
 *   2. Take the person's words: every user turn, lower-cased, split on
 *      non-letters, short words and common English words dropped.
 *   3. Note which of those words occur in each record's own string values.
 *      If none occur in the chosen record, it was chosen by something other
 *      than its name ("the largest open deal") and the check does not apply.
 *   4. Otherwise the target is ambiguous when another record in the list
 *      matches every one of the words the chosen record matches. A record the
 *      call also targets is not an alternative, so "email both of them" passes.
 *
 * A later answer from the person ("Sam at Halden") is in the user turns, so
 * once they have said which, the same call passes.
 */

import { identifierArguments, type ArgumentCheckOptions, type ToolCall } from './arguments.js';
import { lower } from './text.js';
import { resultValue, userText, type TranscriptTurn } from './transcript.js';

export interface AmbiguityCheckOptions extends Pick<ArgumentCheckOptions, 'kinds' | 'idPattern' | 'ignorePaths'> {
  /** Words shorter than this are ignored. Default 3. */
  minWordLength?: number;
  /** Extra words to ignore, on top of a built-in list of common English words. */
  stopWords?: readonly string[];
  /** At most this many alternatives are reported. Default 5. */
  maxAlternatives?: number;
}

export interface AmbiguousTarget {
  /** The argument path and value the call chose. */
  path: string;
  value: string;
  /** The person's words that matched the chosen record. */
  matchedWords: string[];
  /** The tool whose result listed the candidates. */
  sourceTool?: string;
  /** Other records those words fit just as well, as they appeared in the result. */
  alternatives: Array<Record<string, unknown>>;
}

export interface AmbiguityCheckResult {
  /** `skipped` when no argument was chosen from a list of records. */
  status: 'clear' | 'ambiguous' | 'skipped';
  ambiguous: AmbiguousTarget[];
  /** A message to send back to the model so it asks; empty unless `ambiguous`. */
  message: string;
}

const STOP_WORDS = new Set(
  (
    'the and for with from that this these those have has had was were are not but you your yours our ours ' +
    'their they them his her him she its can could would should will shall may might must please thanks thank ' +
    'about into onto over under than then there here what which who whom whose when where why how all any ' +
    'each every some send email emails mail message tell ask call add update create make set get find show ' +
    'note notes new let know need want like just also only one two three today tomorrow yesterday week ' +
    'monday tuesday wednesday thursday friday saturday sunday morning afternoon evening'
  ).split(/\s+/),
);

function words(text: string, minLength: number, stop: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  for (const w of lower(text).split(/[^\p{L}\p{N}]+/u)) {
    if (w.length >= minLength && !stop.has(w) && !/^\d+$/.test(w)) out.add(w);
  }
  return out;
}

/** Every string value in a record (nested objects included, one level of arrays). */
function recordText(record: Record<string, unknown>, depth = 0): string {
  if (depth > 3) return '';
  const parts: string[] = [];
  for (const v of Object.values(record)) {
    if (typeof v === 'string') parts.push(v);
    else if (Array.isArray(v)) {
      for (const item of v) if (typeof item === 'string') parts.push(item);
    } else if (v && typeof v === 'object') parts.push(recordText(v as Record<string, unknown>, depth + 1));
  }
  return parts.join(' ');
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** Does any string field of the record (at any depth up to 3) equal `value`? */
function recordHolds(record: Record<string, unknown>, value: string, depth = 0): boolean {
  if (depth > 3) return false;
  for (const v of Object.values(record)) {
    if (typeof v === 'string' && lower(v.trim()) === value) return true;
    if (isRecord(v) && recordHolds(v, value, depth + 1)) return true;
  }
  return false;
}

/** The first list of 2+ records in `root` (depth-first) with one holding `value`. */
function findListHolding(root: unknown, value: string, depth = 0): { list: Array<Record<string, unknown>>; chosen: number } | null {
  if (depth > 6) return null;
  if (Array.isArray(root)) {
    const records = root.filter(isRecord);
    if (records.length >= 2) {
      const chosen = records.findIndex((r) => recordHolds(r, value));
      if (chosen >= 0) return { list: records, chosen };
    }
    for (const item of root) {
      const hit = findListHolding(item, value, depth + 1);
      if (hit) return hit;
    }
  } else if (isRecord(root)) {
    for (const v of Object.values(root)) {
      const hit = findListHolding(v, value, depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}

export function ambiguousTargetMessage(targets: readonly AmbiguousTarget[]): string {
  const t = targets[0];
  const n = t.alternatives.length + 1;
  return (
    `Not run: "${t.matchedWords.join(' ')}" fits ${n} records${t.sourceTool ? ` returned by ${t.sourceTool}` : ''}, ` +
    `and nothing the user said picks out ${t.value}. Ask the user which one they mean, naming the options, ` +
    'and act only once they have said.'
  );
}

/** Check one proposed tool call before it runs. Pure. */
export function checkAmbiguousTarget(
  input: { call: ToolCall; transcript: readonly TranscriptTurn[] },
  options: AmbiguityCheckOptions = {},
): AmbiguityCheckResult {
  const minLength = options.minWordLength ?? 3;
  const stop = new Set([...STOP_WORDS, ...(options.stopWords ?? []).map(lower)]);
  const maxAlternatives = options.maxAlternatives ?? 5;
  const values = identifierArguments(input.call?.args, options);
  const targeted = new Set(values.map((v) => lower(v.value)));
  const said = words(userText(input.transcript), minLength, stop);

  const ambiguous: AmbiguousTarget[] = [];
  let applied = false;
  for (const v of values) {
    const needle = lower(v.value);
    let hit: { list: Array<Record<string, unknown>>; chosen: number; tool?: string } | null = null;
    for (const turn of input.transcript ?? []) {
      if (turn?.role !== 'tool' || turn.ok === false || turn.tool === input.call.tool) continue;
      const found = findListHolding(resultValue(turn.content), needle);
      if (found) {
        hit = { ...found, tool: turn.tool };
        break;
      }
    }
    if (!hit) continue;
    const chosenWords = [...words(recordText(hit.list[hit.chosen]), minLength, stop)].filter((w) => said.has(w));
    if (chosenWords.length === 0) continue;
    applied = true;
    const alternatives = hit.list.filter((record, i) => {
      if (i === hit!.chosen) return false;
      // A record the call also targets is not an alternative to it.
      if ([...targeted].some((t) => recordHolds(record, t))) return false;
      const theirs = words(recordText(record), minLength, stop);
      return chosenWords.every((w) => theirs.has(w));
    });
    if (alternatives.length > 0) {
      ambiguous.push({
        path: v.path,
        value: v.value,
        matchedWords: chosenWords,
        ...(hit.tool ? { sourceTool: hit.tool } : {}),
        alternatives: alternatives.slice(0, maxAlternatives),
      });
    }
  }
  if (ambiguous.length > 0) return { status: 'ambiguous', ambiguous, message: ambiguousTargetMessage(ambiguous) };
  return { status: applied ? 'clear' : 'skipped', ambiguous: [], message: '' };
}

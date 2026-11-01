/**
 * Is this number a count?
 *
 * Both count readers (`checkQuantities` and the `count` kind of `checkFigures`) find a number
 * followed by a noun and hold it to the evidence. A live read of the first found that about half
 * of what it flagged was not a count at all: a money amount split at its decimal point ("$178.74"
 * read as 74), a receipt number, a step number ("step 1", "steps 5 through 9"), a rate
 * ("1 entry/day") and a cap ("up to 50 results"). Each of those is a true sentence that no count
 * in the evidence can back, so checking it can only produce a false failure.
 *
 * One predicate, asked by both readers, so they cannot disagree about what a count is. It returns
 * `null` for a real count, or the reason it is not one:
 *
 * - `glued`: part of money, a decimal, a code, a time or a range (`$178.74`, `#2468-1399`, `10:30`).
 * - `label`: a number used as a name, after a numbering word (`step 1`, `row 5`, `pages 3-4`,
 *   and the second number of `steps 5 through 9`).
 * - `rate`: the noun is per something (`1 entry/day`, `100 requests per minute`, `2 runs a day`).
 * - `bound`: a limit, not a claim about how many there are (`up to 50`, `at least 3`, `over 20`).
 *
 * Pure. It under-reports by design: a number it sets aside is never checked.
 */

export type NotACountReason = 'glued' | 'label' | 'rate' | 'bound';

const LABEL_WORDS =
  String.raw`(?:steps?|pages?|lines?|items?|rows?|phases?|stages?|rounds?|weeks?|days?|versions?|number|nos?\.|#)`;

/** A numbering word straight before the number: "step 1", "row 5", "no. 3". */
const LABEL_BEFORE_RE = new RegExp(String.raw`(?:^|[^\w])` + LABEL_WORDS + String.raw`\s*$`, 'i');

/** The second number of a labelled range: "steps 5 through 9", "pages 3-4", "lines 2 to 6". */
const LABEL_RANGE_RE = new RegExp(
  String.raw`(?:^|[^\w])` + LABEL_WORDS + String.raw`\s*\d+\s*(?:through|thru|to|until|and|-|–|—)\s*$`,
  'i',
);

const RATE_UNITS = String.raw`(?:second|minute|hour|day|night|week|month|quarter|year|run|call|request|batch|user|account|customer)`;

/** What follows the noun when it is a rate: "/day", "per minute", "a day", "each run", "daily". */
const RATE_AFTER_RE = new RegExp(
  String.raw`^\s*(?:\/\s*[A-Za-z]|per\s+[A-Za-z]|(?:a|an|each|every)\s+` + RATE_UNITS + String.raw`\b|(?:daily|weekly|hourly|monthly|nightly|yearly|annually)\b)`,
  'i',
);

/**
 * A limit phrase before the number, with at most two plain words between ("a maximum of 50",
 * "limited to about 50"). The words between may hold no digit, so a cap earlier in the sentence
 * cannot reach past a real count to the next number.
 */
const BOUND_BEFORE_RE =
  /\b(?:up\s+to|at\s+most|no\s+more\s+than|max(?:imum)?(?:\s+of)?|limit(?:ed)?\s+(?:of|to)|cap(?:ped)?\s+(?:of|at)|as\s+many\s+as|at\s+least|more\s+than|fewer\s+than|less\s+than|over)\s+(?:[A-Za-z][\w'-]*\s+){0,2}$/i;

/**
 * Why the number at `index` is not a count, or `null` when it is one. `length` is the length of
 * the whole claim (the number and its noun), so a rate can be read after the noun.
 */
export function notACount(text: string, index: number, length: number): NotACountReason | null {
  if (!text || index < 0 || index >= text.length) return null;
  const numberLength = /^[\w]+/.exec(text.slice(index))?.[0].length ?? 0;

  const before = text.charAt(index - 1);
  const after = text.slice(index + numberLength, index + numberLength + 2);
  if (/[£€$.,#/:\d-]/.test(before) || /^[.,:/-]\d/.test(after)) return 'glued';

  const lead = text.slice(Math.max(0, index - 60), index);
  if (LABEL_BEFORE_RE.test(lead) || LABEL_RANGE_RE.test(lead)) return 'label';

  if (RATE_AFTER_RE.test(text.slice(index + length, index + length + 30))) return 'rate';

  if (BOUND_BEFORE_RE.test(lead)) return 'bound';

  return null;
}

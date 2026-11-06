/**
 * Grounded rows: table rows that must not carry a firm nobody found.
 *
 * `checkGroundedItems` is for a list of things to act on, where every item names
 * something. A row is mostly the agent's own writing: its notes and its status are
 * meant to come from the agent. Only some of its columns name something found.
 *
 * The failure: an agent asked for thirty firms found about twenty, and padded the
 * table to the number it was asked for. Every row looked like the others.
 *
 * Method (deterministic, no model call):
 *   1. Read the rows the declaration names: an array of rows, one row (`single`),
 *      or an array of items each holding its row under `field`.
 *   2. In each row, keep every value that is wholly an email address (or a list of
 *      them), whatever its column is called, and every value in a column that
 *      names a firm or a person. A column may hold a list of such values.
 *   3. Compare each as what it is (see `found-values.ts`). An address must have
 *      been named whole, so one built from a pattern ("first.last@firm") is
 *      refused even when the firm's site was read.
 *
 * Other columns are not read, and neither is an address inside a sentence.
 *
 * Refuse the call when the result fails, and send `message` back to the model as
 * the tool result. Never repair the call by dropping the rows it carried.
 */

import type { ToolCall } from './arguments.js';
import {
  addressOf,
  argumentsOf,
  foundEvidence,
  groundedResult,
  nameCore,
  recipientsIn,
  valueFound,
  type GroundedOptions,
  type GroundedResult,
} from './found-values.js';
import type { UngroundedItem } from './grounded-items.js';
import type { TranscriptTurn } from './transcript.js';

export interface GroundedRowsDeclaration {
  /** The argument holding the rows. */
  param: string;
  /** The argument is one row (an object), not an array of them. */
  single?: boolean;
  /** Each array item holds its row under this key. */
  field?: string;
}

export type GroundedRowsOptions = GroundedOptions;

export type GroundedRowsResult = GroundedResult<UngroundedItem>;

/**
 * Columns that name something found: a firm or a person. Deliberately narrow: a
 * bare "name" column is not here, because a row the agent composes (a journal
 * entry, a plan) has a name nobody had to find.
 */
const FOUND_COLUMN_RE =
  /^(?:firm|firm_?name|company|company_?name|business|business_?name|organi[sz]ation|organi[sz]ation_?name|employer|agency|practice|contact|contact_?name|contact_?person|person|full_?name|recipient|recipient_?name)$/i;

function isFoundColumn(column: string): boolean {
  return FOUND_COLUMN_RE.test(column.replace(/[\s-]+/g, '_'));
}

function isRow(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** The rows `declaration` names, each with the path it was found at. */
function rowsOf(
  args: unknown,
  declaration: GroundedRowsDeclaration,
): Array<{ path: string; row: Record<string, unknown> }> {
  const { param, single, field } = declaration;
  const raw = argumentsOf(args)?.[param];
  if (single) return isRow(raw) ? [{ path: param, row: raw }] : [];
  if (!Array.isArray(raw)) return [];
  const rows: Array<{ path: string; row: Record<string, unknown> }> = [];
  raw.forEach((item, i) => {
    const row = field ? (isRow(item) ? item[field] : undefined) : item;
    if (isRow(row)) rows.push({ path: field ? `${param}[${i}].${field}` : `${param}[${i}]`, row });
  });
  return rows;
}

/** The addresses `value` consists of, or `null` when it is anything else. */
function wholeAddresses(value: string): string[] | null {
  const recipients = recipientsIn(value);
  const addresses = recipients.map(addressOf);
  if (addresses.length === 0 || addresses.includes(null)) return null;
  return addresses as string[];
}

export function ungroundedRowsMessage(items: readonly UngroundedItem[]): string {
  const list = items.map((i) => i.value).join(', ');
  return (
    `Refused: ${list} ${items.length === 1 ? 'appears' : 'appear'} in no message from the user and in no tool result. ` +
    'Nothing was run. A firm, person or email address written to a table must be one a search, a page or the user actually named; ' +
    'never pad a list to reach a number, and never construct an address from a pattern. ' +
    'Write only the rows you found, and tell the user how many that was.'
  );
}

/** Check the rows in one proposed tool call before it runs. Pure. */
export function checkGroundedRows(
  input: { call: ToolCall; transcript: readonly TranscriptTurn[]; declaration: GroundedRowsDeclaration },
  options: GroundedRowsOptions = {},
): GroundedRowsResult {
  const { call, transcript, declaration } = input;
  const rows = rowsOf(call?.args, declaration);
  const evidence = foundEvidence(transcript, call?.tool, options);
  const ungrounded: UngroundedItem[] = [];
  const reported = new Set<string>();
  let checked = 0;

  const judge = (path: string, value: string, found: boolean): void => {
    checked += 1;
    if (found || reported.has(value)) return;
    reported.add(value);
    ungrounded.push({ path, value });
  };

  const read = (path: string, column: string, raw: unknown): void => {
    if (typeof raw !== 'string' || !raw.trim()) return;
    const value = raw.trim();
    const addresses = wholeAddresses(value);
    if (addresses) {
      for (const address of addresses) judge(path, address, evidence.addresses.has(address));
    } else if (isFoundColumn(column) && nameCore(value)) {
      judge(path, value, valueFound(value, evidence));
    }
  };

  for (const { path, row } of rows) {
    for (const [column, raw] of Object.entries(row)) {
      if (Array.isArray(raw)) raw.forEach((v, i) => read(`${path}.${column}[${i}]`, column, v));
      else read(`${path}.${column}`, column, raw);
    }
  }
  return groundedResult(checked, ungrounded, ungroundedRowsMessage);
}

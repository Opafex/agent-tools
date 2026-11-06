/**
 * Grounded addresses: an email recipient must have been named whole.
 *
 * An address is the one value that reaches a stranger when it is wrong, and it is
 * the value a model finds easiest to build: it reads `jane.ellery@firm.com` on a
 * page and writes `sam.ellery@firm.com` for the colleague it read about.
 *
 * `checkToolArguments` already finds an address that is the whole of an argument.
 * This check is for the arguments a tool declares as recipients, which a person
 * writes in more ways than that: `Jo <jo@firm.com>`, or several addresses in one
 * string. And it fails closed. In a declared argument, a value that cannot be read
 * as an address is refused, never passed unread: `jo@firm.com sam@firm.com` is one
 * string that would otherwise have no address-shaped value in it to check.
 *
 * Method (deterministic, no model call):
 *   1. Read each declared argument: a string or an array of strings, split into
 *      recipients (see `recipientsIn`).
 *   2. Reduce each to one address. A trailing full stop is dropped, because it
 *      leaves the same mailbox, so it cannot be used to skip the check.
 *   3. Compare it, whole, with every address in the evidence. Words and domains
 *      ground nothing here: `smith@acme.co.uk` is not `john-smith@acme.co.uk`, and
 *      `jo@acme.com` is not `jo@acme.com.au`.
 *
 * Refuse the call when the result fails, and send `message` back to the model as
 * the tool result. Never repair the call by dropping a recipient.
 */

import type { ToolCall } from './arguments.js';
import { serialiseEvidence } from './evidence.js';
import {
  addressOf,
  argumentsOf,
  foundEvidence,
  groundedResult,
  recipientsIn,
  type GroundedOptions,
  type GroundedResult,
} from './found-values.js';
import type { TranscriptTurn } from './transcript.js';

export interface GroundedAddressesDeclaration {
  /** The arguments holding recipients, e.g. `['to', 'cc', 'bcc']`. */
  params: readonly string[];
}

export type GroundedAddressesOptions = GroundedOptions;

export interface UngroundedAddress {
  /** Which recipient it was, e.g. `to[1]`. */
  path: string;
  /** The address, lower-cased, or the value as written when it is not an address. */
  value: string;
  /** `not_named` when nothing named it, `not_an_address` when it could not be read as one. */
  reason: 'not_named' | 'not_an_address';
}

export type GroundedAddressesResult = GroundedResult<UngroundedAddress>;

export function ungroundedAddressesMessage(items: readonly UngroundedAddress[]): string {
  const invented = items.filter((i) => i.reason === 'not_named').map((i) => i.value);
  const unread = items.filter((i) => i.reason === 'not_an_address').map((i) => i.value);
  const one = invented.length === 1;
  const sentences: string[] = [];
  if (invented.length > 0) {
    sentences.push(
      `${invented.join(', ')} ${one ? 'appears' : 'appear'} in no message from the user and in no tool result, ` +
        `so ${one ? 'it was' : 'they were'} constructed, not found.`,
    );
  }
  if (unread.length > 0) sentences.push(`${unread.join(', ')} ${unread.length === 1 ? 'is' : 'are'} not an email address.`);
  return (
    `Refused: ${sentences.join(' ')} Nothing was run. ` +
    'Use an address a page, a tool or the user actually gave; if only a generic one (info@) was published, use that; ' +
    'if none was, say so and do not write to this one.'
  );
}

/** Check the recipients in one proposed tool call before it runs. Pure. */
export function checkGroundedAddresses(
  input: { call: ToolCall; transcript: readonly TranscriptTurn[]; declaration: GroundedAddressesDeclaration },
  options: GroundedAddressesOptions = {},
): GroundedAddressesResult {
  const { call, transcript, declaration } = input;
  const args = argumentsOf(call?.args);
  const evidence = foundEvidence(transcript, call?.tool, options);
  const ungrounded: UngroundedAddress[] = [];
  const reported = new Set<string>();
  let checked = 0;
  for (const param of declaration.params) {
    const raw = args?.[param];
    let index = 0;
    for (const written of Array.isArray(raw) ? raw : [raw]) {
      if (written === null || written === undefined) continue;
      const recipients = typeof written === 'string' ? recipientsIn(written) : [serialiseEvidence(written) ?? ''];
      for (const recipient of recipients) {
        const path = `${param}[${index}]`;
        index += 1;
        checked += 1;
        const address = addressOf(recipient);
        if (address && evidence.addresses.has(address)) continue;
        const value = address ?? recipient;
        if (reported.has(value)) continue;
        reported.add(value);
        ungrounded.push({ path, value, reason: address ? 'not_named' : 'not_an_address' });
      }
    }
  }
  return groundedResult(checked, ungrounded, ungroundedAddressesMessage);
}

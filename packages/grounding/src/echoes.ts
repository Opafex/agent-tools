/**
 * Echoes: a tool result repeating the arguments it was called with.
 *
 * The failure: the agent invents a value, passes it to a tool, and the tool's
 * result repeats it ("checked `acme-widgets.co.uk`: no match"). The value is now
 * in a tool result, so a presence check reads it as evidence, and the invention
 * has backed itself. A lookup tool, a validator and a "did we contact this firm?"
 * check all echo their input this way.
 *
 * The rule: an identifier counts as evidence only if a tool returned it without
 * having been given it in that same call. `stripEchoedIdentifiers` applies it to
 * one call: it masks, in the result, every identifier-shaped token that came
 * from the call's own arguments. Pass the masked text as that call's evidence.
 *
 * A token is masked only where it stands alone (between quotes, spaces or
 * brackets), so a longer value the tool really returned is kept: a search for
 * `acme.com` that returns `https://www.acme.com/pricing` still backs that URL,
 * and a mailbox read for `acme.com` that returns `jo@acme.com` still backs the
 * address. The same token returned by ANOTHER call is unaffected, so a value the
 * agent read earlier and then passed on stays backed by the call that read it.
 */

import { serialiseEvidence } from './evidence.js';
import { extractIdentifierTokens } from './identifiers.js';
import { lower } from './text.js';

/** Replaces an echoed token. Not identifier-shaped, so it backs nothing. */
export const ECHO_MASK = '[echo]';

/** Characters that continue a token on the left: it is part of a longer value. */
const CONTINUES_LEFT = /[A-Za-z0-9._@/-]/;
/** Characters that continue a token on the right. */
const CONTINUES_RIGHT = /[A-Za-z0-9_/-]/;

function hostOf(url: string): string | null {
  try {
    return lower(new URL(url).hostname) || null;
  } catch {
    return null;
  }
}

/**
 * One tool call's result with the identifiers it echoed from its own arguments
 * masked, as text ready to use as evidence; `null` when the result cannot be
 * serialised. Bare domains in the arguments are masked too, whether or not
 * your identifier check extracts them.
 */
export function stripEchoedIdentifiers(result: unknown, args: unknown): string | null {
  const text = serialiseEvidence(result);
  if (text === null) return null;
  const argText = serialiseEvidence(args);
  if (!argText) return text;

  // Longest first, so a URL is masked whole before the domain inside it is
  // considered on its own.
  const found = new Set<string>();
  for (const t of extractIdentifierTokens(argText, { domains: true })) {
    const token = lower(t.token);
    found.add(token);
    // A URL argument is also echoed as its bare host ("https://www.acme.com/a"
    // comes back as "acme.com"), and a bare domain with a path as its host.
    const host = t.kind === 'url' ? hostOf(token) : t.kind === 'domain' ? token.split('/')[0] : null;
    if (host) {
      found.add(host);
      if (host.startsWith('www.')) found.add(host.slice(4));
    }
  }
  const tokens = [...found].sort((a, b) => b.length - a.length);
  if (tokens.length === 0) return text;

  let out = text;
  for (const token of tokens) {
    let haystack = lower(out);
    let from = 0;
    for (;;) {
      const at = haystack.indexOf(token, from);
      if (at < 0) break;
      const end = at + token.length;
      const before = at > 0 ? out[at - 1] : '';
      const after = end < out.length ? out[end] : '';
      // A full stop followed by more of a name continues it ("acme.co.uk.evil.com").
      const dotContinues = after === '.' && end + 1 < out.length && /[A-Za-z0-9]/.test(out[end + 1]);
      if ((before && CONTINUES_LEFT.test(before)) || (after && CONTINUES_RIGHT.test(after)) || dotContinues) {
        from = end;
        continue;
      }
      out = out.slice(0, at) + ECHO_MASK + out.slice(end);
      haystack = lower(out);
      from = at + ECHO_MASK.length;
    }
  }
  return out;
}

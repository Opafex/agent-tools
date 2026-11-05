/**
 * Web domains: the domain a name is registered under.
 *
 * A fixed list of two-part suffixes, not the public suffix list: this package has
 * no dependencies, and the check it serves only needs `mail.acme.co.uk` and
 * `acme.co.uk` to come out the same. A suffix not listed here falls back to two
 * labels, so `x.acme.co.jp` reads as `co.jp`.
 */

import { lower } from './text.js';

/** Second-level suffixes under which the registrable label is the THIRD from the end. */
const TWO_PART_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'ltd.uk', 'plc.uk', 'me.uk', 'net.uk',
  'com.au', 'net.au', 'org.au', 'co.nz', 'co.za', 'co.in', 'com.sg', 'co.ie', 'com.hk',
]);

/** The domain a firm registered: `acme.co.uk` for `mail.acme.co.uk`. */
export function registrableDomain(domain: string): string {
  const parts = lower(domain).split('.');
  const take = parts.length >= 3 && TWO_PART_SUFFIXES.has(parts.slice(-2).join('.')) ? 3 : 2;
  return parts.slice(-take).join('.');
}

/** The host of a URL, a bare domain (with or without a path) or an email address, or `null`. */
export function hostOf(urlOrDomain: string): string | null {
  const raw = urlOrDomain.trim();
  if (!raw) return null;
  try {
    const hostname = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`).hostname;
    // A trailing full stop is legal in a host, and would leave `acme.com.` reading as `com.`.
    return lower(hostname).replace(/\.+$/, '').replace(/^www\d*\./, '') || null;
  } catch {
    return null;
  }
}

/**
 * Redaction engine tests.
 *
 * The governing property is FAIL-CLOSED on personal data and FAIL-OPEN on
 * diagnostics: no real PII may survive, and nothing needed to debug may be lost.
 * The final "no PII survives" sweep is the one that matters most: it
 * asserts absence rather than a specific replacement, so it still fails if
 * someone adds a pattern that matches but replaces with the wrong thing.
 */

import { describe, it, expect } from 'vitest';
import { redactText, redactTextWithCounts, scrubValue, redactError, REDACTED } from '../src/index.js';

describe('redactText — UK personal data', () => {
  it('tokenises an email', () => {
    expect(redactText('contact sarah.kowalski@example.com now')).toBe(
      'contact [EMAIL_1] now',
    );
  });

  it('tokenises a UK National Insurance number', () => {
    // The single most important pattern the old US-shaped implementations missed.
    expect(redactText('NI: QQ 12 34 56 C')).toContain('[NI_NUMBER_1]');
    expect(redactText('NI: QQ123456C')).toContain('[NI_NUMBER_1]');
  });

  it('tokenises a UK postcode', () => {
    expect(redactText('lives at SE1 0AA')).toContain('[POSTCODE_1]');
    expect(redactText('lives at EC1R 5HL')).toContain('[POSTCODE_1]');
  });

  it('tokenises a UK sort code before the phone pattern can claim it', () => {
    expect(redactText('sort 12-34-56')).toContain('[BANK_1]');
  });

  it('tokenises an IBAN', () => {
    expect(redactText('GB29NWBK60161331926819')).toContain('[BANK_1]');
  });

  it('tokenises a UK phone number', () => {
    expect(redactText('call 07700 900123')).toContain('[PHONE_1]');
    expect(redactText('call +44 7700 900123')).toContain('[PHONE_1]');
  });

  it('tokenises a payment card', () => {
    expect(redactText('card 4111 1111 1111 1111')).toContain('[CARD_1]');
  });

  it('tokenises a mailto: URL', () => {
    expect(redactText('see mailto:a@b.com')).toContain('[URL_1]');
  });

  it('tokenises an IP address', () => {
    expect(redactText('from 192.168.1.44')).toContain('[IP_1]');
  });
});

describe('redactText — token stability', () => {
  it('gives the SAME value the SAME token within one pass', () => {
    const out = redactText('a@x.com failed, retried a@x.com');
    expect(out).toBe('[EMAIL_1] failed, retried [EMAIL_1]');
  });

  it('gives DIFFERENT values different tokens', () => {
    const out = redactText('a@x.com and b@y.com');
    expect(out).toBe('[EMAIL_1] and [EMAIL_2]');
  });

  it('does NOT carry tokens across passes — they must not become pseudonyms', () => {
    // A stable cross-log identifier would still be personal data under GDPR.
    expect(redactText('b@y.com')).toBe('[EMAIL_1]');
    expect(redactText('b@y.com')).toBe('[EMAIL_1]');
  });

  it('reports what it replaced', () => {
    const { counts } = redactTextWithCounts('a@x.com b@y.com 07700 900123');
    expect(counts.byKind.EMAIL).toBe(2);
    expect(counts.byKind.PHONE).toBe(1);
    expect(counts.total).toBe(3);
  });
});

describe('redactText — diagnostics must survive', () => {
  it('preserves UUIDs (correlation handles, not personal data)', () => {
    const id = '3f7a1c２b-0000-4000-8000-000000000000'.replace('２', '2');
    expect(redactText(`request ${id} failed`)).toContain(id);
  });

  it('preserves an all-numeric UUID the CARD pattern would otherwise eat', () => {
    const id = '12345678-1234-4123-8123-123456789012';
    expect(redactText(`trace ${id}`)).toContain(id);
  });

  it('preserves file paths, error types and status codes', () => {
    const line = 'TypeError in src/worker/job-runner.ts:893 → HTTP 503';
    expect(redactText(line)).toBe(line);
  });

  it('preserves column names while redacting their values', () => {
    const out = redactText('unique constraint failed on candidates.email = a@x.com');
    expect(out).toContain('candidates.email');
    expect(out).toContain('[EMAIL_1]');
    expect(out).not.toContain('a@x.com');
  });

  it('preserves timestamps', () => {
    const line = 'at 2025-03-12T20:19:44.000Z';
    expect(redactText(line)).toBe(line);
  });
});

describe('credentials are killed, never tokenised', () => {
  it.each([
    'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA',
    'gsk_AAAAAAAAAAAAAAAAAAAA',
    'ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27u',
  ])('kills %s', (secret) => {
    const out = redactText(`token=${secret}`);
    expect(out).toContain(REDACTED);
    expect(out).not.toContain(secret);
  });

  it('does not tokenise a secret (a stable token would still correlate it)', () => {
    const out = redactText('sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA');
    expect(out).not.toMatch(/\[\w+_\d+\]/);
  });
});

describe('scrubValue — deep objects', () => {
  it('kills credential-NAMED keys whatever the value looks like', () => {
    // A random vault key matches no pattern; only the key name betrays it.
    const out = scrubValue({ password: 'hunter2', apiKey: 'x9f3', vault_secret: 'zz' });
    expect(out).toEqual({ password: REDACTED, apiKey: REDACTED, vault_secret: REDACTED });
  });

  it('redacts PII in nested string values', () => {
    const out = scrubValue({ user: { email: 'a@x.com', note: 'call 07700 900123' } });
    expect(out.user.email).toBe('[EMAIL_1]');
    expect(out.user.note).toContain('[PHONE_1]');
  });

  it('preserves keys and non-PII scalars', () => {
    const out = scrubValue({ status: 503, ok: false, table: 'candidates' });
    expect(out).toEqual({ status: 503, ok: false, table: 'candidates' });
  });

  it('does not mutate its input', () => {
    const input = { email: 'a@x.com' };
    scrubValue(input);
    expect(input.email).toBe('a@x.com');
  });

  it('bounds runaway arrays and depth', () => {
    const big = scrubValue(Array.from({ length: 500 }, (_, i) => i)) as unknown[];
    expect(big.length).toBe(201);
    expect(big[200]).toBe('[+300 more]');
  });

  it('survives null and undefined', () => {
    expect(scrubValue(null)).toBeNull();
    expect(scrubValue(undefined)).toBeUndefined();
  });
});

describe('redactError', () => {
  it('preserves name and stack frames but redacts the message', () => {
    const err = new Error('failed for sarah@example.com');
    const out = redactError(err);
    expect(out.name).toBe('Error');
    expect(out.message).toBe('failed for [EMAIL_1]');
    expect(out.stack).toBeDefined();
    expect(out.stack).not.toContain('sarah@example.com');
    // The frames are the diagnosis — they must survive.
    expect(out.stack).toContain('redact.test.ts');
  });
});

describe('NO PII SURVIVES', () => {
  // Asserts ABSENCE, so it fails even if a pattern matches but replaces wrongly.
  const SYNTHETIC_PII = [
    'sarah.kowalski@example.test',
    '07700 900123',
    '+44 7700 900456',
    'QQ123456C',
    'SE1 0AA',
    '4111 1111 1111 1111',
    '12-34-56',
    'GB29NWBK60161331926819',
    '192.168.1.44',
    'mailto:s.kowalski@example.test',
  ];

  it.each(SYNTHETIC_PII)('removes %s from a log line', (pii) => {
    const line = `[JobRunner] step 3 failed for value ${pii} after 2 retries`;
    const out = redactText(line);
    expect(out).not.toContain(pii);
    expect(out).toContain('[JobRunner] step 3 failed');
  });

  it('removes every item at once from one dense line', () => {
    const line = SYNTHETIC_PII.join(' | ');
    const out = redactText(line);
    for (const pii of SYNTHETIC_PII) expect(out).not.toContain(pii);
  });

  it('removes PII nested anywhere in a realistic tool payload', () => {
    const payload = {
      tool: 'create_candidate',
      params: {
        name: 'Sarah Kowalski',
        email: 'sarah.kowalski@example.test',
        phone: '07700 900123',
        address: { postcode: 'SE1 0AA' },
        authorization: 'Bearer sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA',
      },
      durationMs: 1234,
    };
    const json = JSON.stringify(scrubValue(payload));
    for (const pii of ['sarah.kowalski@example.test', '07700 900123', 'SE1 0AA']) {
      expect(json).not.toContain(pii);
    }
    expect(json).not.toContain('sk-ant-api03');
    // Diagnostics intact.
    expect(json).toContain('create_candidate');
    expect(json).toContain('1234');
  });
});

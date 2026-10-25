/**
 * Field classifier tests: redaction by LOCATION, sector profiles, and the
 * schema check.
 *
 * The invariant that matters most is that a sector profile can only ADD
 * sensitivity. A profile is typically a per-customer setting; if it could
 * switch redaction OFF it would be a per-customer route to a breach.
 */

import { describe, it, expect } from 'vitest';
import {
  createFieldClassifier,
  getVerticalProfile,
  VERTICALS,
  type FieldRegistry,
  type SchemaField,
  type Vertical,
} from '../src/index.js';

/** An example application schema, as a user of the package would describe it. */
const REGISTRY: FieldRegistry = {
  personModels: ['users', 'candidates', 'operatives'],
  explicit: {
    'candidates.resume_text': 'free_text',
    'candidates.notes': 'free_text',
    'messages.body': 'free_text',
    'form_submissions.data': 'free_text',
  },
  notPii: {
    'users.email_verified': 'Boolean verification state. Carries no address.',
    'campaigns.emails_sent': 'Integer send count for the campaign, not an address.',
  },
};

const base = createFieldClassifier(REGISTRY);
const forVertical = (vertical: Vertical) => createFieldClassifier({ ...REGISTRY, vertical });

describe('always-personal column shapes, on any table', () => {
  it.each([
    ['users', 'email', 'email'],
    ['support_tickets', 'customer_email', 'email'],
    ['operatives', 'phone', 'phone'],
    ['user_mfa', 'sms_phone', 'phone'],
    ['invoices', 'billing_address', 'address'],
    ['bank_accounts', 'iban', 'financial'],
    ['candidates', 'expected_salary', 'financial'],
    ['access_logs', 'ip_address', 'ip'],
    ['people', 'date_of_birth', 'national_id'],
  ])('%s.%s -> %s', (model, field, kind) => {
    expect(base.classify(model, field)).toBe(kind);
  });

  it('classifies ip_address as an IP, not a postal address', () => {
    expect(base.classify('sessions', 'ip_address')).toBe('ip');
  });

  it('works with no registry at all', () => {
    const bare = createFieldClassifier();
    expect(bare.classify('anything', 'email')).toBe('email');
    expect(bare.classify('anything', 'name')).toBeNull();
  });
});

describe('the `name` polarity decision', () => {
  it('treats name as a person name only on personModels tables', () => {
    expect(base.classify('users', 'name')).toBe('person_name');
    expect(base.classify('candidates', 'first_name')).toBe('person_name');
    expect(base.classify('operatives', 'surname')).toBe('person_name');
  });

  it('does NOT treat name as personal on other tables', () => {
    // Redacting these would strip most of the diagnostic value from a log, and a
    // redactor that makes logs useless gets switched off.
    for (const model of ['products', 'workflows', 'teams', 'roles']) {
      expect(base.classify(model, 'name')).toBeNull();
    }
  });
});

describe('explicit and excused columns', () => {
  it('classifies listed free-text columns whatever they are called', () => {
    expect(base.classify('candidates', 'resume_text')).toBe('free_text');
    expect(base.classify('messages', 'body')).toBe('free_text');
    expect(base.classify('form_submissions', 'data')).toBe('free_text');
  });

  it('leaves ordinary operational columns alone', () => {
    expect(base.classify('jobs', 'status')).toBeNull();
    expect(base.classify('jobs', 'created_at')).toBeNull();
  });

  it('honours a written exclusion', () => {
    expect(base.classify('users', 'email_verified')).toBeNull();
    expect(base.classify('campaigns', 'emails_sent')).toBeNull();
  });

  it('is case-insensitive on table, column and registry keys', () => {
    expect(base.classify('USERS', 'EMAIL')).toBe('email');
    const mixed = createFieldClassifier({ explicit: { 'Notes.Body': 'free_text' } });
    expect(mixed.classify('notes', 'body')).toBe('free_text');
  });
});

describe('redactRow: redaction by LOCATION', () => {
  it('replaces personal columns and keeps operational ones', () => {
    const out = base.redactRow('candidates', {
      id: 'c1',
      first_name: 'Sarah',
      email: 'sarah@example.com',
      resume_text: 'a whole CV',
      status: 'active',
      created_at: '2025-03-13',
    });
    expect(out.first_name).toBe('[PERSON_NAME]');
    expect(out.email).toBe('[EMAIL]');
    expect(out.resume_text).toBe('[FREE_TEXT]');
    expect(out.id).toBe('c1');
    expect(out.status).toBe('active');
    expect(out.created_at).toBe('2025-03-13');
  });

  it('redacts by location even when the value looks harmless', () => {
    // The reason this exists beside shape-matching: a CV containing no email and
    // no phone number is still a CV.
    expect(base.redactRow('candidates', { resume_text: 'seeking new opportunities' }).resume_text).toBe(
      '[FREE_TEXT]',
    );
  });

  it('preserves column names and does not mutate the input', () => {
    const row = { email: 'a@x.com' };
    const out = base.redactRow('users', row);
    expect(Object.keys(out)).toEqual(['email']);
    expect(row.email).toBe('a@x.com');
  });
});

describe('findStaleEntries: the schema check', () => {
  const SCHEMA: SchemaField[] = [
    { model: 'users', field: 'email' },
    { model: 'users', field: 'email_verified' },
    { model: 'candidates', field: 'resume_text' },
    { model: 'candidates', field: 'notes' },
    { model: 'operatives', field: 'name' },
    { model: 'messages', field: 'body' },
    { model: 'form_submissions', field: 'data' },
    { model: 'campaigns', field: 'emails_sent' },
  ];

  it('is clean when every entry exists', () => {
    expect(base.findStaleEntries(SCHEMA)).toEqual([]);
  });

  it('reports a renamed column, a dropped table and a stale exclusion', () => {
    const renamed = SCHEMA.filter((f) => !(f.model === 'messages' && f.field === 'body')).concat({
      model: 'messages',
      field: 'content',
    });
    const dropped = renamed.filter((f) => f.model !== 'operatives' && f.model !== 'campaigns');
    expect(base.findStaleEntries(dropped).sort()).toEqual([
      'explicit: messages.body',
      'notPii: campaigns.emails_sent',
      'personModels: operatives',
    ]);
  });
});

describe('sector profiles can only ADD sensitivity, never subtract', () => {
  const BASE_PERSONAL: Array<[string, string]> = [
    ['users', 'email'],
    ['operatives', 'phone'],
    ['candidates', 'resume_text'],
    ['access_logs', 'ip_address'],
    ['bank_accounts', 'iban'],
  ];

  it.each(VERTICALS)('%s never un-marks base personal data', (vertical) => {
    const c = forVertical(vertical);
    for (const [model, field] of BASE_PERSONAL) {
      expect(c.classify(model, field), `${vertical} must not weaken ${model}.${field}`).not.toBeNull();
    }
  });

  it('keeps the exact base classification rather than overriding it', () => {
    expect(forVertical('financial').classify('users', 'email')).toBe(base.classify('users', 'email'));
  });

  it('may still mark a column the base rules excused', () => {
    const c = createFieldClassifier({
      vertical: 'recruitment',
      notPii: { 'candidates.current_employer': 'excused for the base rules only' },
    });
    expect(c.classify('candidates', 'current_employer')).toBe('free_text');
  });
});

describe('general: base rules only', () => {
  it('adds nothing', () => {
    expect(forVertical('general').classify('candidates', 'employer')).toBeNull();
    expect(forVertical('general').classify('candidates', 'email')).toBe('email');
  });
});

describe('recruitment', () => {
  const c = forVertical('recruitment');

  it('treats employment history as identifying in combination', () => {
    // Employer + dates + title fingerprints a person with no direct identifier,
    // which is exactly what a "redact names only" approach misses.
    for (const field of ['employer', 'work_history', 'employment_dates', 'job_title']) {
      expect(c.classify('candidates', field)).toBe('free_text');
    }
  });

  it('treats right-to-work and visa status as national-ID grade', () => {
    expect(c.classify('candidates', 'right_to_work_status')).toBe('national_id');
    expect(c.classify('candidates', 'visa_type')).toBe('national_id');
  });

  it('leaves operational columns alone', () => {
    expect(c.classify('jobs', 'status')).toBeNull();
  });
});

describe('salon', () => {
  const c = forVertical('salon');

  it('treats appointment notes as personal: they drift into health data', () => {
    for (const field of ['appointment_notes', 'client_notes', 'allergies', 'patch_test_date']) {
      expect(c.classify('appointments', field)).toBe('free_text');
    }
  });

  it('does NOT redact treatment or product names', () => {
    expect(c.classify('services', 'treatment_type')).toBeNull();
    expect(c.classify('inventory_items', 'brand')).toBeNull();
  });
});

describe('facilities', () => {
  const c = forVertical('facilities');

  it('covers emergency contacts and next of kin', () => {
    expect(c.classify('operatives', 'emergency_contact_number')).toBe('phone');
    expect(c.classify('operatives', 'next_of_kin')).toBe('person_name');
  });

  it('treats DBS checks as national-ID grade', () => {
    expect(c.classify('operatives', 'dbs_number')).toBe('national_id');
  });

  it('does NOT redact chemical logs or checklist items', () => {
    expect(c.classify('site_logs', 'chemical_used')).toBeNull();
    expect(c.classify('site_logs', 'checklist_item')).toBeNull();
  });
});

describe('financial: maximal mode', () => {
  const c = forVertical('financial');
  const ROW = {
    id: 'x1',
    client_id: 'c9',
    email: 'a@x.com',
    scheme_name: 'Balanced Growth',
    units_held: '1200',
    status: 'active',
    created_at: '2025-03-13',
  };

  it('redacts non-personal columns when the row describes a person', () => {
    // The combination is the disclosure: that a named client holds this product
    // is the sensitive fact, even though the scheme name alone is public.
    const out = c.redactRow('client_holdings', ROW);
    expect(out.email).toBe('[EMAIL]');
    expect(out.scheme_name).toBe('[FREE_TEXT]');
    expect(out.units_held).toBe('[FREE_TEXT]');
  });

  it('keeps identifiers and timestamps readable: a fully redacted row is inert', () => {
    const out = c.redactRow('client_holdings', ROW);
    expect(out.id).toBe('x1');
    expect(out.client_id).toBe('c9');
    expect(out.status).toBe('active');
    expect(out.created_at).toBe('2025-03-13');
  });

  it('does NOT apply maximal to rows with no personal data at all', () => {
    const out = c.redactRow('jobs', { id: 't1', title: 'Rebalance quarterly', status: 'done' });
    expect(out.title).toBe('Rebalance quarterly');
  });

  it('degrades safely when sibling columns are unknown', () => {
    // Without the row shape, maximal cannot tell whether the table is personal,
    // so it falls back rather than guessing in either direction.
    expect(c.classify('client_holdings', 'scheme_name')).toBeNull();
  });
});

describe('profile registry hygiene', () => {
  it('every vertical has a description usable in a DPA schedule', () => {
    for (const v of VERTICALS) {
      expect(getVerticalProfile(v).description.length, `${v} needs a real description`).toBeGreaterThan(20);
    }
  });

  it('falls back to general for an unknown vertical', () => {
    expect(getVerticalProfile('nope' as Vertical).vertical).toBe('general');
  });
});

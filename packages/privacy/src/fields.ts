/**
 * Redaction by LOCATION: which database columns hold personal data.
 *
 * The pattern engine (`redact.ts`) finds personal data by SHAPE: this looks like
 * an email. This module finds it by LOCATION: this column holds one, whatever it
 * contains. Both are needed. Shape-matching misses a free-text CV that happens
 * to contain no email; location-matching misses an address pasted into a
 * `notes` column.
 *
 * ---------------------------------------------------------------------------
 * THE `name` PROBLEM: read before adding rules
 * ---------------------------------------------------------------------------
 * Most tables with a `name` column are not about people: `products.name`,
 * `workflows.name`, `teams.name`. Treating `name` as personal data everywhere
 * would redact most of the diagnostic value in a log, and a redactor that makes
 * logs useless gets switched off, which is the failure that matters most.
 *
 * So the polarity is deliberately SPLIT:
 *   - `email`, `phone`, `postcode`, `dob`, NI/passport, bank fields
 *       -> personal data BY DEFAULT, on every table. Being wrong here is cheap
 *          (a redacted `support_email`); being wrong the other way is a breach.
 *   - `name`-shaped columns
 *       -> personal data only on tables you list in `personModels`.
 *
 * ---------------------------------------------------------------------------
 * SECTOR PROFILES ONLY ADD, NEVER SUBTRACT
 * ---------------------------------------------------------------------------
 * Sensitivity is not uniform across sectors: a treatment type is unremarkable
 * in a salon and special-category health data in a clinic. A `vertical` layers
 * that judgement on top of the base rules, but it can only mark MORE columns as
 * personal. A per-customer setting that could switch redaction off would be a
 * per-customer way to cause a breach.
 */

export type PiiFieldKind =
  | 'email'
  | 'phone'
  | 'person_name'
  | 'address'
  | 'postcode'
  | 'national_id'
  | 'financial'
  | 'free_text'
  | 'ip';

/** `table.column`, lower-cased. */
export type FieldKey = string;

export type Vertical = 'general' | 'recruitment' | 'salon' | 'facilities' | 'financial';

export interface VerticalProfile {
  vertical: Vertical;
  /** One line, suitable for a settings screen or a DPA schedule. */
  description: string;
  /**
   * Column-NAME fragments this vertical treats as personal wherever they appear.
   * Substring match on the lower-cased column name: deliberately blunt, because
   * these are judgement calls rather than shapes.
   */
  additionalFieldNames?: Array<{ contains: string; kind: PiiFieldKind }>;
  /**
   * MAXIMAL mode: every column on a table that carries ANY personal data is
   * treated as personal. For sectors where the combination is the disclosure:
   * that a named client holds a particular product is the sensitive fact, even
   * though "product" alone is not.
   */
  maximal?: boolean;
}

export interface FieldRegistry {
  /**
   * Tables whose rows describe a natural person. Only on these does a
   * `name`-shaped column (`name`, `first_name`, `surname`...) count as a
   * person's name.
   */
  personModels?: Iterable<string>;
  /**
   * Columns whose NAME gives nothing away but whose CONTENTS are personal data:
   * free-text notes, message bodies, CV text. This is the list that earns its
   * keep, because no rule will ever infer it. Keys are `table.column`.
   */
  explicit?: Record<FieldKey, PiiFieldKind>;
  /**
   * Columns that match a rule but are NOT personal data, each with a written
   * reason (`users.email_verified`: a boolean, not an address). Every entry is a
   * hole in the guard, and an unexplained hole becomes permanent.
   */
  notPii?: Record<FieldKey, string>;
  /** A sector profile layered on top. Defaults to `general` (adds nothing). */
  vertical?: Vertical;
}

export interface SchemaField {
  model: string;
  field: string;
}

export interface FieldClassifier {
  /**
   * Classify a column; `null` when it is not personal data. Pass the table's
   * other column names as `siblingFields` to let a `maximal` vertical decide
   * whether the row describes a person.
   */
  classify(model: string, field: string, siblingFields?: string[]): PiiFieldKind | null;
  isPii(model: string, field: string): boolean;
  /**
   * Replace every personal column's value with `[KIND]`. Column NAMES are always
   * kept: knowing which column was involved is the diagnostic, its contents are
   * not. Never mutates the input.
   */
  redactRow<T extends Record<string, unknown>>(model: string, row: T): Record<string, unknown>;
  /**
   * Registry entries that name a table or column your schema no longer has.
   * Run it over your schema in a test: a stale entry makes the registry look
   * more thorough than it is, and usually means a column was renamed and its
   * new name is now unclassified.
   */
  findStaleEntries(fields: SchemaField[]): string[];
}

/**
 * Column-name rules applied to EVERY table. First match wins, so the specific
 * comes before the general.
 */
const FIELD_NAME_RULES: Array<{ re: RegExp; kind: PiiFieldKind }> = [
  // `ip_address` MUST precede the postal-address rule: `_address$` matches both.
  { re: /(^|_)(ip_address|remote_addr)$/, kind: 'ip' },
  { re: /^(.*_)?(email|email_address)$/, kind: 'email' },
  { re: /(^|_)(phone|mobile|telephone|sms_phone|contact_phone)$/, kind: 'phone' },
  { re: /(^|_)(post_?code|zip_?code)$/, kind: 'postcode' },
  { re: /(^|_)(address|billing_address|street|address_line\d?)$/, kind: 'address' },
  { re: /(^|_)(dob|date_of_birth|birth_date)$/, kind: 'national_id' },
  { re: /(^|_)(national_insurance|ni_number|ssn|passport|nino)$/, kind: 'national_id' },
  { re: /(^|_)(iban|sort_code|account_number|card_number|bank_account)/, kind: 'financial' },
  { re: /(^|_)(salary|expected_salary|day_rate|compensation)$/, kind: 'financial' },
];

/** Person-name column shapes: only meaningful on a `personModels` table. */
const PERSON_NAME_RE =
  /^(name|full_name|first_name|last_name|surname|forename|display_name|contact_name|emergency_contact)$/;

/** Identifiers and timestamps stay readable even under maximal mode. */
const STRUCTURAL_RE = /^(id|.*_id|created_at|updated_at|deleted_at|status|type|kind)$/;

const PROFILES: Record<Vertical, VerticalProfile> = {
  general: {
    vertical: 'general',
    description: 'Default. Base rules only.',
  },

  recruitment: {
    vertical: 'recruitment',
    description:
      'Candidate data. Employment history and education are identifying in combination even when no direct identifier is present.',
    additionalFieldNames: [
      // A career history is a fingerprint: employer + dates + title identifies a
      // person to anyone who knows the industry, with no name required.
      { contains: 'employer', kind: 'free_text' },
      { contains: 'work_history', kind: 'free_text' },
      { contains: 'employment', kind: 'free_text' },
      { contains: 'education', kind: 'free_text' },
      { contains: 'qualification', kind: 'free_text' },
      { contains: 'job_title', kind: 'free_text' },
      { contains: 'current_role', kind: 'free_text' },
      { contains: 'notice_period', kind: 'free_text' },
      { contains: 'right_to_work', kind: 'national_id' },
      { contains: 'visa', kind: 'national_id' },
    ],
  },

  salon: {
    vertical: 'salon',
    description:
      'Client and staff data. Appointment notes routinely contain health information (allergies, skin conditions, pregnancy).',
    additionalFieldNames: [
      // Free-text appointment notes drift into special-category health data
      // (UK GDPR Art 9) without anyone deciding to record it.
      { contains: 'appointment_note', kind: 'free_text' },
      { contains: 'client_note', kind: 'free_text' },
      { contains: 'allerg', kind: 'free_text' },
      { contains: 'patch_test', kind: 'free_text' },
      { contains: 'medical', kind: 'free_text' },
      { contains: 'consultation_note', kind: 'free_text' },
    ],
  },

  facilities: {
    vertical: 'facilities',
    description:
      'Field workforce. Operative contact details and emergency contacts; site addresses are the client’s commercial data.',
    additionalFieldNames: [
      { contains: 'emergency_contact', kind: 'phone' },
      { contains: 'next_of_kin', kind: 'person_name' },
      { contains: 'site_address', kind: 'address' },
      { contains: 'site_location', kind: 'address' },
      // Certifications and training records identify the individual and are
      // employment data.
      { contains: 'certification', kind: 'free_text' },
      { contains: 'training_record', kind: 'free_text' },
      { contains: 'dbs', kind: 'national_id' },
    ],
  },

  financial: {
    vertical: 'financial',
    description:
      'Wealth and financial services. MAXIMAL: the combination is the disclosure. That a named client holds a given product is itself the sensitive fact.',
    maximal: true,
    additionalFieldNames: [
      { contains: 'portfolio', kind: 'financial' },
      { contains: 'holding', kind: 'financial' },
      { contains: 'transaction', kind: 'financial' },
      { contains: 'balance', kind: 'financial' },
      { contains: 'valuation', kind: 'financial' },
      { contains: 'product', kind: 'financial' },
    ],
  },
};

export const VERTICALS = Object.keys(PROFILES) as Vertical[];

export function getVerticalProfile(vertical: Vertical): VerticalProfile {
  return PROFILES[vertical] ?? PROFILES.general;
}

function keyOf(model: string, field: string): FieldKey {
  return `${model.toLowerCase()}.${field.toLowerCase()}`;
}

function lowerKeys<V>(record: Record<string, V> | undefined): Map<string, V> {
  const map = new Map<string, V>();
  for (const [k, v] of Object.entries(record ?? {})) map.set(k.toLowerCase(), v);
  return map;
}

/**
 * Build a classifier for your schema.
 *
 * Resolution order, base FIRST so a vertical can never weaken it:
 *   1. `explicit` (a deliberate decision beats an inferred one)
 *   2. `notPii` (an excused column stops here)
 *   3. the column-name rules
 *   4. the person-name rule, on `personModels` tables only
 *   5. the vertical's column-name fragments
 *   6. maximal mode, if the vertical has it and the row describes a person
 */
export function createFieldClassifier(registry: FieldRegistry = {}): FieldClassifier {
  const personModels = new Set([...(registry.personModels ?? [])].map((m) => m.toLowerCase()));
  const explicit = lowerKeys(registry.explicit);
  const notPii = lowerKeys(registry.notPii);
  const profile = getVerticalProfile(registry.vertical ?? 'general');

  function classifyBase(model: string, field: string): PiiFieldKind | null {
    const k = keyOf(model, field);
    const fromList = explicit.get(k);
    if (fromList) return fromList;
    if (notPii.has(k)) return null;

    const f = field.toLowerCase();
    for (const rule of FIELD_NAME_RULES) {
      if (rule.re.test(f)) return rule.kind;
    }
    if (PERSON_NAME_RE.test(f) && personModels.has(model.toLowerCase())) return 'person_name';
    return null;
  }

  function classify(model: string, field: string, siblingFields?: string[]): PiiFieldKind | null {
    const base = classifyBase(model, field);
    if (base) return base;

    // `notPii` excuses a column from the BASE rules only. A vertical may still
    // mark it: profiles add sensitivity, and nothing here subtracts it.
    const f = field.toLowerCase();
    for (const rule of profile.additionalFieldNames ?? []) {
      if (f.includes(rule.contains)) return rule.kind;
    }

    if (profile.maximal && siblingFields?.length && !STRUCTURAL_RE.test(f)) {
      const rowDescribesAPerson = siblingFields.some((s) => classifyBase(model, s) !== null);
      if (rowDescribesAPerson) return 'free_text';
    }
    return null;
  }

  return {
    classify,
    isPii: (model, field) => classify(model, field) !== null,
    redactRow(model, row) {
      const siblings = Object.keys(row);
      const out: Record<string, unknown> = {};
      for (const [field, value] of Object.entries(row)) {
        const kind = classify(model, field, siblings);
        out[field] = kind === null ? value : `[${kind.toUpperCase()}]`;
      }
      return out;
    },
    findStaleEntries(fields) {
      const tables = new Set(fields.map((f) => f.model.toLowerCase()));
      const columns = new Set(fields.map((f) => keyOf(f.model, f.field)));
      const stale: string[] = [];
      for (const m of personModels) if (!tables.has(m)) stale.push(`personModels: ${m}`);
      for (const k of explicit.keys()) if (!columns.has(k)) stale.push(`explicit: ${k}`);
      for (const k of notPii.keys()) if (!columns.has(k)) stale.push(`notPii: ${k}`);
      return stale;
    },
  };
}

# @opafex/privacy

PII redaction for logs, error reports and LLM payloads. UK-aware, zero dependencies.

```bash
npm install @opafex/privacy
```

```ts
import { redactText } from '@opafex/privacy';

redactText('Payment for sarah@example.com failed, retried sarah@example.com from 07700 900123');
// 'Payment for [EMAIL_1] failed, retried [EMAIL_1] from [PHONE_1]'
```

## Why tokens, not masks

Most redactors mask: `s***@example.com`, `***-***-0123`. Masking leaks (the domain, the last four digits), and it destroys what makes a log useful: you can no longer see that the same value appeared twice.

This package replaces each value with a token. Within one call, the same value always gets the same token, so `[EMAIL_1] failed, retried [EMAIL_1]` still tells you it was one person. Tokens are **not** stable across calls: a token that followed a person from log to log would be a pseudonymous identifier, which is still personal data under UK and EU GDPR.

Diagnostics are deliberately kept: stack frames, file paths, status codes, timestamps, column names and UUIDs (correlation IDs are handles, not personal data). A redactor that eats stack traces gets switched off.

## What it finds

| Token | Matches |
|---|---|
| `EMAIL` | Email addresses |
| `PHONE` | UK numbers (`07700 900123`, `+44 7700 900123`) and international `+` numbers |
| `NI_NUMBER` | UK National Insurance numbers, with or without spaces |
| `POSTCODE` | UK postcodes |
| `BANK` | Sort codes and IBANs |
| `CARD` | Payment card numbers |
| `ID` | Passport-shaped 9-digit numbers |
| `URL` | `mailto:` and `tel:` links |
| `IP` | IPv4 addresses |

Credentials are removed outright as `[redacted]`, never tokenised: API keys in common formats (OpenAI, Anthropic, Google, Slack, GitHub, JWTs), and any object key whose name says it is a secret (`password`, `token`, `apiKey`, `authorization`, `cookie`...).

The patterns lean towards over-matching. A postcode-shaped build ID being redacted costs nothing; a missed NI number is a breach.

## API

### By shape: values you know nothing about

```ts
import { redactText, redactTextWithCounts, scrubValue, redactError } from '@opafex/privacy';

redactText(logLine);                 // string in, string out
redactTextWithCounts(logLine);       // { text, counts: { byKind: { EMAIL: 2 }, total: 2 } }

scrubValue({                         // deep-walks objects and arrays, never mutates
  user: { email: 'a@x.com' },
  password: 'hunter2',               // -> '[redacted]' because of the key name
});

redactError(err);                    // { name, message, stack, code }: message redacted,
                                     // stack frames kept
```

`scrubValue` caps strings at 2,000 characters, arrays at 200 items and depth at 8, so a runaway payload cannot stall your logger.

### By location: rows from your own database

Shape matching misses a CV that happens to contain no email. If you know which table a row came from, classify its columns instead:

```ts
import { createFieldClassifier } from '@opafex/privacy';

const classifier = createFieldClassifier({
  // Only on these tables does `name`, `first_name`, `surname`... mean a person.
  personModels: ['users', 'candidates'],
  // Columns whose name gives nothing away but whose contents are personal.
  explicit: { 'candidates.resume_text': 'free_text', 'messages.body': 'free_text' },
  // Columns that look personal but are not, each with a reason.
  notPii: { 'users.email_verified': 'Boolean verification state, not an address.' },
});

classifier.redactRow('candidates', { id: 'c1', first_name: 'Sarah', resume_text: '...', status: 'active' });
// { id: 'c1', first_name: '[PERSON_NAME]', resume_text: '[FREE_TEXT]', status: 'active' }
```

Columns named like `email`, `phone`, `postcode`, `date_of_birth`, `ni_number`, `passport`, `iban`, `salary` or `ip_address` are personal on every table without being listed. A `name` column is personal only on the tables you list in `personModels`: most `name` columns (`products.name`, `teams.name`) are not about people, and redacting them all would make logs useless.

Keep the registry honest with a test over your schema:

```ts
expect(classifier.findStaleEntries(schemaFields)).toEqual([]);
// e.g. ['explicit: messages.body'] after `body` was renamed to `content`
```

### Sector profiles

Sensitivity depends on the business. Pass a `vertical` to layer extra rules on top:

| Vertical | Adds |
|---|---|
| `recruitment` | Employer, work history, education, job title, notice period (a career history identifies someone without a name); right-to-work and visa status |
| `salon` | Appointment and client notes, allergies, patch tests: notes drift into health data |
| `facilities` | Emergency contacts, next of kin, site addresses, certifications, DBS numbers |
| `financial` | Portfolio, holdings, balances, products, and **maximal mode**: on a row that describes a person, every non-structural column is redacted, because that a named client holds a product is itself the sensitive fact |

A profile can only add sensitivity, never remove it. It cannot un-mark a column the base rules treat as personal.

### Tenant identifiers

```ts
import { maskSecret } from '@opafex/privacy';

maskSecret('ABCD-1234-EFGH-5678'); // 'ABCD…678'
```

For licence keys and API-key prefixes, which are not personal data: enough to tell two tenants apart in a log, not enough to reuse. Do not use it for emails or names.

## Limits

- Pattern matching finds personal data by shape. It will not find a name in free text (`Sarah called about her account`). For free text, redact by location with `createFieldClassifier`, or do not log it.
- The patterns are UK-first. Non-UK national IDs, phone formats without a `+` prefix, and non-UK postcodes are not covered.
- This is for logs, telemetry and payloads sent to third parties. It is not an anonymisation guarantee for publishing a dataset.

## License

MIT, see [LICENSE](./LICENSE).

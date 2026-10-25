/**
 * @opafex/privacy: PII redaction for logs and LLM payloads.
 *
 * Two layers that complement each other:
 *   - by SHAPE: `redactText` / `scrubValue` / `redactError` find personal data
 *     inside values (an email in a log line, a phone number in a tool payload);
 *   - by LOCATION: `createFieldClassifier` decides which database columns hold
 *     personal data, whatever their contents look like.
 */

export {
  redactText,
  redactTextWithCounts,
  scrubValue,
  redactError,
  REDACTED,
  type RedactionCounts,
  type RedactTextResult,
} from './redact.js';

export { maskSecret } from './mask.js';

export {
  createFieldClassifier,
  getVerticalProfile,
  VERTICALS,
  type FieldClassifier,
  type FieldRegistry,
  type FieldKey,
  type PiiFieldKind,
  type SchemaField,
  type Vertical,
  type VerticalProfile,
} from './fields.js';

export {
  PII_PATTERNS,
  SECRET_KEY_RE,
  API_KEY_RE,
  UUID_RE,
  PRESERVED,
  type PiiKind,
  type PiiPattern,
} from './patterns.js';

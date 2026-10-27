# @opafex/grounding

Deterministic checks that an LLM agent's output is backed by the tool results it actually received.

An agent calls tools, gets results, then writes prose. The prose often says more than the results support: a commit hash nobody returned, a schema description copied from boilerplate while citing the real schema, "6 rows" when the query returned 2, a receipt number invented to fill a gap. These are hard to catch with another model call, and easy to catch for the cases where the claim has a recognisable shape.

This package checks those shapes. It makes no model calls, does no I/O and has no runtime dependencies. You pass in the output and the evidence; you get back typed violations with a message you can show the model to make it fix the output.

```sh
npm install @opafex/grounding
```

Node 20.19 or later. ESM only.

## Quick start

```ts
import { runGroundingGate } from '@opafex/grounding';

const result = runGroundingGate({
  text: 'Deployed commit 4e1a9c2b7d3f8e6a0b5c1d9f2e7a3b8c4d6f0e1a to production.',
  evidence: [{ id: 'dep_42', status: 'SUCCESS', createdAt: '2025-03-14T09:30:00Z' }],
});

result.status;            // 'fail'
result.violations[0].code; // 'fabricated_identifier'
result.violations[0].message;
// The output mentions sha `4e1a9c2b...` but it does not appear in any tool result. ...
```

A common pattern is: run the gate on the agent's final answer, and on a `fail` send the violation messages back to the model once and ask it to rewrite. Do not loop indefinitely, and do not silently rewrite the answer yourself.

## The checks

### Fabricated identifiers (`fabricated_identifier`, error)

Extracts identifier-shaped tokens from the prose: UUIDs, URLs, hex hashes (7 to 40 characters, must contain a letter a to f), and opaque ids of 16 or more characters (must contain a digit or mixed case). Each must occur somewhere in the evidence.

```ts
runGroundingGate({
  text: 'Customer cus_Qz8Lr3xJ2gExample9 was billed.',
  evidence: [{ customers: [{ id: 'cus_Ab12Cd34Ef56Gh78' }] }],
});
// fabricated_identifier: cus_Qz8Lr3xJ2gExample9
```

- A 7-character hash prefix passes when the full hash is in the evidence.
- URLs on well-known public documentation hosts (GitHub, MDN, npm and similar; see `DEFAULT_ALLOWED_HOSTS`) need no evidence. Pass `allowedHosts` to change the list, or `[]` to require evidence for every URL.
- Punctuation after a URL is not part of it: `([example.com](https://example.com)).` checks `https://example.com`. A closing bracket is kept only when the URL opened one.
- Long English words and compounds ("documentation", "well-designed-home", "London-based") are not treated as ids.
- **Bare domains** (`acme.co.uk`, `www.acme.com/pricing`, the domain of `jo@acme.com`) are checked too when you pass `domains: true` (off by default). A last label that reads as a file extension (`README.md`, `next.config.mjs`, `Node.js`), reserved example names (`example.com`, `*.test`, `localhost`) and a domain inside a path or after a key are not domains.

### Echoes: the agent backing its own invention

A tool that repeats its input defeats a presence check: the agent invents `acme-widgets.co.uk`, passes it to a lookup, and the result ("checked `acme-widgets.co.uk`: no match") now "contains" it. Build each call's evidence with `stripEchoedIdentifiers(result, args)`: it masks every identifier the result repeated from that call's own arguments, so a value counts only if a tool returned it without having been given it.

```ts
const evidence = calls.map((c) => stripEchoedIdentifiers(c.result, c.args));
runGroundingGate({ text, evidence }, { domains: true });
```

A token is masked only where it stands alone, so a longer value the tool really returned (`https://www.acme.com/pricing` from a search for `acme.com`, `jo@acme.com` from a mailbox read) still backs itself, and a value another call returned is untouched.

### Citation drift (`unsupported_citation`, error)

For agents that cite their sources inline, such as `The schema has three tables [4].`. Checking that `[4]` exists is easy. This checks the harder thing: that the cited sentence's specific details are in the cited source.

```ts
runGroundingGate({
  text: 'The schema includes users, accounts, sessions, and verification tokens [4].',
  citations: {
    4: { content: 'model order_items { ... } model invoice_lines { ... } model stock_levels { ... }' },
  },
});
// unsupported_citation: [4] does not contain users, accounts, sessions, ...
```

From each cited sentence it extracts identifier-like tokens (snake_case, CamelCase, dotted paths, versions, quoted strings, and items in a list of three or more bare words) and looks for them in the cited content. It tolerates plurals, brand suffixes (`Next.js` against `next`) and CamelCase against kebab-case (`NextAuth` against `next-auth`). A sentence is flagged when two or more tokens are missing, or at least half are.

- Sentences containing a negation ("does not use X") are skipped.
- A token missing from the cited source but present in another source counts as mis-attribution and is not flagged.
- The marker defaults to `[1]`, `[2]` and so on; `rows[0]` is not a citation. Pass `citationMarker` with your own pattern; capture group 1 is the citation id. Version 0.1 defaulted to `[tc1]`: pass `citationMarker: /\[(tc\d+)\]/g` to keep that.
- Runs only when you pass a non-empty `citations` index.

`checkCitationCounts` is a separate, standalone check for `<number> <noun>` claims in cited sentences against each source's `rowCount`. It is not part of the gate.

### Internal contradictions (`internal_contradiction`, error)

Across several outputs in one run, the same named thing given two values.

```ts
let facts = [];
const first = runGroundingGate({ text: 'The service runs AcmeDB 4.2.0.', emissionIndex: 0 });
facts = [...facts, ...first.newFacts];

const second = runGroundingGate({ text: 'The lockfile pins AcmeDB 3.9.1.', priorFacts: facts, emissionIndex: 1 });
// internal_contradiction: AcmeDB = 3.9.1, earlier output said 4.2.0
```

It currently understands two shapes: a capitalised name followed by a version (`Next.js 15.1.0`, `Node 20.x`) and a JSON-style `"name": "1.2.3"` pair. Only the disagreement the current output introduced is reported. You keep the facts between calls; the gate holds no state.

### Unsupported quantities (`unsupported_quantity`, warning)

Count claims about data collections ("6 rows", "8 records", "4 clean entries") checked against the counts the evidence supports: array lengths and count-like fields (`count`, `total`, `row_count`, `deleted` and so on).

```ts
runGroundingGate({
  text: 'Your table has 6 rows.',
  evidence: [{ rows: [{ id: 1 }, { id: 2 }], count: 2 }],
});
// unsupported_quantity (warning): claimed 6, counts found: 2
```

A claim matching any count in the evidence passes, and evidence with no countable structure skips the check.

### Invented written values (`ungrounded_write_value`, warning)

The prose checks see what the agent says. This one sees what it writes. Pass the write tool calls that transcribe external facts (inserting rows, updating records) and their values.

```ts
runGroundingGate({
  text: 'Logged the new expenses.',
  evidence: ['Receipt number 4810-3392-1057 Paid 21 March 2025'],
  writes: [{ tool: 'add_rows', values: [{ date: '2025-03-17', receipt_ref: '4802-7719-3346' }] }],
});
// ungrounded_write_value (warning): add_rows wrote `receipt_ref` (row 1) = `4802-7719-3346`
```

Only reference-shaped values are checked: hyphen-grouped codes with enough digits (receipt and invoice numbers), URLs, UUIDs, hex hashes and long ids. Dates, amounts and ordinary text are ignored because they coincide with evidence too often. Calls with `executed: false` are skipped.

## Severity

The three prose checks default to `error`. Quantities and writes default to `warning`, because the first matches plain numbers and the second is only as good as the evidence you pass: if you keep truncated tool results, a real value beyond the cut-off will be reported. Watch what they report on your own traffic, then promote them:

```ts
runGroundingGate(input, { severity: { quantities: 'error', writes: 'error' } });
```

`status` is `fail` when any violation has severity `error`. Warnings alone pass.

## API

### `runGroundingGate(input, options?)`

Input:

| Field | Type | |
|---|---|---|
| `text` | `string` | The output to check. May be empty when only checking writes. |
| `evidence` | `unknown[]` | Tool results. Strings are used as-is; other values are JSON-serialised. |
| `citations` | `Record<string, { content?, rowCount?, label? }>` | Citation id to source. Content also counts as evidence. |
| `priorFacts` | `FactPair[]` | Accumulated `newFacts` from earlier outputs. |
| `emissionIndex` | `number` | This output's position in the run. Default 0. |
| `writes` | `{ tool, values, executed? }[]` | Write calls to check. `values` is a record or an array of records. |

Options: `citationMarker` (RegExp), `allowedHosts` (iterable of hostnames), `domains` (also check bare domains, default false), `severity` (per-check override), `skip` (check names not to run).

Result:

```ts
{
  status: 'pass' | 'fail';
  violations: GroundingViolation[];   // discriminated on `code`
  newFacts: FactPair[];               // carry into the next call
  reports: CheckReport[];             // one per check: passed | failed | skipped | disabled | error
}
```

Each check runs in its own try/catch. One that throws is reported with status `error` and does not stop the others.

### Individual checks

Each check is also exported on its own, with a `status: 'passed' | 'failed' | 'skipped'` result:

- `checkIdentifiers({ text, evidence?, citations?, allowedHosts?, domains? })`
- `checkCitations(text, citations, { marker? })`
- `checkCitationCounts(text, citations, { marker? })`
- `checkContradictions(text, { priorFacts?, emissionIndex? })`
- `checkQuantities({ text, evidence? })`
- `checkWrites({ writes?, evidence?, citations? })`

Lower-level helpers: `stripEchoedIdentifiers`, `extractIdentifierTokens`, `trimUrlToken`, `extractFactPairs`, `findContradictions`, `extractQuantityClaims`, `collectEvidenceCounts`, `buildEvidenceText`, `appearsInEvidence`, plus the constants `DEFAULT_ALLOWED_HOSTS`, `DEFAULT_CITATION_MARKER` and `DEFAULT_SEVERITY`.

## Limits

These are heuristics. State them to yourself before relying on them.

- **They only see shapes.** A claim with no recognisable shape ("the migration went well", "revenue grew") is invisible. This is a floor under hallucination, not a fact-checker.
- **Presence is not correctness.** A token that occurs anywhere in the evidence passes, even if the prose attaches it to the wrong thing.
- **False positives happen.** A legitimate identifier the agent knew from its instructions rather than from a tool will be flagged unless you include it as evidence. An English compound with a digit in it will look like an id.
- **False negatives happen.** Paraphrased or reworded fabrications, numbers outside the collection-noun list, contradictions not phrased as name-plus-version, and anything in a sentence with a negation all pass.
- **The evidence is yours to supply.** If you truncate tool results, real values beyond the cut-off look invented. If you include the agent's own earlier output as evidence, its earlier inventions will back its later ones.
- **English only.** The patterns and stopword lists assume English prose.

## Licence

MIT. See [LICENSE](./LICENSE).

/**
 * The grounding gate: every check, one call.
 *
 * Pure. It performs no I/O, logs nothing and keeps no state. You pass in the
 * agent's output and the tool results it had; you get back typed violations,
 * a report per check, and the fact pairs to carry into the next call. What to
 * do with a violation (fail the step, ask the model to rewrite once, log it)
 * is your decision.
 *
 * Each check runs inside its own try/catch, so one check throwing cannot
 * suppress the others; it is reported with status `error`.
 */

import { checkCitations, type CitationOptions } from './citations.js';
import { checkContradictions, type FactPair } from './contradictions.js';
import type { CitationIndex } from './evidence.js';
import { checkIdentifiers, type IdentifierKind } from './identifiers.js';
import { checkQuantities } from './quantities.js';
import { checkFigures, type FigureKind } from './figures.js';
import { checkWrites, type WriteCall, type WrittenTokenKind } from './writes.js';

const FIGURE_WORDS: Record<FigureKind, string> = {
  money: 'amount', percent: 'percentage', reference: 'reference', count: 'count', date: 'date', days: 'number of days',
};

export type CheckName = 'identifiers' | 'citations' | 'contradictions' | 'quantities' | 'writes' | 'figures';

export type Severity = 'error' | 'warning';

/**
 * Default severities. The three prose checks are precise enough to act on.
 * The quantity and write checks are noisier: the first matches numbers, the
 * second depends on your evidence being complete. Start them as warnings,
 * watch what they report on your traffic, then promote them.
 */
export const DEFAULT_SEVERITY: Readonly<Record<CheckName, Severity>> = Object.freeze({
  identifiers: 'error',
  citations: 'error',
  contradictions: 'error',
  quantities: 'warning',
  writes: 'warning',
  figures: 'warning',
});

export interface GroundingGateInput {
  /** The agent's output to check. May be empty when only `writes` are checked. */
  text: string;
  /**
   * Tool results the agent received: in this turn, or across the whole run.
   * An identifier present in any of them is not invented. Strings are used
   * as-is; other values are JSON-serialised.
   */
  evidence?: readonly unknown[];
  /**
   * Citation id to source, when your agent cites its sources in the prose.
   * The citation check runs only when this is non-empty. Source content also
   * counts as evidence for the other checks.
   */
  citations?: CitationIndex;
  /** Fact pairs from earlier outputs in the run (from previous `newFacts`). */
  priorFacts?: readonly FactPair[];
  /** This output's position in the run. Defaults to 0. */
  emissionIndex?: number;
  /** Write tool calls made alongside this output. */
  writes?: readonly WriteCall[];
}

export interface GroundingGateOptions {
  /** Citation marker pattern; see `CitationOptions.marker`. */
  citationMarker?: RegExp;
  /** URL hosts that need no evidence; see `DEFAULT_ALLOWED_HOSTS`. */
  allowedHosts?: Iterable<string>;
  /**
   * Also check bare domains ("acme.co.uk") as identifiers. Default false.
   * Turn it on per surface, and observe before enforcing.
   */
  domains?: boolean;
  /**
   * Also check email addresses, WHOLE (local part included). Default false.
   * A guessed `first.last@firm.co.uk` is unbacked even when `firm.co.uk` is in
   * the evidence.
   */
  emails?: boolean;
  /**
   * Also check money, percentages and reference codes against the evidence
   * (`checkFigures`). Default false: it widens what an existing caller flags,
   * so turn it on per surface. The evidence must hold what the agent read in
   * the conversation, or a figure it legitimately carried forward is reported.
   */
  figures?: boolean;
  /** Today, as `YYYY-MM-DD`, so the figures check can read "31 days overdue". */
  today?: string;
  /** Override the severity of any check. */
  severity?: Partial<Record<CheckName, Severity>>;
  /** Checks not to run. */
  skip?: readonly CheckName[];
}

interface ViolationBase {
  severity: Severity;
  /** A sentence you can show the model to make it fix the output. */
  message: string;
}

export type GroundingViolation =
  | (ViolationBase & {
      code: 'fabricated_identifier';
      token: string;
      kind: IdentifierKind;
      excerpt: string;
    })
  | (ViolationBase & {
      code: 'unsupported_citation';
      citation: string;
      missingTokens: string[];
      sentence: string;
    })
  | (ViolationBase & {
      code: 'internal_contradiction';
      noun: string;
      value: string;
      earlierValue: string;
      earlierEmissionIndex: number;
    })
  | (ViolationBase & {
      code: 'unsupported_quantity';
      claimed: number;
      noun: string;
      context: string;
      evidenceCounts: number[];
    })
  | (ViolationBase & {
      code: 'unsupported_figure';
      token: string;
      kind: FigureKind;
      context: string;
    })
  | (ViolationBase & {
      code: 'ungrounded_write_value';
      tool: string;
      field: string;
      row?: number;
      token: string;
      kind: WrittenTokenKind;
    });

export interface CheckReport {
  check: CheckName;
  /**
   * `passed` and `failed` are what they say. `skipped` means there was nothing
   * to check (no identifiers, no citations, no countable evidence, ...).
   * `disabled` means you listed it in `skip`. `error` means the check threw.
   */
  status: 'passed' | 'failed' | 'skipped' | 'disabled' | 'error';
  /** How many claims or tokens the check examined. */
  scanned: number;
  /** How many violations it produced. */
  findings: number;
  /** The thrown error's message, when `status` is `error`. */
  error?: string;
}

export interface GroundingGateResult {
  /** `fail` when any violation has severity `error`. Warnings alone pass. */
  status: 'pass' | 'fail';
  violations: GroundingViolation[];
  /** Fact pairs this output stated. Append them to `priorFacts` for the next call. */
  newFacts: FactPair[];
  /** One report per check, in a fixed order. */
  reports: CheckReport[];
}

/** Run every grounding check over one output. Pure. */
export function runGroundingGate(
  input: GroundingGateInput,
  options: GroundingGateOptions = {},
): GroundingGateResult {
  const text = typeof input.text === 'string' ? input.text : '';
  const severity = { ...DEFAULT_SEVERITY, ...options.severity };
  const skip = new Set(options.skip ?? []);
  const violations: GroundingViolation[] = [];
  const reports: CheckReport[] = [];
  let newFacts: FactPair[] = [];

  const run = (check: CheckName, body: () => Omit<CheckReport, 'check'>): void => {
    if (skip.has(check)) {
      reports.push({ check, status: 'disabled', scanned: 0, findings: 0 });
      return;
    }
    try {
      reports.push({ check, ...body() });
    } catch (err) {
      reports.push({
        check,
        status: 'error',
        scanned: 0,
        findings: 0,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  run('identifiers', () => {
    const r = checkIdentifiers({
      text,
      evidence: input.evidence,
      citations: input.citations,
      allowedHosts: options.allowedHosts,
      domains: options.domains === true,
      emails: options.emails === true,
    });
    for (const u of r.unbacked) {
      violations.push({
        code: 'fabricated_identifier',
        severity: severity.identifiers,
        token: u.token,
        kind: u.kind,
        excerpt: u.excerpt,
        message: u.kind === 'email'
          // An address is never "unverified but plausible": a wrong one emails a stranger.
          ? `The output gives the email address \`${u.token}\` but no tool result contains it. ` +
            `Never guess an address: give one a tool actually returned, or none. ` +
            `Context: "${u.excerpt}"`
          : `The output mentions ${u.kind} \`${u.token}\` but it does not appear in any tool result. ` +
            `Remove it, replace it with a value a tool actually returned, or mark it as unverified. ` +
            `Context: "${u.excerpt}"`,
      });
    }
    return { status: r.status, scanned: r.scanned, findings: r.unbacked.length };
  });

  run('citations', () => {
    if (!input.citations || Object.keys(input.citations).length === 0) {
      return { status: 'skipped', scanned: 0, findings: 0 };
    }
    const citationOptions: CitationOptions = { marker: options.citationMarker };
    const r = checkCitations(text, input.citations, citationOptions);
    for (const u of r.unsupported) {
      const tokens = u.missingTokens.slice(0, 5).map((t) => `\`${t}\``).join(', ');
      violations.push({
        code: 'unsupported_citation',
        severity: severity.citations,
        citation: u.citation,
        missingTokens: u.missingTokens,
        sentence: u.sentence,
        message:
          `A sentence cites ${u.citation} but that source does not contain ${tokens}. ` +
          `Remove the unsupported details, replace them with what ${u.citation} actually says, ` +
          `or mark them as unverified. The sentence was: "${u.sentence}"`,
      });
    }
    return { status: r.status, scanned: r.scanned, findings: r.unsupported.length };
  });

  run('contradictions', () => {
    const r = checkContradictions(text, {
      priorFacts: input.priorFacts,
      emissionIndex: input.emissionIndex,
    });
    newFacts = r.newFacts;
    for (const c of r.contradictions) {
      violations.push({
        code: 'internal_contradiction',
        severity: severity.contradictions,
        noun: c.nounDisplay,
        value: c.value,
        earlierValue: c.earlierValue,
        earlierEmissionIndex: c.earlierEmissionIndex,
        message:
          `This output says ${c.nounDisplay} = \`${c.value}\` but an earlier output ` +
          `(#${c.earlierEmissionIndex}) said \`${c.earlierValue}\` (context: "${c.earlierContext}"). ` +
          `Pick one and align, re-checking the source if unsure which is correct.`,
      });
    }
    return { status: r.status, scanned: r.newFacts.length, findings: r.contradictions.length };
  });

  run('quantities', () => {
    const evidence = [
      ...(input.evidence ?? []),
      ...Object.values(input.citations ?? {}).map((s) => s?.content),
    ];
    const r = checkQuantities({ text, evidence });
    for (const q of r.unsupported) {
      violations.push({
        code: 'unsupported_quantity',
        severity: severity.quantities,
        claimed: q.number,
        noun: q.noun,
        context: q.context,
        evidenceCounts: r.evidenceCounts,
        message:
          `The output claims ${q.number} ${q.noun}, but no tool result has that count ` +
          `(counts found: ${r.evidenceCounts.slice(0, 8).join(', ')}). ` +
          `Report the count the tools returned. Context: "${q.context}"`,
      });
    }
    return { status: r.status, scanned: r.scanned, findings: r.unsupported.length };
  });

  run('writes', () => {
    const r = checkWrites({ writes: input.writes, evidence: input.evidence, citations: input.citations });
    for (const w of r.ungrounded) {
      const where = `\`${w.field}\`${w.row !== undefined ? ` (row ${w.row + 1})` : ''}`;
      violations.push({
        code: 'ungrounded_write_value',
        severity: severity.writes,
        tool: w.tool,
        field: w.field,
        ...(w.row !== undefined ? { row: w.row } : {}),
        token: w.token,
        kind: w.kind,
        message:
          `${w.tool} wrote ${where} = \`${w.token}\`, but that value appears in no tool result. ` +
          `Do not write values you did not retrieve. Remove the row or field, or replace it with ` +
          `a value a tool returned. If the record is real but was not fetched, leave it out and say so.`,
      });
    }
    return { status: r.status, scanned: r.scanned, findings: r.ungrounded.length };
  });

  if (options.figures === true) run('figures', () => {
    const evidence = [
      ...(input.evidence ?? []),
      ...Object.values(input.citations ?? {}).map((s) => s?.content),
    ];
    const r = checkFigures({ text, evidence, today: options.today });
    for (const f of r.unsupported) {
      const what = FIGURE_WORDS[f.kind];
      violations.push({
        code: 'unsupported_figure',
        severity: severity.figures,
        token: f.token,
        kind: f.kind,
        context: f.context,
        message:
          `The output gives the ${what} ${f.token}, but no tool result holds it and it is not a total or share ` +
          `of figures that do. Use the figure the tools returned, or remove it. Context: "${f.context}"`,
      });
    }
    return { status: r.status, scanned: r.scanned, findings: r.unsupported.length };
  });
  else reports.push({ check: 'figures', status: 'disabled', scanned: 0, findings: 0 });

  return {
    status: violations.some((v) => v.severity === 'error') ? 'fail' : 'pass',
    violations,
    newFacts,
    reports,
  };
}

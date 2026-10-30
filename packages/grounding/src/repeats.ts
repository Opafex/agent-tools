/**
 * Repeated calls: the same tool call, with the same arguments, again and again.
 *
 * A loop that re-reads the same calendar day eleven times is not making
 * progress, and a nudge that only reacts to FAILED calls never sees it,
 * because every one of those calls succeeded. Small models do this often;
 * large ones occasionally, and it costs a turn's whole budget either way.
 *
 * The rule: a call identical to `maxIdentical` earlier calls (same tool, same
 * arguments after key-order normalisation) should not run. Its result cannot
 * differ from what the agent already has, unless the tool reads something that
 * changes, in which case raise the limit for that tool.
 */

export interface PastCall {
  tool: string;
  /** The arguments object, or its JSON string. */
  args: unknown;
}

export interface RepeatCheckOptions {
  /** How many identical earlier calls are allowed. Default 2: the third identical call is refused. */
  maxIdentical?: number;
  /** Per-tool limits, for tools whose results change between calls (a status poll). */
  perTool?: Readonly<Record<string, number>>;
}

export interface RepeatCheckResult {
  status: 'passed' | 'repeated';
  /** How many earlier calls were identical to this one. */
  previous: number;
  /** A message to send back to the model; empty unless `repeated`. */
  message: string;
}

/** A stable string for a value: object keys sorted, so `{a,b}` equals `{b,a}`. */
export function canonicalArgs(args: unknown): string {
  let v = args;
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v);
    } catch {
      return v as string;
    }
  }
  const norm = (x: unknown, depth: number): unknown => {
    if (depth > 10) return null;
    if (Array.isArray(x)) return x.map((i) => norm(i, depth + 1));
    if (x && typeof x === 'object') {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(x).sort()) out[k] = norm((x as Record<string, unknown>)[k], depth + 1);
      return out;
    }
    return x;
  };
  try {
    return JSON.stringify(norm(v ?? {}, 0)) ?? '';
  } catch {
    return '';
  }
}

/** Check one proposed call against the calls already made. Pure. */
export function checkRepeatedCall(
  input: { call: PastCall; history: readonly PastCall[] },
  options: RepeatCheckOptions = {},
): RepeatCheckResult {
  const limit = options.perTool?.[input.call.tool] ?? options.maxIdentical ?? 2;
  const key = canonicalArgs(input.call.args);
  let previous = 0;
  for (const past of input.history ?? []) {
    if (past?.tool === input.call.tool && canonicalArgs(past.args) === key) previous++;
  }
  if (previous < limit) return { status: 'passed', previous, message: '' };
  return {
    status: 'repeated',
    previous,
    message:
      `Not run: you have already called ${input.call.tool} with exactly these arguments ${previous} ` +
      `time${previous === 1 ? '' : 's'}, and the result will not change. Use the result you already have, ` +
      'try a different tool or different arguments, or tell the user what is blocking you.',
  };
}

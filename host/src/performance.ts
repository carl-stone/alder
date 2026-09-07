import { constants, accessSync, appendFileSync, statSync } from "node:fs";
import { join } from "node:path";

type TraceValue = string | number | boolean | null | undefined;
export type TraceFields = Record<string, TraceValue>;

export interface PerformanceSpan {
  readonly id: number;
  readonly stage: string;
  readonly start: bigint;
  readonly startMs: number;
  readonly fields: TraceFields;
  ended: boolean;
}

const origin = process.hrtime.bigint();
let spanCounter = 0;

export class PerformanceTrace {
  private readonly path: string | undefined;

  constructor(environment: NodeJS.ProcessEnv = process.env) {
    const directory = environment.ALDER_PERF_TRACE_DIR ?? "";
    if (directory.length === 0) return;
    let valid = false;
    try {
      valid = statSync(directory).isDirectory();
      accessSync(directory, constants.W_OK);
    } catch {
      valid = false;
    }
    if (!valid) {
      throw new Error("ALDER_PERF_TRACE_DIR must be an existing writable directory");
    }
    this.path = join(directory, `host-${process.pid}.jsonl`);
  }

  begin(stage: string, fields: TraceFields = {}): PerformanceSpan | undefined {
    if (this.path === undefined) return undefined;
    const start = process.hrtime.bigint();
    const span: PerformanceSpan = {
      id: ++spanCounter,
      stage,
      start,
      startMs: nanosecondsToMilliseconds(start - origin),
      fields,
      ended: false,
    };
    this.write({
      event: "begin",
      pid: process.pid,
      span: span.id,
      stage,
      clock: "process.hrtime.bigint",
      start_ms: span.startMs,
      fields,
    });
    return span;
  }

  end(span: PerformanceSpan | undefined, result: TraceFields = {}): void {
    if (span === undefined || span.ended) return;
    span.ended = true;
    const durationMs = nanosecondsToMilliseconds(process.hrtime.bigint() - span.start);
    this.write({
      event: "end",
      duration_ms: durationMs,
      pid: process.pid,
      span: span.id,
      stage: span.stage,
      clock: "process.hrtime.bigint",
      start_ms: span.startMs,
      fields: span.fields,
      result,
    });
  }

  private write(record: Record<string, unknown>): void {
    appendFileSync(this.path!, `${JSON.stringify(record)}\n`, {
      encoding: "utf8",
      flag: "a",
      mode: 0o600,
    });
  }
}

function nanosecondsToMilliseconds(value: bigint): number {
  return Number(value) / 1_000_000;
}

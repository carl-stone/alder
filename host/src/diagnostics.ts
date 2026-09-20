import { randomUUID } from "node:crypto";
import { appendFile, chmod, copyFile, lstat, mkdir, open, readdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { arch, platform } from "node:os";
import { basename, join, resolve } from "node:path";
import envPaths from "env-paths";

export const DIAGNOSTIC_SCHEMA_VERSION = 2;
export const DIAGNOSTIC_SEGMENT_BYTES = 10 * 1024 * 1024;
export const DIAGNOSTIC_TOTAL_BYTES = 256 * 1024 * 1024;
export const DIAGNOSTIC_MAX_SEGMENTS = 32;
export const DIAGNOSTIC_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const DIAGNOSTIC_QUEUE_LIMIT = 4_096;
export const DIAGNOSTIC_CHILD_TAIL_BYTES = 64 * 1024;
const DIAGNOSTIC_BATCH_SIZE = 128;
const LOCK_WAIT_MS = 2_000;
const LOCK_STALE_MS = 30_000;
const QUERY_RECORD_LIMIT = 200_000;

export type DiagnosticSeverity = "debug" | "info" | "warn" | "error";
export type DiagnosticFields = Readonly<Record<string, unknown>>;
export type DiagnosticEvent = string;
export interface DiagnosticSink {
  record(severity: DiagnosticSeverity, event: DiagnosticEvent, fields?: DiagnosticFields): void;
  recordDurable?(severity: DiagnosticSeverity, event: DiagnosticEvent, fields?: DiagnosticFields): Promise<void>;
  child(fields: DiagnosticFields): DiagnosticSink;
  flush?(): Promise<void>;
}

export function recordDiagnosticDurable(sink: DiagnosticSink | undefined, severity: DiagnosticSeverity, event: DiagnosticEvent, fields: DiagnosticFields = {}): Promise<void> | undefined {
  if (!sink) return undefined;
  if (sink.recordDurable) return sink.recordDurable(severity, event, fields);
  sink.record(severity, event, fields);
  return undefined;
}

export interface DiagnosticsOptions {
  rootDir: string;
  role: "desktop" | "backend" | "host" | "renderer" | "cli";
  component?: string;
  appLaunchId?: string;
  backendInstanceId?: string;
  processInstanceId?: string;
  appVersion?: string;
  buildId?: string;
  queueLimit?: number;
  segmentBytes?: number;
  totalBytes?: number;
  maxSegments?: number;
  maxAgeMs?: number;
  flushDelayMs?: number;
  stderr?: Pick<NodeJS.WriteStream, "write"> | null;
  now?: () => Date;
  monotonicNow?: () => number;
  slowThresholdMs?: number;
}

export interface DiagnosticsStatus {
  available: boolean;
  degraded: boolean;
  generatedEvents: number;
  acceptedEvents: number;
  persistedEvents: number;
  droppedEvents: number;
  unavailableEvents: number;
  queuedEvents: number;
  currentSegmentBytes: number;
  retainedBytes: number;
  segmentCount: number;
  lastError: ReturnType<typeof diagnosticError> | null;
  rootDir: string;
}

interface QueuedRecord {
  readonly sequence: number;
  readonly timestamp: string;
  readonly monotonicMs: number;
  readonly severity: DiagnosticSeverity;
  readonly event: string;
  readonly context: DiagnosticFields;
  readonly fields: DiagnosticFields;
  readonly durable: boolean;
}
interface SerializedRecord { readonly line: string; readonly bytes: number; readonly durable: boolean; }
interface ActiveOperation {
  readonly operationId: string;
  readonly clientId: string;
  readonly kind: string;
  readonly startedAt: number;
  lastProgressAt: number;
  readonly phases: Set<string>;
  readonly timer: NodeJS.Timeout;
  readonly scope: DiagnosticFields;
}
interface SegmentEntry { path: string; name: string; size: number; mtimeMs: number; active: boolean; pid: number | null; format: "jsonl" | "record"; }
interface RecordTemporaryEntry { size: number; ownerAlive: boolean; }

const TERMINAL_EVENTS = new Set(["operation.settled", "operation.cancelled", "operation.failed"]);
const SLOW_THRESHOLDS: Record<string, number> = {
  transaction: 5_000, save: 10_000, "save-as": 15_000, run: 30_000, restart: 45_000,
  format: 30_000, publish: 120_000, "packages-install": 120_000, inspect: 15_000,
};
const EXPECTED_PHASES: Record<string, readonly string[]> = {
  transaction: ["recovery-flush", "authoritative-ack"],
  save: ["publication", "clean"],
  "save-as": ["publication", "clean"],
  run: ["analysis-ready", "kernel-dispatch", "kernel-completion", "authoritative-completion"],
  restart: ["terminal"], format: ["terminal"], publish: ["terminal"], "packages-install": ["terminal"], inspect: ["terminal"],
};

export function diagnosticsRoot(): string {
  return resolve(process.env.ALDER_DIAGNOSTICS_DIR ?? join(envPaths("Alder", { suffix: "" }).data, "diagnostics"));
}

export function diagnosticError(value: unknown, seen = new Set<unknown>()): {
  name: string; message: string; stack: string | null; cause: unknown; code: unknown;
} {
  if (value instanceof Error) {
    if (seen.has(value)) return { name: value.name, message: value.message, stack: value.stack ?? null, cause: "[Circular error cause]", code: (value as NodeJS.ErrnoException).code ?? null };
    seen.add(value);
    return {
      name: value.name,
      message: value.message,
      stack: value.stack ?? null,
      cause: value.cause === undefined ? null : value.cause instanceof Error ? diagnosticError(value.cause, seen) : diagnosticValue(value.cause),
      code: (value as NodeJS.ErrnoException).code ?? null,
    };
  }
  return { name: typeof value, message: String(value), stack: null, cause: null, code: null };
}

export function diagnosticProcessContext(): Record<string, unknown> {
  const usage = process.resourceUsage?.();
  return {
    pid: process.pid,
    ppid: process.ppid,
    cwd: process.cwd(),
    argv: [...process.argv],
    execPath: process.execPath,
    versions: { ...process.versions },
    platform: process.platform,
    arch: process.arch,
    environment: { ...process.env },
    memory: process.memoryUsage(),
    resourceUsage: usage ? { ...usage } : null,
  };
}

function diagnosticValue(value: unknown, seen = new Set<unknown>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "undefined") return null;
  if (value instanceof Error) return diagnosticError(value);
  if (Buffer.isBuffer(value)) return { type: "Buffer", byteLength: value.byteLength, base64: value.toString("base64") };
  if (value instanceof Uint8Array) return { type: value.constructor.name, byteLength: value.byteLength, base64: Buffer.from(value).toString("base64") };
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) {
    const output = value.map(item => diagnosticValue(item, seen));
    seen.delete(value);
    return output;
  }
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) output[key] = diagnosticValue(item, seen);
  seen.delete(value);
  return output;
}

class DiagnosticsCore {
  readonly rootDir: string;
  readonly role: DiagnosticsOptions["role"];
  readonly component: string;
  readonly appLaunchId: string;
  readonly backendInstanceId?: string;
  readonly processInstanceId: string;
  readonly appVersion: string;
  readonly buildId: string;
  private readonly queueLimit: number;
  private readonly segmentBytes: number;
  private readonly totalBytes: number;
  private readonly maxSegments: number;
  private readonly maxAgeMs: number;
  private readonly flushDelayMs: number;
  private readonly stderr: Pick<NodeJS.WriteStream, "write"> | null;
  private readonly now: () => Date;
  private readonly monotonicNow: () => number;
  private readonly slowThresholdMs?: number;
  private readonly queue: QueuedRecord[] = [];
  private readonly activeOperations = new Map<string, ActiveOperation>();
  private flushTimer?: NodeJS.Timeout;
  private drainTail: Promise<void> = Promise.resolve();
  private initialized = false;
  private disabled = false;
  private closed = false;
  private fallbackReported = false;
  private activePath = "";
  private statusPath = "";
  private activeSize = 0;
  private retainedBytes = 0;
  private segmentCount = 0;
  private lastError: ReturnType<typeof diagnosticError> | null = null;
  private eventSequence = 0;
  generatedEvents = 0;
  acceptedEvents = 0;
  persistedEvents = 0;
  droppedEvents = 0;
  unavailableEvents = 0;

  constructor(options: DiagnosticsOptions) {
    this.rootDir = resolve(options.rootDir);
    this.role = options.role;
    this.component = options.component ?? options.role;
    this.appLaunchId = options.appLaunchId ?? randomUUID();
    this.backendInstanceId = options.backendInstanceId;
    this.processInstanceId = options.processInstanceId ?? randomUUID();
    this.appVersion = options.appVersion ?? "unknown";
    this.buildId = options.buildId ?? "unknown";
    this.queueLimit = options.queueLimit ?? DIAGNOSTIC_QUEUE_LIMIT;
    this.segmentBytes = options.segmentBytes ?? DIAGNOSTIC_SEGMENT_BYTES;
    this.totalBytes = options.totalBytes ?? DIAGNOSTIC_TOTAL_BYTES;
    this.maxSegments = options.maxSegments ?? DIAGNOSTIC_MAX_SEGMENTS;
    this.maxAgeMs = options.maxAgeMs ?? DIAGNOSTIC_MAX_AGE_MS;
    this.flushDelayMs = options.flushDelayMs ?? 25;
    this.stderr = options.stderr === undefined ? process.stderr : options.stderr;
    this.now = options.now ?? (() => new Date());
    this.monotonicNow = options.monotonicNow ?? (() => performance.now());
    this.slowThresholdMs = options.slowThresholdMs;
  }

  enqueue(severity: DiagnosticSeverity, event: DiagnosticEvent, context: DiagnosticFields, fields: DiagnosticFields, durable = false): number | null {
    this.generatedEvents++;
    if (this.disabled || this.closed) { this.unavailableEvents++; return null; }
    if (!/^[a-z][a-z0-9_.-]{1,127}$/.test(event)) { this.droppedEvents++; void this.persistStatus().catch(() => undefined); return null; }
    const admitted = this.queue.length < this.queueLimit;
    let acceptedSequence: number | null = null;
    if (admitted) {
      const sequence = ++this.eventSequence;
      acceptedSequence = sequence;
      const launchContext = event.endsWith(".launch") ? { processContext: diagnosticProcessContext() } : {};
      this.queue.push({
        sequence, timestamp: this.now().toISOString(), monotonicMs: Math.round(this.monotonicNow() * 1000) / 1000,
        severity, event, context, fields: { ...launchContext, ...fields }, durable,
      });
      this.acceptedEvents++;
    } else {
      this.droppedEvents++;
      void this.persistStatus().catch(() => undefined);
    }
    this.observeOperation(event, { ...context, ...fields });
    if (admitted) this.scheduleFlush(severity === "error" || TERMINAL_EVENTS.has(event) || event.includes("fatal") ? 0 : this.queue.length >= 64 ? 0 : this.flushDelayMs);
    return acceptedSequence;
  }

  private operationKey(fields: DiagnosticFields): string | null {
    const operationId = typeof fields.operationId === "string" ? fields.operationId : null;
    if (!operationId) return null;
    return [this.appLaunchId, this.backendInstanceId ?? "", fields.sessionEpoch ?? fields.sessionId ?? "", fields.clientId ?? "internal", operationId].map(String).join("\0");
  }

  private observeOperation(event: string, fields: DiagnosticFields): void {
    const key = this.operationKey(fields);
    if (!key) return;
    if (event === "operation.accepted") {
      const operationId = String(fields.operationId);
      const clientId = typeof fields.clientId === "string" ? fields.clientId : "internal";
      const kind = typeof fields.kind === "string" ? fields.kind : "other";
      const startedAt = this.monotonicNow();
      const threshold = this.slowThresholdMs ?? SLOW_THRESHOLDS[kind] ?? 30_000;
      const prior = this.activeOperations.get(key);
      if (prior) clearTimeout(prior.timer);
      const timer = setTimeout(() => {
        const active = this.activeOperations.get(key);
        if (!active) return;
        this.enqueue("warn", "operation.slow", {}, {
          ...active.scope,
          operationId, clientId, kind: active.kind, thresholdMs: threshold,
          durationMs: Math.round(this.monotonicNow() - active.startedAt),
          lastProgressMs: Math.round(this.monotonicNow() - active.lastProgressAt),
        });
      }, threshold);
      timer.unref?.();
      const scope = {
        ...(typeof fields.sessionId === "string" ? { sessionId: fields.sessionId } : {}),
        ...(typeof fields.sessionEpoch === "string" ? { sessionEpoch: fields.sessionEpoch } : {}),
      };
      this.activeOperations.set(key, { operationId, clientId, kind, startedAt, lastProgressAt: startedAt, phases: new Set(), timer, scope });
      return;
    }
    const active = this.activeOperations.get(key);
    if (!active) return;
    if (!TERMINAL_EVENTS.has(event)) {
      const phase = typeof fields.phase === "string" ? fields.phase : event === "operation.progress" ? "first-progress" : undefined;
      if (phase) { active.phases.add(phase); active.lastProgressAt = this.monotonicNow(); }
      return;
    }
    clearTimeout(active.timer);
    active.phases.add("terminal");
    const expected = EXPECTED_PHASES[active.kind] ?? ["terminal"];
    const notApplicable = Array.isArray(fields.notApplicablePhases) ? fields.notApplicablePhases.filter(value => typeof value === "string") : [];
    this.activeOperations.delete(key);
    this.enqueue("info", "operation.timing", {}, {
      ...active.scope,
      operationId: active.operationId, clientId: active.clientId, kind: active.kind,
      outcome: event === "operation.settled" ? "success" : event === "operation.cancelled" ? "cancelled" : "error",
      durationMs: Math.round(this.monotonicNow() - active.startedAt),
      observedPhases: [...active.phases], notApplicablePhases: notApplicable,
      missingPhases: expected.filter(phase => !active.phases.has(phase) && !notApplicable.includes(phase)),
    });
  }

  private scheduleFlush(delay: number): void {
    if (this.flushTimer !== undefined || this.closed || this.disabled) return;
    this.flushTimer = setTimeout(() => { this.flushTimer = undefined; void this.flush().catch(() => undefined); }, delay);
    this.flushTimer.unref?.();
  }

  private async initialize(): Promise<void> {
    if (this.initialized) return;
    await mkdir(this.rootDir, { recursive: true, mode: 0o700 });
    await chmod(this.rootDir, 0o700);
    await withDirectoryLock(this.rootDir, () => normalizeDeadActiveSegments(this.rootDir));
    const suffix = `${this.role}-${process.pid}-${this.processInstanceId}`;
    this.activePath = join(this.rootDir, `diagnostics-active-${suffix}.jsonl`);
    this.statusPath = join(this.rootDir, `diagnostics-status-${suffix}.json`);
    this.activeSize = await stat(this.activePath).then(info => info.size, error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
      throw error;
    });
    await chmod(this.activePath, 0o600).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; });
    this.initialized = true;
    await this.refreshRetainedSize();
    await this.persistStatus();
  }

  private serialize(record: QueuedRecord): SerializedRecord {
    const value = {
      schemaVersion: DIAGNOSTIC_SCHEMA_VERSION,
      timestamp: record.timestamp,
      monotonicMs: record.monotonicMs,
      severity: record.severity,
      component: this.component,
      event: record.event,
      appVersion: this.appVersion,
      buildId: this.buildId,
      process: { role: this.role, instanceId: this.processInstanceId, pid: process.pid },
      appLaunchId: this.appLaunchId,
      eventSequence: record.sequence,
      ...(this.backendInstanceId ? { backendInstanceId: this.backendInstanceId } : {}),
      ...(diagnosticValue(record.context) as Record<string, unknown>),
      ...(diagnosticValue(record.fields) as Record<string, unknown>),
    };
    const line = JSON.stringify(value) + "\n";
    return { line, bytes: Buffer.byteLength(line), durable: record.durable };
  }

  private async drainThrough(targetSequence: number): Promise<void> {
    if (this.disabled) return;
    try { await this.initialize(); } catch (error) { await this.disable(error); return; }
    while (this.queue.length > 0 && this.queue[0]!.sequence <= targetSequence) {
      const raw = this.queue.slice(0, DIAGNOSTIC_BATCH_SIZE).filter(record => record.sequence <= targetSequence);
      if (raw.length === 0) break;
      const serialized = raw.map(record => this.serialize(record));
      let persisted = 0;
      try { persisted = await this.appendRecords(serialized); } catch (error) { await this.disable(error); return; }
      this.queue.splice(0, raw.length);
      this.persistedEvents += persisted;
      this.droppedEvents += raw.length - persisted;
    }
    await this.refreshRetainedSize();
    await this.persistStatus();
  }

  private async appendRecords(records: readonly SerializedRecord[]): Promise<number> {
    return withDirectoryLock(this.rootDir, async () => {
      await normalizeDeadActiveSegments(this.rootDir);
      let persisted = 0;
      let index = 0;
      while (index < records.length) {
        const first = records[index]!;
        if (first.bytes > this.segmentBytes) {
          index++;
          if (first.bytes > this.totalBytes) continue;
          if (this.activeSize > 0) await this.rotateLocked();
          const stamp = this.now().toISOString().replace(/[^0-9]/g, "").slice(0, 17);
          const path = join(this.rootDir, `diagnostics-record-${stamp}-${this.role}-${process.pid}-${randomUUID()}.json`);
          const allowed = await pruneSegmentsLocked(this.rootDir, {
            maxAgeMs: this.maxAgeMs, maxSegments: this.maxSegments, totalBytes: this.totalBytes,
            reserveBytes: first.bytes, prospectivePath: path,
          });
          if (!allowed) continue;
          await writeDiagnosticRecordSidecar(path, first.line);
          persisted++;
          continue;
        }
        if (this.activeSize > 0 && this.activeSize + first.bytes > this.segmentBytes) await this.rotateLocked();
        const remaining = this.segmentBytes - this.activeSize;
        const chunk: SerializedRecord[] = [];
        let chunkBytes = 0;
        while (index < records.length && chunkBytes + records[index]!.bytes <= remaining) {
          chunk.push(records[index]!); chunkBytes += records[index]!.bytes; index++;
        }
        if (chunk.length === 0) { index++; continue; }
        const allowed = await pruneSegmentsLocked(this.rootDir, {
          maxAgeMs: this.maxAgeMs, maxSegments: this.maxSegments, totalBytes: this.totalBytes,
          reserveBytes: chunkBytes, prospectivePath: this.activePath,
        });
        if (!allowed) continue;
        const output = chunk.map(record => record.line).join("");
        if (chunk.some(record => record.durable)) {
          const handle = await open(this.activePath, "a", 0o600);
          try { await handle.writeFile(output); }
          finally { await handle.close(); }
        } else await appendFile(this.activePath, output, { mode: 0o600 });
        this.activeSize += chunkBytes;
        persisted += chunk.length;
      }
      await pruneSegmentsLocked(this.rootDir, {
        maxAgeMs: this.maxAgeMs, maxSegments: this.maxSegments, totalBytes: this.totalBytes,
        reserveBytes: 0, prospectivePath: this.activePath,
      });
      return persisted;
    });
  }

  private async rotateLocked(): Promise<void> {
    if (this.activeSize === 0) return;
    const stamp = this.now().toISOString().replace(/[^0-9]/g, "").slice(0, 17);
    const target = join(this.rootDir, `diagnostics-${stamp}-${this.role}-${process.pid}-${randomUUID()}.jsonl`);
    await rename(this.activePath, target);
    await chmod(target, 0o600);
    this.activeSize = 0;
  }

  private async refreshRetainedSize(): Promise<void> {
    const entries = await listSegments(this.rootDir);
    this.retainedBytes = entries.reduce((sum, entry) => sum + entry.size, 0);
    this.segmentCount = entries.length;
  }

  private statusValue(): DiagnosticsStatus & { timestamp: string; role: string; processInstanceId: string; pid: number } {
    return {
      ...this.status(), timestamp: this.now().toISOString(), role: this.role,
      processInstanceId: this.processInstanceId, pid: process.pid,
    };
  }

  private async persistStatus(): Promise<void> {
    if (!this.initialized || !this.statusPath) return;
    const temporary = this.statusPath + `.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(this.statusValue()) + "\n", { mode: 0o600, flag: "wx" });
    await rename(temporary, this.statusPath);
    await chmod(this.statusPath, 0o600);
  }

  private async disable(error: unknown): Promise<void> {
    if (this.disabled) return;
    this.disabled = true;
    this.lastError = diagnosticError(error);
    this.unavailableEvents += this.queue.length;
    this.queue.length = 0;
    for (const active of this.activeOperations.values()) clearTimeout(active.timer);
    this.activeOperations.clear();
    await this.persistStatus().catch(() => undefined);
    if (!this.fallbackReported && this.stderr) {
      this.fallbackReported = true;
      try { this.stderr.write(`Alder diagnostics unavailable: ${this.lastError.message}\n`); } catch {}
    }
  }

  async flush(): Promise<void> {
    if (this.flushTimer !== undefined) { clearTimeout(this.flushTimer); this.flushTimer = undefined; }
    if (this.disabled || this.queue.length === 0) return;
    const target = this.queue[this.queue.length - 1]!.sequence;
    const operation = this.drainTail.then(() => this.drainThrough(target));
    this.drainTail = operation.catch(() => undefined);
    await operation;
  }

  async flushDurable(): Promise<void> {
    try { await this.flush(); } catch (error) { await this.disable(error); }
  }

  async recordDurable(severity: DiagnosticSeverity, event: DiagnosticEvent, context: DiagnosticFields, fields: DiagnosticFields): Promise<void> {
    if (!this.disabled && !this.closed && this.queue.length >= this.queueLimit) await this.flushDurable();
    const sequence = this.enqueue(severity, event, context, fields, true);
    if (sequence !== null) await this.flushDurable();
  }

  async close(): Promise<void> {
    if (this.closed) { await this.drainTail; return; }
    this.closed = true;
    for (const active of this.activeOperations.values()) clearTimeout(active.timer);
    this.activeOperations.clear();
    await this.flush();
    if (this.initialized && !this.disabled && this.activeSize > 0) {
      await withDirectoryLock(this.rootDir, async () => {
        await this.rotateLocked();
        await pruneSegmentsLocked(this.rootDir, {
          maxAgeMs: this.maxAgeMs, maxSegments: this.maxSegments, totalBytes: this.totalBytes, reserveBytes: 0,
        });
      }).catch(error => this.disable(error));
      await this.refreshRetainedSize().catch(() => undefined);
      await this.persistStatus().catch(() => undefined);
    }
  }

  abandonQueued(): number {
    const count = this.queue.length;
    this.queue.length = 0;
    this.unavailableEvents += count;
    void this.persistStatus().catch(() => undefined);
    return count;
  }

  status(): DiagnosticsStatus {
    return {
      available: !this.disabled,
      degraded: this.disabled || this.droppedEvents > 0 || this.unavailableEvents > 0,
      generatedEvents: this.generatedEvents, acceptedEvents: this.acceptedEvents,
      persistedEvents: this.persistedEvents, droppedEvents: this.droppedEvents,
      unavailableEvents: this.unavailableEvents, queuedEvents: this.queue.length,
      currentSegmentBytes: this.activeSize, retainedBytes: this.retainedBytes,
      segmentCount: this.segmentCount, lastError: this.lastError, rootDir: this.rootDir,
    };
  }
}

export class StructuredDiagnostics implements DiagnosticSink {
  private readonly core: DiagnosticsCore;
  private readonly context: DiagnosticFields;
  constructor(options: DiagnosticsOptions, core?: DiagnosticsCore, context: DiagnosticFields = {}) {
    this.core = core ?? new DiagnosticsCore(options);
    this.context = context;
  }
  record(severity: DiagnosticSeverity, event: DiagnosticEvent, fields: DiagnosticFields = {}): void { this.core.enqueue(severity, event, this.context, fields); }
  async recordDurable(severity: DiagnosticSeverity, event: DiagnosticEvent, fields: DiagnosticFields = {}): Promise<void> {
    await this.core.recordDurable(severity, event, this.context, fields);
  }
  child(fields: DiagnosticFields): StructuredDiagnostics { return new StructuredDiagnostics({ rootDir: this.core.rootDir, role: this.core.role }, this.core, { ...this.context, ...fields }); }
  flush(): Promise<void> { return this.core.flush(); }
  close(): Promise<void> { return this.core.close(); }
  abandonQueued(): number { return this.core.abandonQueued(); }
  status(): DiagnosticsStatus { return this.core.status(); }
}

export async function persistEmergencyDiagnostic(options: {
  rootDir: string;
  role: DiagnosticsOptions["role"];
  component?: string;
  event: DiagnosticEvent;
  fields?: DiagnosticFields;
  appLaunchId?: string;
  now?: () => Date;
}): Promise<string> {
  const rootDir = resolve(options.rootDir);
  await mkdir(rootDir, { recursive: true, mode: 0o700 });
  await chmod(rootDir, 0o700);
  const timestamp = (options.now ?? (() => new Date()))().toISOString();
  const value = {
    schemaVersion: DIAGNOSTIC_SCHEMA_VERSION,
    timestamp,
    severity: "error" as const,
    component: options.component ?? options.role,
    event: options.event,
    process: { role: options.role, instanceId: randomUUID(), pid: process.pid },
    appLaunchId: options.appLaunchId ?? process.env.ALDER_APP_LAUNCH_ID ?? null,
    processContext: diagnosticProcessContext(),
    ...(diagnosticValue(options.fields ?? {}) as Record<string, unknown>),
    durable: true,
  };
  const path = join(rootDir, `diagnostics-emergency-${options.role}-${process.pid}-${randomUUID()}.jsonl`);
  const handle = await open(path, "wx", 0o600);
  try { await handle.writeFile(JSON.stringify(value) + "\n"); await handle.sync(); }
  finally { await handle.close(); }
  const directory = await open(rootDir, "r");
  try { await directory.sync(); } finally { await directory.close(); }
  return path;
}

async function withDirectoryLock<T>(rootDir: string, action: () => Promise<T>): Promise<T> {
  await mkdir(rootDir, { recursive: true, mode: 0o700 });
  const lock = join(rootDir, ".retention-lock");
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (true) {
    try {
      const handle = await open(lock, "wx", 0o600);
      try { await handle.writeFile(String(process.pid)); }
      finally { await handle.close(); }
      break;
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const info = await stat(lock).catch(() => null);
      const ownerPid = await readFile(lock, "utf8").then(value => Number(value.trim()), () => Number.NaN);
      const deadOwner = Number.isSafeInteger(ownerPid) && ownerPid > 0 && !pidAlive(ownerPid);
      const invalidOwner = (!Number.isSafeInteger(ownerPid) || ownerPid <= 0) && info !== null && Date.now() - info.mtimeMs > 250;
      if (deadOwner || invalidOwner || (info && Date.now() - info.mtimeMs > LOCK_STALE_MS)) {
        await unlink(lock).catch(unlinkError => { if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT") throw unlinkError; });
        continue;
      }
      if (Date.now() >= deadline) throw Object.assign(new Error("diagnostic retention lock timed out"), { code: "EIO" });
      await new Promise(resolveWait => setTimeout(resolveWait, 10));
    }
  }
  try { return await action(); }
  finally { await unlink(lock).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }); }
}

function segmentInfo(name: string): { active: boolean; pid: number | null; format: "jsonl" | "record" } | null {
  if (/^diagnostics-record-.*\.json$/.test(name)) return { active: false, pid: null, format: "record" };
  if (!/^diagnostics-.*\.jsonl$/.test(name)) return null;
  const match = /^diagnostics-active-[a-z]+-(\d+)-.*\.jsonl$/.exec(name);
  return { active: match !== null, pid: match ? Number(match[1]) : null, format: "jsonl" };
}
function pidAlive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }
function recordTemporaryOwner(name: string): number | null {
  const match = /^diagnostics-record-[0-9]+-(?:desktop|backend|host|renderer|cli)-(\d+)-[0-9a-f-]+\.json\.[0-9a-f-]+\.tmp$/.exec(name);
  return match ? Number(match[1]) : null;
}
async function removeDeadRecordTemporaries(rootDir: string): Promise<void> {
  let names: string[];
  try { names = await readdir(rootDir); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  for (const name of names) {
    const owner = recordTemporaryOwner(name);
    if (owner === null || owner === process.pid || pidAlive(owner)) continue;
    await rm(join(rootDir, name), { force: true });
  }
}

async function listRecordTemporaries(rootDir: string): Promise<RecordTemporaryEntry[]> {
  let names: string[];
  try { names = await readdir(rootDir); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  const entries: RecordTemporaryEntry[] = [];
  for (const name of names) {
    const owner = recordTemporaryOwner(name);
    if (owner === null) continue;
    try {
      const info = await lstat(join(rootDir, name));
      if (info.isFile()) entries.push({ size: info.size, ownerAlive: owner === process.pid || pidAlive(owner) });
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return entries;
}

export async function writeDiagnosticRecordSidecar(path: string, contents: string): Promise<void> {
  const temporary = path + `.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let committed = false;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(contents);
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
    committed = true;
    await chmod(path, 0o600);
  } finally {
    await handle?.close().catch(() => undefined);
    if (!committed) await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function listSegments(rootDir: string): Promise<SegmentEntry[]> {
  let names: string[];
  try { names = await readdir(rootDir); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  const entries: SegmentEntry[] = [];
  for (const name of names) {
    const parsed = segmentInfo(name); if (!parsed) continue;
    const path = join(rootDir, name);
    try { const info = await stat(path); entries.push({ path, name, size: info.size, mtimeMs: info.mtimeMs, ...parsed }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return entries;
}
async function normalizeDeadActiveSegments(rootDir: string): Promise<void> {
  await removeDeadRecordTemporaries(rootDir);
  for (const entry of await listSegments(rootDir)) {
    if (!entry.active || entry.pid === null || entry.pid === process.pid || pidAlive(entry.pid)) continue;
    const target = join(rootDir, `diagnostics-recovered-${Date.now()}-${randomUUID()}.jsonl`);
    await rename(entry.path, target).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; });
  }
}
async function pruneSegmentsLocked(rootDir: string, options: {
  maxAgeMs: number; maxSegments: number; totalBytes: number; reserveBytes: number; prospectivePath?: string;
}): Promise<boolean> {
  await removeDeadRecordTemporaries(rootDir);
  const now = Date.now();
  let entries = await listSegments(rootDir);
  for (const entry of entries.filter(item => !item.active && now - item.mtimeMs > options.maxAgeMs)) await rm(entry.path, { force: true });
  entries = await listSegments(rootDir);
  const prospectiveExists = options.prospectivePath ? entries.some(entry => resolve(entry.path) === resolve(options.prospectivePath!)) : true;
  const addedCount = options.reserveBytes > 0 && !prospectiveExists ? 1 : 0;
  const removable = entries.filter(entry => !entry.active).sort((a, b) => a.mtimeMs - b.mtimeMs);
  let total = entries.reduce((sum, entry) => sum + entry.size, 0);
  let count = entries.length;
  while ((total + options.reserveBytes > options.totalBytes || count + addedCount > options.maxSegments) && removable.length > 0) {
    const entry = removable.shift()!; await rm(entry.path, { force: true }); total -= entry.size; count--;
  }
  await pruneStatusFiles(rootDir, options.maxAgeMs);
  return total + options.reserveBytes <= options.totalBytes && count + addedCount <= options.maxSegments;
}

async function pruneStatusFiles(rootDir: string, maxAgeMs: number): Promise<void> {
  const names = (await readdir(rootDir)).filter(name => /^diagnostics-status-.*\.json$/.test(name));
  const entries = (await Promise.all(names.map(async name => ({ name, info: await stat(join(rootDir, name)) })))).sort((a, b) => b.info.mtimeMs - a.info.mtimeMs);
  const now = Date.now();
  for (let index = 0; index < entries.length; index++) {
    if (index < 64 && now - entries[index]!.info.mtimeMs <= maxAgeMs) continue;
    await rm(join(rootDir, entries[index]!.name), { force: true });
  }
}

export interface DiagnosticBundleContext {
  appVersion?: string;
  buildId?: string;
  runtime?: DiagnosticFields;
  state?: DiagnosticFields;
  recoveryRoot?: string;
  artifactRoot?: string;
  cacheRoot?: string;
  flushPeers?: () => Promise<void>;
}
export async function exportDiagnosticBundle(diagnostics: StructuredDiagnostics, destination: string, context: DiagnosticBundleContext = {}): Promise<{ path: string; files: number; bytes: number }> {
  await diagnostics.flush();
  await context.flushPeers?.();
  await diagnostics.flush();
  const target = resolve(destination);
  await mkdir(target, { recursive: false, mode: 0o700 });
  try {
    await chmod(target, 0o700);
    const logsDir = join(target, "logs"); await mkdir(logsDir, { mode: 0o700 });
    let copiedBytes = 0, copiedFiles = 0;
    const entries = (await listSegments(diagnostics.status().rootDir)).sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const entry of entries) {
      if (copiedBytes + entry.size > DIAGNOSTIC_TOTAL_BYTES) break;
      const output = join(logsDir, basename(entry.name)); await copyFile(entry.path, output); await chmod(output, 0o600);
      copiedBytes += entry.size; copiedFiles++;
    }
    const manifest = {
      schemaVersion: DIAGNOSTIC_SCHEMA_VERSION,
      timestamp: new Date().toISOString(),
      appVersion: context.appVersion ?? "unknown",
      buildId: context.buildId ?? "unknown",
      platform: platform(), arch: arch(), runtimeVersion: process.version,
      diagnostics: diagnostics.status(),
      runtime: diagnosticValue(context.runtime ?? {}),
      state: diagnosticValue(context.state ?? {}),
      resources: {
        process: diagnosticProcessContext(), diagnosticBytes: copiedBytes,
        recovery: await boundedDirectorySize(context.recoveryRoot),
        artifacts: await boundedDirectorySize(context.artifactRoot), cache: await boundedDirectorySize(context.cacheRoot),
      },
      format: "raw full-fidelity Alder diagnostics; no fields are redacted or pseudonymized",
    };
    await writePrivate(join(target, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
    return { path: target, files: copiedFiles + 1, bytes: copiedBytes };
  } catch (error) { await rm(target, { recursive: true, force: true }); throw error; }
}

export type DiagnosticQuery = "status" | "launches" | "errors" | "operations" | "performance" | "incident";
export interface DiagnosticQueryOptions {
  rootDir?: string;
  limit?: number;
  since?: string;
  until?: string;
  id?: string;
  slowMs?: number;
}

interface ReadStoreResult { records: Record<string, unknown>[]; malformedRecords: number; scannedRecords: number; examinedRecords: number; truncated: boolean; }

function diagnosticQueryRange(options: DiagnosticQueryOptions): { since: number; until: number } {
  const since = options.since === undefined ? Number.NEGATIVE_INFINITY : Date.parse(options.since);
  const until = options.until === undefined ? Number.POSITIVE_INFINITY : Date.parse(options.until);
  if (!Number.isFinite(since) && since !== Number.NEGATIVE_INFINITY) throw new Error("--since must be a valid ISO timestamp");
  if (!Number.isFinite(until) && until !== Number.POSITIVE_INFINITY) throw new Error("--until must be a valid ISO timestamp");
  if (since > until) throw new Error("--since must not be later than --until");
  return { since, until };
}

async function readStore(rootDir: string, options: DiagnosticQueryOptions): Promise<ReadStoreResult> {
  const { since, until } = diagnosticQueryRange(options);
  const records: Record<string, unknown>[] = [];
  let malformedRecords = 0, scannedRecords = 0, examinedRecords = 0, truncated = false;
  const entries = (await listSegments(rootDir)).sort((a, b) => b.mtimeMs - a.mtimeMs);
  outer: for (const entry of entries) {
    if (entry.mtimeMs < since) continue;
    let contents: string;
    try { contents = await readFile(entry.path, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (options.id !== undefined && !contents.includes(JSON.stringify(options.id))) continue;
    const lines = entry.format === "record" ? [contents] : contents.split("\n").reverse();
    for (const line of lines) {
      if (!line.trim()) continue;
      examinedRecords++;
      let record: unknown;
      try { record = JSON.parse(line); } catch { malformedRecords++; continue; }
      if (!isRecord(record) || typeof record.timestamp !== "string") { malformedRecords++; continue; }
      const timestamp = Date.parse(record.timestamp);
      if (!Number.isFinite(timestamp) || timestamp < since || timestamp > until) continue;
      if (options.id !== undefined && !containsExact(record, options.id)) continue;
      if (scannedRecords >= QUERY_RECORD_LIMIT) { truncated = true; break outer; }
      scannedRecords++;
      records.push(record);
    }
  }
  records.sort(compareRecords);
  return { records, malformedRecords, scannedRecords, examinedRecords, truncated };
}

function compareRecords(a: Record<string, unknown>, b: Record<string, unknown>): number {
  return String(a.timestamp).localeCompare(String(b.timestamp))
    || String((a.process as Record<string, unknown> | undefined)?.instanceId ?? "").localeCompare(String((b.process as Record<string, unknown> | undefined)?.instanceId ?? ""))
    || Number(a.eventSequence ?? 0) - Number(b.eventSequence ?? 0);
}

function containsExact(value: unknown, target: string, seen = new Set<unknown>()): boolean {
  if (value === target) return true;
  if (value === null || typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some(item => containsExact(item, target, seen));
  return Object.values(value as Record<string, unknown>).some(item => containsExact(item, target, seen));
}

function limited<T>(values: readonly T[], limit: number): T[] { return values.slice(Math.max(0, values.length - limit)); }

export async function queryDiagnostics(query: DiagnosticQuery, options: DiagnosticQueryOptions = {}): Promise<Record<string, unknown>> {
  diagnosticQueryRange(options);
  const rootDir = resolve(options.rootDir ?? diagnosticsRoot());
  const limit = Math.max(1, Math.min(10_000, options.limit ?? 100));
  const rootInfo = await stat(rootDir).catch(() => null);
  const storeAvailable = rootInfo?.isDirectory() === true;
  const entries = await listSegments(rootDir).catch(() => []);
  const queryableBytes = entries.reduce((sum, entry) => sum + entry.size, 0);
  const temporaries = query === "status" ? await listRecordTemporaries(rootDir).catch(() => []) : [];
  const liveTemporaries = temporaries.filter(entry => entry.ownerAlive);
  const orphanTemporaries = temporaries.filter(entry => !entry.ownerAlive);
  const liveTemporaryBytes = liveTemporaries.reduce((sum, entry) => sum + entry.size, 0);
  const orphanTemporaryBytes = orphanTemporaries.reduce((sum, entry) => sum + entry.size, 0);
  const retainedBytes = queryableBytes + orphanTemporaryBytes;
  const statusFiles = await readStatuses(rootDir);
  const base = {
    schemaVersion: DIAGNOSTIC_SCHEMA_VERSION, query, rootDir, retainedBytes,
    segmentCount: entries.length, activeWriters: entries.filter(entry => entry.active && entry.pid !== null && pidAlive(entry.pid)).length,
    ...(query === "status" ? {
      queryableBytes, retainedFileCount: entries.length + orphanTemporaries.length,
      orphanTemporaryCount: orphanTemporaries.length, orphanTemporaryBytes,
      liveTemporaryCount: liveTemporaries.length, liveTemporaryBytes,
      incompleteTemporaryCount: temporaries.length, incompleteTemporaryBytes: orphanTemporaryBytes + liveTemporaryBytes,
    } : {}),
    statuses: statusFiles,
  };
  const store = await readStore(rootDir, query === "incident" ? options : { ...options, id: undefined }).catch(error => ({ records: [], malformedRecords: 0, scannedRecords: 0, examinedRecords: 0, truncated: false, readError: diagnosticError(error) }));
  const metadata = {
    ...base, scannedRecords: store.scannedRecords, examinedRecords: store.examinedRecords, malformedRecords: store.malformedRecords,
    truncated: store.truncated, ...("readError" in store ? { readError: store.readError } : {}),
  };
  if (query === "status") {
    const droppedRecords = statusFiles.reduce((sum, status) => sum + Number(status.droppedEvents ?? 0) + Number(status.unavailableEvents ?? 0), 0);
    return { ...metadata, available: storeAvailable && !("readError" in store), degraded: !storeAvailable || orphanTemporaries.length > 0 || droppedRecords > 0 || store.malformedRecords > 0 || statusFiles.some(status => status.available === false), droppedRecords };
  }
  const records = store.records;
  if (query === "launches") {
    return { ...metadata, records: limited(records.filter(record => ["desktop.launch", "backend.launch", "host.launch", "backend.session.open", "window.open"].includes(String(record.event))), limit) };
  }
  if (query === "errors") {
    return { ...metadata, records: limited(records.filter(record => record.severity === "error" || record.outcome === "error" || /(?:fatal|failure|failed|uncaught|unhandled)/.test(String(record.event))), limit) };
  }
  if (query === "incident") {
    return { ...metadata, records: limited(records, limit) };
  }
  if (query === "operations") {
    const byId = new Map<string, { accepted?: Record<string, unknown>; terminal?: Record<string, unknown>; timing?: Record<string, unknown>; slow?: Record<string, unknown> }>();
    for (const record of records) {
      if (typeof record.operationId !== "string") continue;
      const key = [record.appLaunchId, record.backendInstanceId, record.sessionEpoch ?? record.sessionId, record.clientId ?? "internal", record.operationId].map(value => String(value ?? "")).join("\0");
      const item = byId.get(key) ?? {};
      if (record.event === "operation.accepted") item.accepted = record;
      else if (TERMINAL_EVENTS.has(String(record.event))) item.terminal = record;
      else if (record.event === "operation.timing") item.timing = record;
      else if (record.event === "operation.slow") item.slow = record;
      byId.set(key, item);
    }
    const slowMs = options.slowMs ?? 5_000;
    const operations = [...byId.values()].filter(item => item.accepted && (!item.terminal || item.slow || Number(item.terminal?.durationMs ?? item.timing?.durationMs ?? 0) >= slowMs));
    return { ...metadata, slowMs, operations: limited(operations, limit) };
  }
  const durations = new Map<string, number[]>();
  for (const record of records) {
    if (typeof record.durationMs !== "number") continue;
    const key = String(record.kind ?? record.event ?? "unknown");
    const values = durations.get(key) ?? []; values.push(record.durationMs); durations.set(key, values);
  }
  const summaries = [...durations].map(([kind, values]) => {
    values.sort((a, b) => a - b);
    return { kind, count: values.length, minMs: values[0], medianMs: values[Math.floor(values.length / 2)], p95Ms: values[Math.min(values.length - 1, Math.floor(values.length * 0.95))], maxMs: values.at(-1) };
  });
  const resources = records.filter(record => record.event === "diagnostic.resource" || record.processContext !== undefined);
  return { ...metadata, summaries, recentResources: limited(resources, Math.min(limit, 20)) };
}

async function readStatuses(rootDir: string): Promise<Record<string, unknown>[]> {
  let names: string[];
  try { names = (await readdir(rootDir)).filter(name => /^diagnostics-status-.*\.json$/.test(name)); }
  catch { return []; }
  const statuses: Record<string, unknown>[] = [];
  for (const name of names) {
    try { const value = JSON.parse(await readFile(join(rootDir, name), "utf8")); if (isRecord(value)) statuses.push(value); } catch {}
  }
  return statuses.sort((a, b) => String(a.timestamp ?? "").localeCompare(String(b.timestamp ?? "")));
}

async function writePrivate(path: string, value: string): Promise<void> { await writeFile(path, value, { mode: 0o600, flag: "wx" }); await chmod(path, 0o600); }
export async function boundedDirectorySize(path: string | undefined, options: { maxEntries?: number; timeoutMs?: number } = {}): Promise<{ bytes: number | null; entries: number; truncated: boolean; unknown: boolean }> {
  if (!path) return { bytes: null, entries: 0, truncated: false, unknown: true };
  const maxEntries = options.maxEntries ?? 10_000, deadline = performance.now() + (options.timeoutMs ?? 500);
  let bytes = 0, entries = 0; const pending = [resolve(path)];
  try {
    while (pending.length) {
      if (entries >= maxEntries || performance.now() >= deadline) return { bytes, entries, truncated: true, unknown: false };
      const current = pending.pop()!, info = await stat(current); entries++;
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) for (const name of await readdir(current)) pending.push(join(current, name)); else if (info.isFile()) bytes += info.size;
    }
    return { bytes, entries, truncated: false, unknown: false };
  } catch { return { bytes: null, entries, truncated: false, unknown: true }; }
}
export async function pruneCorruptRecoveryCopies(directory: string, options: { retain?: number; maxAgeMs?: number } = {}): Promise<number> {
  const retain = options.retain ?? 5, maxAgeMs = options.maxAgeMs ?? 30 * 24 * 60 * 60 * 1000;
  let names: string[];
  try { names = (await readdir(directory)).filter(name => /^corrupt-.*\.json$/.test(name)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0; throw error; }
  const now = Date.now();
  const entries = (await Promise.all(names.map(async name => ({ name, info: await stat(join(directory, name)) })))).sort((a, b) => b.info.mtimeMs - a.info.mtimeMs);
  let removed = 0;
  for (let index = 0; index < entries.length; index++) {
    if (index < Math.min(3, retain)) continue;
    if (index < retain && now - entries[index]!.info.mtimeMs <= maxAgeMs) continue;
    await rm(join(directory, entries[index]!.name), { force: true }); removed++;
  }
  return removed;
}
export async function drainDiagnosticsBounded(diagnostics: StructuredDiagnostics, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>(resolveTimeout => { timer = setTimeout(() => resolveTimeout(false), timeoutMs); });
  const drained = diagnostics.flush().then(() => true as const, () => false as const);
  const result = await Promise.race([drained, timeout]);
  if (timer) clearTimeout(timer);
  if (!result) diagnostics.abandonQueued();
  return result;
}

function isRecord(value: unknown): value is Record<string, any> { return value !== null && typeof value === "object" && !Array.isArray(value); }

import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { appendFile, chmod, copyFile, link, mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { arch, platform } from "node:os";
import { basename, join, resolve } from "node:path";

export const DIAGNOSTIC_SCHEMA_VERSION = 1;
export const DIAGNOSTIC_SEGMENT_BYTES = 5 * 1024 * 1024;
export const DIAGNOSTIC_TOTAL_BYTES = 25 * 1024 * 1024;
export const DIAGNOSTIC_MAX_SEGMENTS = 5;
export const DIAGNOSTIC_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const DIAGNOSTIC_QUEUE_LIMIT = 2_048;
const DIAGNOSTIC_BATCH_SIZE = 128;
const LOCK_WAIT_MS = 2_000;
const LOCK_STALE_MS = 30_000;

export type DiagnosticSeverity = "debug" | "info" | "warn" | "error";
export type DiagnosticScalar = string | number | boolean | null;
export type DiagnosticFields = Readonly<Record<string, DiagnosticScalar | readonly DiagnosticScalar[]>>;
export const DIAGNOSTIC_EVENTS = [
  "backend.close.summary", "backend.fatal", "backend.forced_exit", "backend.launch", "backend.session.open", "backend.stop",
  "backend.uncaught_exception", "backend.unhandled_rejection", "boundary.rejected", "child.cancel", "child.cleanup_failed",
  "child.exit", "child.kill", "child.spawn", "child.term", "desktop.fatal", "desktop.launch", "desktop.quit",
  "desktop.uncaught_exception", "desktop.unhandled_rejection", "diagnostic.unknown_event", "host.action_failure", "host.fatal",
  "host.launch", "host.ready", "host.stop.settled", "host.stop.started", "lsp.failure", "lsp.ready", "lsp.start", "lsp.stop",
  "mcp.endpoint.closed", "mcp.endpoint.ready", "mcp.request.error", "mcp.session.closed", "mcp.session.error", "mcp.session.opened",
  "native_command.timeout", "operation.accepted", "operation.cancelled", "operation.failed", "operation.phase", "operation.progress",
  "operation.settled", "operation.slow", "operation.started", "operation.timing", "persistence.conflict", "persistence.failure",
  "persistence.recovery_flushed", "process_scope.cleanup_failed", "r.environment.ready", "r.runtime.failure", "r.runtime.ready",
  "r.runtime.restart", "r.runtime.start", "renderer.bootstrap_failed", "renderer.error", "renderer.gone", "renderer.load_failed",
  "renderer.ready", "renderer.recovered", "renderer.recovery_failed", "renderer.responsive", "renderer.unhandled_rejection",
  "renderer.unresponsive", "run.visible", "save.clean_state", "save.source_published", "window.close", "window.open",
] as const;
export type DiagnosticEvent = typeof DIAGNOSTIC_EVENTS[number];
export interface DiagnosticSink {
  record(severity: DiagnosticSeverity, event: DiagnosticEvent, fields?: DiagnosticFields): void;
  child(fields: DiagnosticFields): DiagnosticSink;
  flush?(): Promise<void>;
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
  generatedEvents: number;
  acceptedEvents: number;
  persistedEvents: number;
  droppedEvents: number;
  unavailableEvents: number;
  queuedEvents: number;
  currentSegmentBytes: number;
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
}
interface SerializedRecord { readonly line: string; readonly bytes: number; }
interface ActiveOperation {
  readonly operationId: string;
  readonly clientId: string;
  readonly kind: string;
  readonly startedAt: number;
  lastProgressAt: number;
  readonly phases: Set<string>;
  readonly timer: NodeJS.Timeout;
}
interface SegmentEntry { path: string; name: string; size: number; mtimeMs: number; active: boolean; pid: number | null; }

const FIELD_NAMES = new Set([
  "appLaunchId", "backendInstanceId", "sessionId", "sessionEpoch", "documentId", "clientId",
  "operationId", "runId", "cellId", "childInstanceId", "childRole", "childPid", "windowId",
  "requestId", "eventSequence", "documentRevision", "cellRevision", "outputGeneration", "phase",
  "kind", "mimeFamily", "outcome", "status", "reason", "errorCode", "errorType", "durationMs",
  "queueMs", "analysisMs", "dispatchMs", "firstOutputMs", "completionMs", "visibleMs", "bytes",
  "count", "dropped", "forced", "cold", "ready", "dirty", "conflict", "truncated", "unknown",
  "missingPhases", "notApplicablePhases", "observedPhases", "version", "runtimeVersion", "os", "arch", "signal", "exitCode", "lastProgressMs",
  "activeOperationCount", "activeRunId", "kernelState", "analyzerState", "executionReady", "processCount",
  "rssBytes", "cpuUserMicros", "cpuSystemMicros", "diagnosticBytes", "recoveryBytes", "artifactBytes",
  "cacheBytes", "elapsedMs", "thresholdMs", "rendererGeneration", "mode",
]);
const ID_FIELDS = new Set([
  "appLaunchId", "backendInstanceId", "sessionId", "sessionEpoch", "documentId", "clientId", "operationId",
  "runId", "cellId", "childInstanceId", "windowId", "requestId", "activeRunId",
]);
const NUMERIC_FIELDS = new Set([
  "eventSequence", "documentRevision", "cellRevision", "outputGeneration", "durationMs", "queueMs", "analysisMs",
  "dispatchMs", "firstOutputMs", "completionMs", "visibleMs", "bytes", "count", "dropped", "exitCode",
  "lastProgressMs", "activeOperationCount", "processCount", "rssBytes", "cpuUserMicros", "cpuSystemMicros",
  "diagnosticBytes", "recoveryBytes", "artifactBytes", "cacheBytes", "elapsedMs", "thresholdMs", "rendererGeneration", "childPid",
]);
const BOOLEAN_FIELDS = new Set(["forced", "cold", "ready", "dirty", "conflict", "truncated", "unknown", "executionReady"]);
const SAFE_CATEGORIES = new Set([
  "success", "error", "cancelled", "started", "settled", "running", "queued", "done", "failed", "other", "unknown", "none",
  "transaction", "save", "save-as", "run", "restart", "format", "publish", "packages-install", "inspect", "widget", "output", "artifact", "upload", "query", "mcp", "request", "shutdown", "stop", "set-config", "set-layout", "set-runtime", "set-app", "reload-source", "cancel-operation", "interrupt", "lazy-output", "table-page",
  "analysis", "analysis-ready", "analysis-not-applicable", "kernel-dispatch", "first-output", "first-output-not-applicable", "kernel-completion", "authoritative-completion", "visible-result", "terminal", "recovery-flush", "authoritative-ack", "publication", "clean", "environment", "startup", "first-progress", "persistence",
  "text", "image", "audio", "video", "application", "multipart", "binary", "html", "json", "pdf",
  "idle", "ready", "starting", "stopping", "unavailable", "blocked", "active", "available",
  "sigterm", "sigkill", "sigint", "clean-exit", "abnormal-exit", "killed", "crashed", "oom", "launch-failed", "integrity-failure",
  "script-error", "unhandled-rejection", "bootstrap-failed", "load-failed", "unresponsive", "responsive",
  "two-animation-frames", "emergency",
  "desktop", "backend", "host", "renderer", "cli", "node", "r", "rscript", "ark", "air", "quarto", "child",
  "darwin", "linux", "win32", "arm64", "x64",
]);
const SAFE_ERROR_CODES = new Set([
  "cancelled", "internal_error", "unknown", "other", "backend_fatal", "desktop_start_failed", "uncaught_exception", "unhandled_rejection",
  "close_timeout", "command_timeout", "lease_release_timeout", "lease_release_failed", "renderer_recovery_failed", "renderer_bootstrap_failed",
  "child_exit_failed", "child_cleanup_failed", "ordinary_exit_cleanup_failed", "process_cleanup_failed", "host_start_failed", "r_environment_failed", "r_start_failed", "lsp_unavailable",
  "source_conflict", "source_write_failed", "recovery_checkpoint_failed", "sidecar_write_failed", "operation_in_progress", "publish_timeout", "publish_failed",
  "invalid_request", "not_found", "payload_too_large", "unsupported_media_type", "stale_value", "output_expired", "output_invalid", "output_quota", "service_unavailable",
  "mcp_initialize_failed", "mcp_internal_error", "session_compromised", "watcher_failed", "recovery_conflict", "ENOENT", "EACCES", "EPERM", "ENOSPC", "EIO",
]);
const SAFE_ERROR_TYPES = new Set(["Error", "TypeError", "RangeError", "AggregateError", "ControllerError", "PublishingError", "ZodError"]);
const TERMINAL_EVENTS = new Set(["operation.settled", "operation.cancelled", "operation.failed"]);
const SAFE_EVENTS: ReadonlySet<string> = new Set(DIAGNOSTIC_EVENTS);
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
  private activeSize = 0;
  private hmacKey?: Buffer;
  private eventSequence = 0;
  generatedEvents = 0;
  acceptedEvents = 0;
  persistedEvents = 0;
  droppedEvents = 0;
  unavailableEvents = 0;

  constructor(options: DiagnosticsOptions) {
    this.rootDir = resolve(options.rootDir);
    this.role = options.role;
    this.component = SAFE_CATEGORIES.has(options.component ?? "") ? options.component! : options.role;
    this.appLaunchId = options.appLaunchId ?? randomUUID();
    this.backendInstanceId = options.backendInstanceId;
    this.processInstanceId = options.processInstanceId ?? randomUUID();
    this.appVersion = safeVersion(options.appVersion);
    this.buildId = safeVersion(options.buildId);
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

  enqueue(severity: DiagnosticSeverity, event: DiagnosticEvent, context: DiagnosticFields, fields: DiagnosticFields): void {
    this.generatedEvents++;
    if (this.disabled || this.closed) { this.unavailableEvents++; return; }
    if (!/^[a-z][a-z0-9_.-]{1,79}$/.test(event)) { this.droppedEvents++; return; }
    const admitted = this.queue.length < this.queueLimit;
    if (admitted) {
      const sequence = ++this.eventSequence;
      this.queue.push({
        sequence, timestamp: this.now().toISOString(), monotonicMs: Math.round(this.monotonicNow() * 1000) / 1000,
        severity, event, context, fields,
      });
      this.acceptedEvents++;
    } else this.droppedEvents++;
    this.observeOperation(event, { ...context, ...fields });
    if (admitted) this.scheduleFlush(this.queue.length >= 64 ? 0 : this.flushDelayMs);
  }

  private operationKey(fields: DiagnosticFields): string | null {
    const operationId = typeof fields.operationId === "string" ? fields.operationId : null;
    if (!operationId) return null;
    const clientId = typeof fields.clientId === "string" ? fields.clientId : "internal";
    return clientId + "\0" + operationId;
  }

  private observeOperation(event: DiagnosticEvent, fields: DiagnosticFields): void {
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
          operationId, clientId, kind: active.kind, thresholdMs: threshold,
          durationMs: Math.round(this.monotonicNow() - active.startedAt),
          lastProgressMs: Math.round(this.monotonicNow() - active.lastProgressAt),
        });
      }, threshold);
      timer.unref?.();
      this.activeOperations.set(key, { operationId, clientId, kind, startedAt, lastProgressAt: startedAt, phases: new Set(), timer });
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
    const notApplicable = Array.isArray(fields.notApplicablePhases)
      ? fields.notApplicablePhases.filter((value): value is string => typeof value === "string") : [];
    this.activeOperations.delete(key);
    this.enqueue("info", "operation.timing", {}, {
      operationId: active.operationId, clientId: active.clientId, kind: active.kind,
      outcome: event === "operation.settled" ? "success" : event === "operation.cancelled" ? "cancelled" : "error",
      durationMs: Math.round(this.monotonicNow() - active.startedAt),
      observedPhases: [...active.phases], notApplicablePhases: notApplicable,
      missingPhases: expected.filter(phase => !active.phases.has(phase) && !notApplicable.includes(phase)),
    });
  }

  private scheduleFlush(delay: number): void {
    if (this.flushTimer !== undefined || this.closed || this.disabled) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      void this.flush().catch(() => undefined);
    }, delay);
    this.flushTimer.unref?.();
  }

  private async initialize(): Promise<void> {
    if (this.initialized) return;
    await mkdir(this.rootDir, { recursive: true, mode: 0o700 });
    await chmod(this.rootDir, 0o700);
    this.hmacKey = await loadOrCreateKey(this.rootDir);
    this.activePath = join(this.rootDir, `diagnostics-active-${this.role}-${process.pid}-${this.processInstanceId}.jsonl`);
    this.activeSize = await stat(this.activePath).then(info => info.size, error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
      throw error;
    });
    await chmod(this.activePath, 0o600).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
    this.initialized = true;
  }

  async hashIdentity(value: string): Promise<string> {
    try {
      await this.initialize();
      return pseudonym(this.hmacKey!, value);
    } catch (error) {
      this.disable(error);
      return "id-unavailable";
    }
  }

  private serialize(record: QueuedRecord): SerializedRecord {
    const key = this.hmacKey!;
    const value = {
      schemaVersion: DIAGNOSTIC_SCHEMA_VERSION,
      timestamp: record.timestamp,
      monotonicMs: record.monotonicMs,
      severity: record.severity,
      component: this.component,
      event: SAFE_EVENTS.has(record.event) ? record.event : "diagnostic.unknown_event",
      appVersion: this.appVersion,
      buildId: this.buildId,
      process: { role: this.role, instanceId: pseudonym(key, this.processInstanceId), pid: process.pid },
      appLaunchId: pseudonym(key, this.appLaunchId),
      eventSequence: record.sequence,
      ...(this.backendInstanceId ? { backendInstanceId: pseudonym(key, this.backendInstanceId) } : {}),
      ...sanitizeFields(record.context, key),
      ...sanitizeFields(record.fields, key),
    };
    const line = JSON.stringify(value) + "\n";
    return { line, bytes: Buffer.byteLength(line) };
  }

  private async drainThrough(targetSequence: number): Promise<void> {
    if (this.disabled) return;
    try { await this.initialize(); }
    catch (error) { this.disable(error); return; }
    while (this.queue.length > 0 && this.queue[0]!.sequence <= targetSequence) {
      const raw = this.queue.slice(0, DIAGNOSTIC_BATCH_SIZE).filter(record => record.sequence <= targetSequence);
      if (raw.length === 0) break;
      const serialized = raw.map(record => this.serialize(record));
      let persisted = 0;
      try { persisted = await this.appendRecords(serialized); }
      catch (error) { this.disable(error); return; }
      this.queue.splice(0, raw.length);
      this.persistedEvents += persisted;
      this.droppedEvents += raw.length - persisted;
    }
  }

  private async appendRecords(records: readonly SerializedRecord[]): Promise<number> {
    return withDirectoryLock(this.rootDir, async () => {
      await normalizeDeadActiveSegments(this.rootDir);
      let persisted = 0;
      let index = 0;
      while (index < records.length) {
        const first = records[index]!;
        if (first.bytes > this.segmentBytes || first.bytes > this.totalBytes) { index++; continue; }
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
        await appendFile(this.activePath, chunk.map(record => record.line).join(""), { mode: 0o600 });
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

  private disable(error: unknown): void {
    if (this.disabled) return;
    this.disabled = true;
    this.unavailableEvents += this.queue.length;
    this.queue.length = 0;
    for (const active of this.activeOperations.values()) clearTimeout(active.timer);
    this.activeOperations.clear();
    if (!this.fallbackReported && this.stderr) {
      this.fallbackReported = true;
      try { this.stderr.write(`Alder diagnostics unavailable (${fixedErrorCode(error)}).\n`); } catch {}
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
          maxAgeMs: this.maxAgeMs, maxSegments: this.maxSegments, totalBytes: this.totalBytes,
          reserveBytes: 0,
        });
      }).catch(error => this.disable(error));
    }
  }

  abandonQueued(): number {
    const count = this.queue.length;
    this.queue.length = 0;
    this.unavailableEvents += count;
    return count;
  }

  safeFields(fields: DiagnosticFields): Promise<Record<string, DiagnosticScalar | readonly DiagnosticScalar[]>> {
    return this.initialize().then(() => sanitizeFields(fields, this.hmacKey!));
  }

  status(): DiagnosticsStatus {
    return {
      available: !this.disabled,
      generatedEvents: this.generatedEvents,
      acceptedEvents: this.acceptedEvents,
      persistedEvents: this.persistedEvents,
      droppedEvents: this.droppedEvents,
      unavailableEvents: this.unavailableEvents,
      queuedEvents: this.queue.length,
      currentSegmentBytes: this.activeSize,
      rootDir: this.rootDir,
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
  child(fields: DiagnosticFields): StructuredDiagnostics { return new StructuredDiagnostics({ rootDir: this.core.rootDir, role: this.core.role }, this.core, { ...this.context, ...fields }); }
  hashIdentity(value: string): Promise<string> { return this.core.hashIdentity(value); }
  flush(): Promise<void> { return this.core.flush(); }
  close(): Promise<void> { return this.core.close(); }
  abandonQueued(): number { return this.core.abandonQueued(); }
  safeFields(fields: DiagnosticFields): Promise<Record<string, DiagnosticScalar | readonly DiagnosticScalar[]>> { return this.core.safeFields(fields); }
  status(): DiagnosticsStatus { return this.core.status(); }
}

function safeVersion(value: string | undefined): string {
  return value !== undefined && /^(?:[A-Za-z]+[ -])?\d+(?:\.\d+){0,3}(?:[-+][A-Za-z0-9.]+)?$/.test(value) ? value : "unknown";
}
function pseudonym(key: Buffer, value: string): string { return "id-" + createHmac("sha256", key).update(value).digest("hex").slice(0, 24); }
function safeCategory(value: string): string { return SAFE_CATEGORIES.has(value.toLowerCase()) ? value.toLowerCase() : "other"; }
function safeErrorCode(value: string): string { return SAFE_ERROR_CODES.has(value) ? value : "other"; }
function safeErrorType(value: string): string { return SAFE_ERROR_TYPES.has(value) ? value : "other"; }

function sanitizeFields(fields: DiagnosticFields, key: Buffer): Record<string, DiagnosticScalar | readonly DiagnosticScalar[]> {
  const output: Record<string, DiagnosticScalar | readonly DiagnosticScalar[]> = {};
  for (const [name, raw] of Object.entries(fields)) {
    if (!FIELD_NAMES.has(name)) continue;
    if (Array.isArray(raw)) {
      output[name] = raw.slice(0, 32).map(value => typeof value === "string" ? safeCategory(value) : sanitizePrimitive(name, value, key));
    } else output[name] = sanitizePrimitive(name, raw as DiagnosticScalar, key);
  }
  return output;
}
function sanitizePrimitive(name: string, value: DiagnosticScalar, key: Buffer): DiagnosticScalar {
  if (value === null) return null;
  if (ID_FIELDS.has(name)) return pseudonym(key, String(value));
  if (NUMERIC_FIELDS.has(name)) return typeof value === "number" && Number.isFinite(value) ? value : null;
  if (BOOLEAN_FIELDS.has(name)) return typeof value === "boolean" ? value : null;
  if (name === "errorCode") return typeof value === "string" ? safeErrorCode(value) : "other";
  if (name === "errorType") return typeof value === "string" ? safeErrorType(value) : "other";
  if (name === "version" || name === "runtimeVersion") return typeof value === "string" ? safeVersion(value) : "unknown";
  if (typeof value === "string") return safeCategory(value);
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  return value;
}
function fixedErrorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException)?.code;
  return typeof code === "string" ? safeErrorCode(code) : "other";
}

async function loadOrCreateKey(rootDir: string): Promise<Buffer> {
  const path = join(rootDir, "identity.key");
  try {
    const existing = await readFile(path);
    if (existing.length === 32) return existing;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const key = randomBytes(32);
  const temporary = join(rootDir, `.identity-${process.pid}-${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(key);
    await handle.sync();
    await handle.close();
    try { await link(temporary, path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const published = await readFile(path);
    if (published.length !== 32) throw new Error("diagnostic identity key is invalid");
    await chmod(path, 0o600);
    return published;
  } catch (error) {
    throw error;
  } finally {
    await handle.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export async function persistEmergencyDiagnostic(options: {
  rootDir: string;
  role: DiagnosticsOptions["role"];
  component?: string;
  event: DiagnosticEvent;
  fields?: Partial<Pick<DiagnosticFields, "outcome" | "errorCode" | "errorType" | "forced" | "durationMs">>;
  now?: () => Date;
}): Promise<string> {
  const rootDir = resolve(options.rootDir);
  await mkdir(rootDir, { recursive: true, mode: 0o700 });
  await chmod(rootDir, 0o700);
  const timestamp = (options.now ?? (() => new Date()))().toISOString();
  const fields: Partial<Pick<DiagnosticFields, "outcome" | "errorCode" | "errorType" | "forced" | "durationMs">> = options.fields ?? {};
  const value = {
    schemaVersion: DIAGNOSTIC_SCHEMA_VERSION,
    timestamp,
    severity: "error" as const,
    component: SAFE_CATEGORIES.has(options.component ?? "") ? options.component : options.role,
    event: SAFE_EVENTS.has(options.event) ? options.event : "diagnostic.unknown_event",
    process: { role: options.role, pid: process.pid },
    ...(typeof fields.outcome === "string" ? { outcome: safeCategory(fields.outcome) } : {}),
    ...(typeof fields.errorCode === "string" ? { errorCode: safeErrorCode(fields.errorCode) } : {}),
    ...(typeof fields.errorType === "string" ? { errorType: safeErrorType(fields.errorType) } : {}),
    ...(typeof fields.forced === "boolean" ? { forced: fields.forced } : {}),
    ...(typeof fields.durationMs === "number" && Number.isFinite(fields.durationMs) ? { durationMs: fields.durationMs } : {}),
    mode: "emergency",
  };
  const path = join(rootDir, `diagnostics-emergency-${options.role}-${process.pid}-${randomUUID()}.jsonl`);
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(value) + "\n");
    await handle.sync();
  } finally { await handle.close(); }
  const directory = await open(rootDir, "r");
  try { await directory.sync(); } finally { await directory.close(); }
  return path;
}

async function withDirectoryLock<T>(rootDir: string, action: () => Promise<T>): Promise<T> {
  await mkdir(rootDir, { recursive: true, mode: 0o700 });
  const lock = join(rootDir, ".retention-lock");
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (true) {
    try { await mkdir(lock, { mode: 0o700 }); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const info = await stat(lock).catch(() => null);
      if (info && Date.now() - info.mtimeMs > LOCK_STALE_MS) { await rm(lock, { recursive: true, force: true }); continue; }
      if (Date.now() >= deadline) throw Object.assign(new Error("diagnostic retention lock timed out"), { code: "EIO" });
      await new Promise(resolveWait => setTimeout(resolveWait, 10));
    }
  }
  try { return await action(); }
  finally { await rm(lock, { recursive: true, force: true }); }
}

function segmentInfo(name: string): { active: boolean; pid: number | null } | null {
  if (!/^diagnostics-.*\.jsonl$/.test(name)) return null;
  const match = /^diagnostics-active-[a-z]+-(\d+)-.*\.jsonl$/.exec(name);
  return { active: match !== null, pid: match ? Number(match[1]) : null };
}
function pidAlive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }
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
  for (const entry of await listSegments(rootDir)) {
    if (!entry.active || entry.pid === null || entry.pid === process.pid || pidAlive(entry.pid)) continue;
    const target = join(rootDir, `diagnostics-recovered-${Date.now()}-${randomUUID()}.jsonl`);
    await rename(entry.path, target).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; });
  }
}
async function pruneSegmentsLocked(rootDir: string, options: {
  maxAgeMs: number; maxSegments: number; totalBytes: number; reserveBytes: number; prospectivePath?: string;
}): Promise<boolean> {
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
  return total + options.reserveBytes <= options.totalBytes && count + addedCount <= options.maxSegments;
}

export async function pruneDiagnosticSegments(rootDir: string, options: { maxAgeMs?: number; maxSegments?: number; totalBytes?: number; preserve?: string } = {}): Promise<void> {
  await withDirectoryLock(resolve(rootDir), async () => {
    await normalizeDeadActiveSegments(resolve(rootDir));
    await pruneSegmentsLocked(resolve(rootDir), {
      maxAgeMs: options.maxAgeMs ?? DIAGNOSTIC_MAX_AGE_MS,
      maxSegments: options.maxSegments ?? DIAGNOSTIC_MAX_SEGMENTS,
      totalBytes: options.totalBytes ?? DIAGNOSTIC_TOTAL_BYTES,
      reserveBytes: 0,
      prospectivePath: options.preserve,
    });
  });
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
  if (!diagnostics.status().available || diagnostics.status().queuedEvents !== 0) throw new Error("diagnostics could not reach a stable snapshot");
  const target = resolve(destination);
  await mkdir(target, { recursive: false, mode: 0o700 });
  try {
    await chmod(target, 0o700);
    const logsDir = join(target, "logs"); await mkdir(logsDir, { mode: 0o700 });
    let copiedBytes = 0, copiedFiles = 0;
    await withDirectoryLock(diagnostics.status().rootDir, async () => {
      const entries = (await listSegments(diagnostics.status().rootDir)).sort((a, b) => b.mtimeMs - a.mtimeMs);
      for (const entry of entries) {
        if (copiedBytes + entry.size > DIAGNOSTIC_TOTAL_BYTES) break;
        const output = join(logsDir, basename(entry.name)); await copyFile(entry.path, output); await chmod(output, 0o600);
        copiedBytes += entry.size; copiedFiles++;
      }
    });
    const cpu = process.cpuUsage();
    const snapshot = {
      timestamp: new Date().toISOString(), os: platform(), arch: arch(), node: process.version,
      rssBytes: process.memoryUsage().rss, cpuUserMicros: cpu.user, cpuSystemMicros: cpu.system,
      processCount: await processCount(), diagnosticBytes: copiedBytes,
      recovery: await boundedDirectorySize(context.recoveryRoot), artifacts: await boundedDirectorySize(context.artifactRoot), cache: await boundedDirectorySize(context.cacheRoot),
    };
    const manifest = {
      schemaVersion: 1, appVersion: safeVersion(context.appVersion), buildId: safeVersion(context.buildId),
      platform: platform(), arch: arch(), runtimeVersion: process.version,
      diagnostics: { ...diagnostics.status(), rootDir: undefined },
      runtime: await diagnostics.safeFields(context.runtime ?? {}), state: await diagnostics.safeFields(context.state ?? {}), resources: snapshot,
      included: ["bounded structured lifecycle and operation logs", "build/runtime metadata", "current coarse service state", "one resource snapshot"],
      excluded: ["notebook and Markdown source", "R output and values", "table/image/HTML/widget/upload content and filenames", "recovery and draft bodies", "MCP arguments and results", "authentication material", "environment values", "credentials", "absolute paths", "raw crash memory", "raw child output"],
    };
    await writePrivate(join(target, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
    await writePrivate(join(target, "PRIVACY.txt"), ["Alder diagnostic bundle", "", "Included:", ...manifest.included.map(item => `- ${item}`), "", "Excluded:", ...manifest.excluded.map(item => `- ${item}`), ""].join("\n"));
    return { path: target, files: copiedFiles + 2, bytes: copiedBytes };
  } catch (error) { await rm(target, { recursive: true, force: true }); throw error; }
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
async function processCount(): Promise<number | null> {
  try { const proc = await import("node:child_process"); const output = proc.execFileSync("/bin/ps", ["-axo", "pid="], { encoding: "utf8", timeout: 250, stdio: ["ignore", "pipe", "ignore"] }); return output.split("\n").filter(line => line.trim()).length; }
  catch { return null; }
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

import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { Readable, Writable } from "node:stream";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  createProcessScope,
  type OwnedProcess,
  type ProcessScope,
} from "../src/processes.js";
import { createWindowsNodeLauncher, secureWindowsPath, testNodeExecutable } from "./windows-fixtures.js";
import { resolveApplicationResources, type ApplicationResources } from "../src/resources.js";
interface NativeProcess {
  pid: number;
  ppid: number;
  startIdentity: string;
}

interface CapturedOutput {
  readonly done: Promise<string>;
  readonly ended: boolean;
  readonly text: string;
}

const APPLICATION_ROOT = process.env.ALDER_APPLICATION_ROOT;
const integration = {
  skip: APPLICATION_ROOT === undefined || process.platform !== "linux",
  timeout: 180_000,
};
const POLL_MS = 25;
const PROCESS_INSPECT_TIMEOUT_MS = 2_000;
const PROCESS_WAIT_TIMEOUT_MS = 60_000;

let applicationResources: Promise<ApplicationResources> | undefined;

interface ProcessObserverRecord {
  pid: number;
  ppid: number;
  state: string;
  startIdentity: string;
  command: string;
  executable: string | null;
  depth?: number;
}

interface ProcessObserverApi {
  readProcess(pid: number, options: { supervisorExecutable: string }): Promise<ProcessObserverRecord | null>;
  captureProcessTree(pid: number, identity: string, options: { supervisorExecutable: string }): Promise<ProcessObserverRecord[]>;
  waitForOwnedProcessesGone(records: ProcessObserverRecord[], timeout: number, options: { supervisorExecutable: string }): Promise<void>;
}

let processObserverApi: Promise<ProcessObserverApi> | undefined;
async function processObserver(): Promise<ProcessObserverApi> {
  processObserverApi ??= import(new URL("../scripts/smoke-scenarios/process-observer.mjs", import.meta.url).href)
    .then(module => module as unknown as ProcessObserverApi);
  return processObserverApi;
}

function observerCandidateMissing(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("process_observer_candidate_missing:");
}

async function readObservedProcess(
  api: ProcessObserverApi,
  pid: number,
  options: { supervisorExecutable: string },
): Promise<ProcessObserverRecord | null | undefined> {
  try {
    return await api.readProcess(pid, options);
  } catch (error) {
    if (observerCandidateMissing(error)) return undefined;
    throw error;
  }
}

async function installedResources(): Promise<ApplicationResources> {
  if (APPLICATION_ROOT === undefined) {
    throw new Error("ALDER_APPLICATION_ROOT is required for installed process tests");
  }
  // Do not replace an explicit root with a local fallback: an invalid staged
  // root must fail loudly instead of silently testing source-tree resources.
  applicationResources ??= resolveApplicationResources(resolve(APPLICATION_ROOT));
  return applicationResources;
}

function testEnvironment(extra: Record<string, string> = {}): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value !== "string" || key === "R_HOME" || key.startsWith("R_LIBS") || key.startsWith("ALDER_")) {
      continue;
    }
    environment[key] = value;
  }
  return { ...environment, ...extra };
}

async function writeSupervisorFixture(basePath: string, mode: "overflow" | "healthy", exitPath: string): Promise<string> {
  const scriptPath = process.platform === "win32" ? basePath + ".cjs" : basePath;
  const executablePath = process.platform === "win32" ? basePath + ".exe" : basePath;
  await writeFile(scriptPath, supervisorFixtureScript(mode, exitPath), { mode: 0o755 });
  if (process.platform === "win32") {
    await secureWindowsPath("file", scriptPath);
    await createWindowsNodeLauncher(executablePath, scriptPath);
    await secureWindowsPath("file", executablePath);
  } else {
    await chmod(scriptPath, 0o755);
  }
  return executablePath;
}

async function fixtureDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  await secureWindowsPath("directory", directory);
  return directory;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise(resolveSleep => setTimeout(resolveSleep, milliseconds));
}

async function waitForValue<T>(label: string, probe: () => Promise<T | undefined | null>, timeoutMs = PROCESS_WAIT_TIMEOUT_MS): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined && value !== null) return value;
    if (Date.now() >= deadline) throw new Error(label + " timed out after " + timeoutMs + " ms");
    await sleep(POLL_MS);
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(label + " timed out after " + timeoutMs + " ms")), timeoutMs);
  });
  // Keep a timed-out operation observed so a late rejection cannot become an
  // unhandled rejection while finally-cleanup is bringing down its owner.
  void promise.catch(() => {});
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function inspectNative(resources: ApplicationResources, pid: number): NativeProcess | null {
  const result = spawnSync(
    resources.processSupervisorExecutable,
    ["--inspect-process", String(pid)],
    { encoding: "utf8", timeout: PROCESS_INSPECT_TIMEOUT_MS, windowsHide: true },
  );
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error("native process inspector failed for " + pid + ": " + (result.stderr || result.stdout).trim());
  }
  const text = result.stdout.trim();
  if (text === "null") return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error("native process inspector returned invalid JSON for " + pid, { cause: error });
  }
  assert.ok(value !== null && typeof value === "object", "native process inspector returned a non-object");
  const record = value as Partial<NativeProcess>;
  const returnedPid = record.pid;
  assert.equal(returnedPid, pid, "native process inspector returned the wrong pid");
  const ppid = record.ppid;
  assert.ok(typeof ppid === "number" && Number.isSafeInteger(ppid), "native process inspector returned an invalid parent pid");
  const startIdentity = record.startIdentity;
  assert.ok(typeof startIdentity === "string" && startIdentity.length > 0, "native process inspector omitted the birth identity");
  assert.ok(typeof returnedPid === "number" && Number.isSafeInteger(returnedPid), "native process inspector returned an invalid pid");
  return { pid: returnedPid, ppid, startIdentity };
}

function assertSameBirth(actual: NativeProcess | null, expected: NativeProcess, label: string): asserts actual is NativeProcess {
  assert.ok(actual !== null, label + " is no longer observable");
  assert.equal(actual.pid, expected.pid, label + " changed pid");
  assert.equal(actual.startIdentity, expected.startIdentity, label + " changed birth identity");
}

async function waitForGone(resources: ApplicationResources, expected: NativeProcess, label: string): Promise<void> {
  await waitForValue(label, async () => {
    const current = inspectNative(resources, expected.pid);
    return current === null || current.startIdentity !== expected.startIdentity ? true : undefined;
  });
}

function captureOutput(stream: Readable | null, label: string): CapturedOutput {
  assert.ok(stream !== null, label + " stream is unavailable");
  let text = "";
  let ended = false;
  const done = new Promise<string>((resolveOutput, rejectOutput) => {
    stream.setEncoding("utf8");
    stream.on("data", chunk => { text += String(chunk); });
    stream.once("end", () => {
      ended = true;
      resolveOutput(text);
    });
    stream.once("error", rejectOutput);
  });
  void done.catch(() => {});
  return {
    done,
    get ended() { return ended; },
    get text() { return text; },
  };
}

async function waitForMarker(output: CapturedOutput, label: string): Promise<number> {
  return waitForValue(label, async () => {
    if (output.ended) throw new Error(label + " stream ended before readiness");
    const match = output.text.match(/(?:^|\n)child-ready:(\d+)(?:\n|$)/);
    return match === null ? undefined : Number(match[1]);
  });
}
async function waitForReadableClosed(stream: Readable, label: string): Promise<void> {
  await waitForValue(label, async () => stream.destroyed || stream.readableEnded ? true : undefined, 5_000);
}



async function cleanupScope(
  resources: ApplicationResources,
  scope: ProcessScope | undefined,
  owned: OwnedProcess | undefined,
  known: readonly NativeProcess[],
  outputs: readonly (CapturedOutput | undefined)[],
  directory: string,
): Promise<void> {
  const errors: unknown[] = [];
  if (owned !== undefined) {
    try {
      await withTimeout(owned.terminate(), PROCESS_WAIT_TIMEOUT_MS, "owned process termination");
    } catch (error) {
      errors.push(error);
    }
  }
  if (scope !== undefined) {
    try {
      await withTimeout(scope.close(), PROCESS_WAIT_TIMEOUT_MS, "process scope close");
    } catch (error) {
      errors.push(error);
    }
  }
  for (const process of known) {
    try {
      await waitForGone(resources, process, "owned process " + process.pid + " cleanup");
    } catch (error) {
      errors.push(error);
    }
  }
  for (const output of outputs) {
    if (output === undefined) continue;
    try {
      await withTimeout(output.done, PROCESS_WAIT_TIMEOUT_MS, "" + "process output EOF");
    } catch (error) {
      errors.push(error);
    }
  }
  try {
    await rm(directory, { recursive: true, force: true });
  } catch (error) {
    errors.push(error);
  }
  if (errors.length > 0) throw new AggregateError(errors, "process test cleanup failed");
}

function leaderScript(exitCode: number, retirePath?: string): string {
  const childScript = JSON.stringify("setInterval(() => {}, 1000);");
  const retirement = retirePath === undefined
    ? "setTimeout(() => { process.exitCode = " + exitCode + "; }, 500);"
    : [
      "const fs = require(\"node:fs\");",
      "const retirePath = " + JSON.stringify(retirePath) + ";",
      "const retire = setInterval(() => { if (fs.existsSync(retirePath)) { clearInterval(retire); process.exitCode = " + exitCode + "; } }, 5);",
    ].join("\n");
  return [
    "const { spawn } = require(\"node:child_process\");",
    "const child = spawn(" + JSON.stringify(testNodeExecutable()) + ", [\"-e\", " + childScript + "], { stdio: \"ignore\" });",
    "child.unref();",
    "process.stdout.write(\"child-ready:\" + child.pid + String.fromCharCode(10));",
    retirement,
  ].join("\n");
}

const liveLeaderScript = leaderScript(0).replace(
  "setTimeout(() => { process.exitCode = 0; }, 500);",
  "setInterval(() => {}, 1000);",
);

async function spawnOwned(
  scope: ProcessScope,
  script: string,
  cwd: string,
): Promise<OwnedProcess> {
  return scope.spawn({
    executable: testNodeExecutable(),
    args: ["-e", script],
    cwd,
    environment: testEnvironment(),
    stdio: "pipes",
  });
}

test("normal owned process exit retires supervisor and contained descendants", integration, async () => {
  const resources = await installedResources();
  const directory = await fixtureDirectory("alder-process-leader-");
  const retirePath = join(directory, "retire");
  let scope: ProcessScope | undefined;
  const observer = await processObserver();
  const observerOptions = { supervisorExecutable: resources.processSupervisorExecutable };
  let owned: OwnedProcess | undefined;
  let output: CapturedOutput | undefined;
  const known: NativeProcess[] = [];
  try {
    scope = await createProcessScope(resources);
    owned = await spawnOwned(scope, leaderScript(17, retirePath), directory);
    void owned.exited.catch(() => {});
    const leader: NativeProcess = {
      pid: owned.pid,
      ppid: 0,
      startIdentity: owned.startIdentity,
    };
    known.push(leader);
    assertSameBirth(inspectNative(resources, leader.pid), leader, "leader before exit");
    output = captureOutput(owned.stdout, "leader stdout");
    const childPid = await waitForMarker(output, "leader child readiness");
    const child = await waitForValue("leader child birth", async () => inspectNative(resources, childPid));
    known.push(child);
    const observedBeforeExit = await observer.readProcess(leader.pid, observerOptions);
    assert.ok(observedBeforeExit !== null, "observer lost the live leader");
    assert.equal(observedBeforeExit.pid, leader.pid);
    assert.equal(observedBeforeExit.startIdentity, leader.startIdentity);

    const observedTree = await waitForValue("observer live tree", async () => {
      try {
        const records = await observer.captureProcessTree(leader.pid, leader.startIdentity, observerOptions);
        const root = records.find(record => record.pid === leader.pid && record.startIdentity === leader.startIdentity);
        const capturedChild = records.find(record => record.pid === child.pid && record.startIdentity === child.startIdentity);
        return root !== undefined && capturedChild !== undefined ? records : undefined;
      } catch (error) {
        if (observerCandidateMissing(error) || error instanceof Error && /^(owned_process_root_missing|owned_process_identity_mismatch):/.test(error.message)) return undefined;
        throw error;
      }
    });
    assert.ok(observedTree.some(record => record.pid === leader.pid && record.startIdentity === leader.startIdentity), "observer tree omitted the live leader");
    assert.ok(observedTree.some(record => record.pid === child.pid && record.startIdentity === child.startIdentity), "observer tree omitted the live child");
    await writeFile(retirePath, "retire\n");

    assert.deepEqual(
      await withTimeout(owned.exited, PROCESS_WAIT_TIMEOUT_MS, "leader exit"),
      { code: 17, signal: null },
    );
    await withTimeout(output.done, PROCESS_WAIT_TIMEOUT_MS, "leader stdout EOF after normal exit");
    await observer.waitForOwnedProcessesGone(observedTree, PROCESS_WAIT_TIMEOUT_MS, observerOptions);
    await waitForGone(resources, leader, "leader after normal exit");
    await waitForGone(resources, child, "unref child after normal exit");
    await withTimeout(scope.close(), PROCESS_WAIT_TIMEOUT_MS, "leader process scope close");
  } finally {
    await cleanupScope(resources, scope, owned, known, [output], directory);
  }
});

test("live scope close resolves OwnedProcess.exited with the native exit result", integration, async () => {
  const resources = await installedResources();
  const directory = await fixtureDirectory("alder-process-close-");
  let scope: ProcessScope | undefined;
  let owned: OwnedProcess | undefined;
  let output: CapturedOutput | undefined;
  const known: NativeProcess[] = [];
  try {
    scope = await createProcessScope(resources);
    owned = await spawnOwned(scope, liveLeaderScript, directory);
    void owned.exited.catch(() => {});
    const leader: NativeProcess = {
      pid: owned.pid,
      ppid: 0,
      startIdentity: owned.startIdentity,
    };
    known.push(leader);
    assertSameBirth(inspectNative(resources, leader.pid), leader, "live leader");
    output = captureOutput(owned.stdout, "live leader stdout");
    const childPid = await waitForMarker(output, "live leader child readiness");
    const child = await waitForValue("live leader child birth", async () => inspectNative(resources, childPid));
    known.push(child);

    await withTimeout(scope.close(), PROCESS_WAIT_TIMEOUT_MS, "live process scope close");
    const exit = await withTimeout(owned.exited, PROCESS_WAIT_TIMEOUT_MS, "live leader exit after scope close");
    assert.equal(exit.code, null);
    assert.notEqual(exit.signal, null);
    await withTimeout(output.done, PROCESS_WAIT_TIMEOUT_MS, "live leader stdout EOF");
    await waitForGone(resources, leader, "live leader after scope close");
    await waitForGone(resources, child, "live child after scope close");
  } finally {
    await cleanupScope(resources, scope, owned, known, [output], directory);
  }
});

interface SupervisorEvent {
  v: number;
  type: string;
  id?: number;
  pid?: number;
  startIdentity?: string;
  [key: string]: unknown;
}

class SupervisorFrameReader {
  private readonly queue: SupervisorEvent[] = [];
  private readonly waiters: Array<{
    resolve: (event: SupervisorEvent) => void;
    reject: (error: unknown) => void;
  }> = [];
  private buffer = Buffer.alloc(0);
  private failure: Error | undefined;

  constructor(stream: Readable) {
    stream.on("data", chunk => this.push(chunk));
    stream.once("error", error => this.fail(error));
    stream.once("end", () => this.fail(new Error("detached supervisor control channel closed")));
  }

  next(): Promise<SupervisorEvent> {
    if (this.queue.length > 0) return Promise.resolve(this.queue.shift()!);
    if (this.failure !== undefined) return Promise.reject(this.failure);
    return new Promise((resolveEvent, rejectEvent) => this.waiters.push({ resolve: resolveEvent, reject: rejectEvent }));
  }

  fail(error: unknown): void {
    if (this.failure !== undefined) return;
    this.failure = error instanceof Error ? error : new Error(String(error));
    for (const waiter of this.waiters.splice(0)) waiter.reject(this.failure);
  }

  private push(chunk: Buffer | string): void {
    this.buffer = Buffer.concat([this.buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    while (this.buffer.byteLength >= 4) {
      const length = this.buffer.readUInt32LE(0);
      if (length === 0 || length > 1_048_576) {
        this.fail(new Error("invalid detached supervisor control frame length"));
        return;
      }
      if (this.buffer.byteLength < length + 4) return;
      const body = this.buffer.subarray(4, length + 4);
      this.buffer = this.buffer.subarray(length + 4);
      let value: unknown;
      try {
        value = JSON.parse(body.toString("utf8"));
      } catch (error) {
        this.fail(new Error("invalid detached supervisor control event JSON", { cause: error }));
        return;
      }
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        this.fail(new Error("detached supervisor control event is not an object"));
        return;
      }
      const waiter = this.waiters.shift();
      if (waiter === undefined) this.queue.push(value as SupervisorEvent);
      else waiter.resolve(value as SupervisorEvent);
    }
  }
}

async function sendSupervisorFrame(input: Writable, value: Record<string, unknown>): Promise<void> {
  const candidate = input as Writable & { destroyed?: boolean; writableEnded?: boolean };
  if (candidate.destroyed || candidate.writableEnded) throw new Error("detached supervisor control pipe is closed");
  const body = Buffer.from(JSON.stringify(value), "utf8");
  assert.ok(body.byteLength > 0 && body.byteLength <= 1_048_576, "detached supervisor frame is out of bounds");
  const frame = Buffer.allocUnsafe(body.byteLength + 4);
  frame.writeUInt32LE(body.byteLength, 0);
  body.copy(frame, 4);
  await new Promise<void>((resolveFrame, rejectFrame) => {
    let settled = false;
    const onError = (error: Error): void => {
      if (settled) return;
      settled = true;
      input.off("error", onError);
      rejectFrame(error);
    };
    input.once("error", onError);
    try {
      input.write(frame, error => {
        if (settled) return;
        settled = true;
        input.off("error", onError);
        if (error) rejectFrame(error);
        else resolveFrame();
      });
    } catch (error) {
      onError(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

async function waitSupervisorEvent(
  reader: SupervisorFrameReader,
  predicate: (event: SupervisorEvent) => boolean,
  label: string,
): Promise<SupervisorEvent> {
  return withTimeout((async () => {
    for (;;) {
      const event = await reader.next();
      if (event.v !== 1) throw new Error(label + " reported an unsupported protocol version");
      if (predicate(event)) return event;
    }
  })(), PROCESS_WAIT_TIMEOUT_MS, label);
}

function processFromSupervisorEvent(event: SupervisorEvent, label: string): NativeProcess {
  const pid = event.pid;
  const startIdentity = event.startIdentity;
  assert.ok(typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0, label + " PID is invalid");
  assert.ok(typeof startIdentity === "string" && startIdentity.length > 0, label + " birth identity is invalid");
  return { pid, ppid: 0, startIdentity };
}

interface DetachedSupervisor {
  wrapper: ChildProcess;
  input: Writable;
  reader: SupervisorFrameReader;
  stdout: CapturedOutput;
  stderr: CapturedOutput;
  wrapperBirth: NativeProcess;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  handedOff: boolean;
}

function childExit(process: ChildProcess, event: "exit" | "close"): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise(resolveExit => process.once(event, (code, signal) => resolveExit({ code, signal })));
}

async function startDetachedSupervisor(resources: ApplicationResources, directory: string): Promise<DetachedSupervisor> {
  const wrapper = spawn(
    resources.processSupervisorExecutable,
    ["--detached-host", "--control-in=3", "--control-out=4"],
    {
      cwd: directory,
      env: testEnvironment(),
      stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  const input = wrapper.stdio[3] as Writable | null;
  const controlOutput = wrapper.stdio[4] as Readable | null;
  const wrapperPid = wrapper.pid;
  assert.ok(typeof wrapperPid === "number" && Number.isSafeInteger(wrapperPid) && wrapperPid > 0, "detached supervisor PID is invalid");
  assert.ok(input !== null && controlOutput !== null, "detached supervisor control pipes are unavailable");
  const stdout = captureOutput(wrapper.stdout, "detached target stdout");
  const stderr = captureOutput(wrapper.stderr, "detached target stderr");
  const reader = new SupervisorFrameReader(controlOutput);
  const exited = childExit(wrapper, "exit");
  const closed = childExit(wrapper, "close");
  wrapper.once("error", error => reader.fail(error));
  input.on("error", () => {});
  try {
    const hello = await waitSupervisorEvent(reader, event => event.type === "hello", "detached supervisor hello");
    assert.equal(hello.pid, wrapperPid, "detached supervisor hello PID mismatch");
    const wrapperBirth = await waitForValue("detached supervisor birth", async () => {
      const current = inspectNative(resources, wrapperPid);
      return current !== null && current.startIdentity === hello.startIdentity ? current : undefined;
    });
    return { wrapper, input, reader, stdout, stderr, wrapperBirth, exited, closed, handedOff: false };
  } catch (error) {
    try { wrapper.kill("SIGKILL"); } catch { /* the process may already be gone */ }
    await withTimeout(exited, PROCESS_WAIT_TIMEOUT_MS, "detached supervisor startup exit").catch(() => {});
    await withTimeout(closed, PROCESS_WAIT_TIMEOUT_MS, "detached supervisor startup close").catch(() => {});
    await withTimeout(stdout.done, PROCESS_WAIT_TIMEOUT_MS, "detached target startup stdout EOF").catch(() => {});
    await withTimeout(stderr.done, PROCESS_WAIT_TIMEOUT_MS, "detached target startup stderr EOF").catch(() => {});
    throw error;
  }
}

async function waitForJsonLine(output: CapturedOutput, label: string): Promise<Record<string, unknown>> {
  const line = await waitForValue(label, async () => {
    if (output.ended) throw new Error(label + " stream ended before readiness");
    const newline = output.text.indexOf("\n");
    return newline < 0 ? undefined : output.text.slice(0, newline).trim();
  });
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (error) {
    throw new Error(label + " was not JSON", { cause: error });
  }
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value), label + " was not an object");
  return value as Record<string, unknown>;
}

async function waitForJsonFile(path: string, label: string): Promise<Record<string, unknown>> {
  return waitForValue(label, async () => {
    try {
      const text = await readFile(path, "utf8");
      if (text.trim().length === 0) return undefined;
      const value: unknown = JSON.parse(text);
      return value !== null && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || error instanceof SyntaxError) return undefined;
      throw error;
    }
  });
}

async function findDetachedMonitor(
  resources: ApplicationResources,
  wrapper: NativeProcess,
  target: NativeProcess,
): Promise<NativeProcess> {
  return waitForValue("detached lifecycle monitor", async () => {
    const targetCurrent = inspectNative(resources, target.pid);
    if (targetCurrent === null || targetCurrent.startIdentity !== target.startIdentity) return undefined;
    const candidate = inspectNative(resources, targetCurrent.ppid);
    if (candidate === null || candidate.pid === wrapper.pid) return undefined;
    const candidateParent = inspectNative(resources, candidate.ppid);
    if (candidateParent === null || candidateParent.pid !== wrapper.pid || candidateParent.startIdentity !== wrapper.startIdentity) {
      return undefined;
    }
    return candidate;
  });
}

function detachedTargetScript(
  retirePath: string,
  childReadyPath: string,
  exitPath: string,
  childTermPath: string,
): string {
  const childScript = [
    "const fs = require(\"node:fs\");",
    "const retirePath = " + JSON.stringify(retirePath) + ";",
    "const childReadyPath = " + JSON.stringify(childReadyPath) + ";",
    "const exitPath = " + JSON.stringify(exitPath) + ";",
    "const childTermPath = " + JSON.stringify(childTermPath) + ";",
    "let announced = false;",
    "const watch = setInterval(() => {",
    "  if (!announced && fs.existsSync(retirePath)) {",
    "    announced = true;",
    "    fs.writeFileSync(childReadyPath, JSON.stringify({ type: \"child-ready-for-retirement\", pid: process.pid }) + String.fromCharCode(10));",
    "  }",
    "}, 5);",
    "process.on(\"SIGTERM\", () => {",
    "  fs.writeFileSync(childTermPath, JSON.stringify({ type: \"child-saw-target-exit\", pid: process.pid, targetExit: fs.existsSync(exitPath) }) + String.fromCharCode(10));",
    "});",
  ].join("\n");
  return [
    "const fs = require(\"node:fs\");",
    "const { spawn } = require(\"node:child_process\");",
    "const retirePath = " + JSON.stringify(retirePath) + ";",
    "const childReadyPath = " + JSON.stringify(childReadyPath) + ";",
    "const exitPath = " + JSON.stringify(exitPath) + ";",
    "const child = spawn(" + JSON.stringify(testNodeExecutable()) + ", [\"-e\", " + JSON.stringify(childScript) + "], { stdio: \"ignore\" });",
    "process.on(\"exit\", () => { fs.writeFileSync(exitPath, JSON.stringify({ type: \"target-exit\", pid: process.pid, code: process.exitCode, childPid: child.pid }) + String.fromCharCode(10)); });",
    "child.unref();",
    "process.stdout.write(JSON.stringify({ type: \"target-ready\", pid: process.pid, childPid: child.pid }) + String.fromCharCode(10));",
    "const waitForChild = setInterval(() => { if (fs.existsSync(childReadyPath)) { clearInterval(waitForChild); process.exitCode = 17; } }, 5);",
  ].join("\n");
}

async function cleanupDetached(
  resources: ApplicationResources,
  supervisor: DetachedSupervisor | undefined,
  target: NativeProcess | undefined,
  child: NativeProcess | undefined,
  monitor: NativeProcess | undefined,
  directory: string,
): Promise<void> {
  const errors: unknown[] = [];
  if (supervisor !== undefined) {
    try {
      const current = inspectNative(resources, supervisor.wrapperBirth.pid);
      if (current !== null && current.startIdentity === supervisor.wrapperBirth.startIdentity) {
        if (!supervisor.handedOff) {
          await sendSupervisorFrame(supervisor.input, { v: 1, op: "terminate", id: 90, graceMs: 500, killMs: 1_000 });
          await sendSupervisorFrame(supervisor.input, { v: 1, op: "close", id: 91 });
          supervisor.input.end();
        } else {
          supervisor.wrapper.kill("SIGKILL");
        }
      }
    } catch (error) {
      errors.push(error);
    }
  }
  if (target !== undefined) {
    try {
      const current = inspectNative(resources, target.pid);
      if (current !== null && current.startIdentity === target.startIdentity) process.kill(target.pid, "SIGTERM");
    } catch (error) {
      errors.push(error);
    }
  }
  if (supervisor !== undefined) {
    for (const [promise, label] of [[supervisor.exited, "detached supervisor exit"], [supervisor.closed, "detached supervisor close"]] as const) {
      try { await withTimeout(promise, PROCESS_WAIT_TIMEOUT_MS, label); } catch (error) { errors.push(error); }
    }
  }
  for (const [record, label] of [[target, "detached target"], [child, "detached child"], [monitor, "detached monitor"]] as const) {
    if (record === undefined) continue;
    try { await waitForGone(resources, record, label + " cleanup"); } catch (error) { errors.push(error); }
  }
  if (supervisor !== undefined) {
    for (const [output, label] of [[supervisor.stdout, "detached target stdout"], [supervisor.stderr, "detached target stderr"]] as const) {
      try { await withTimeout(output.done, PROCESS_WAIT_TIMEOUT_MS, label + " EOF"); } catch (error) { errors.push(error); }
    }
  }
  try { await rm(directory, { recursive: true, force: true }); } catch (error) { errors.push(error); }
  if (errors.length > 0) throw new AggregateError(errors, "detached process test cleanup failed");
}

test("detached handoff survives wrapper exit and drains a same-group child after natural root exit", integration, async () => {
  const resources = await installedResources();
  const directory = await fixtureDirectory("alder-process-detached-");
  const retirePath = join(directory, "retire");
  const childReadyPath = join(directory, "child-ready");
  const exitPath = join(directory, "target-exit");
  const childTermPath = join(directory, "child-term");
  let supervisor: DetachedSupervisor | undefined;
  let target: NativeProcess | undefined;
  let child: NativeProcess | undefined;
  let monitor: NativeProcess | undefined;
  try {
    supervisor = await startDetachedSupervisor(resources, directory);
    await sendSupervisorFrame(supervisor.input, {
      v: 1,
      op: "spawn",
      id: 1,
      executable: testNodeExecutable(),
      args: ["-e", detachedTargetScript(retirePath, childReadyPath, exitPath, childTermPath)],
      cwd: directory,
      environment: testEnvironment(),
      stdio: "pipes",
    });
    const spawned = await waitSupervisorEvent(supervisor.reader, event => event.type === "spawned" && event.id === 1, "detached target spawn");
    target = processFromSupervisorEvent(spawned, "detached target");
    assertSameBirth(await waitForValue("detached target birth", async () => {
      const current = inspectNative(resources, target!.pid);
      return current !== null && current.startIdentity === target!.startIdentity ? current : undefined;
    }), target, "detached target birth");
    const ready = await waitForJsonLine(supervisor.stdout, "detached target readiness");
    assert.equal(ready.type, "target-ready");
    assert.equal(ready.pid, target.pid);
    assert.ok(typeof ready.childPid === "number" && Number.isSafeInteger(ready.childPid) && ready.childPid > 0);
    child = await waitForValue("detached child birth", async () => inspectNative(resources, ready.childPid as number));
    assert.equal(child.ppid, target.pid, "detached child was not born under the target");
    monitor = await findDetachedMonitor(resources, supervisor.wrapperBirth, target);

    await sendSupervisorFrame(supervisor.input, { v: 1, op: "handoff", id: 2 });
    const handoff = await waitSupervisorEvent(supervisor.reader, event => event.type === "closed" && event.id === 2, "detached handoff");
    assert.equal(handoff.id, 2);
    supervisor.handedOff = true;
    await withTimeout(supervisor.exited, PROCESS_WAIT_TIMEOUT_MS, "detached wrapper exit");
    await waitForGone(resources, supervisor.wrapperBirth, "detached wrapper after handoff");
    assertSameBirth(inspectNative(resources, target.pid), target, "detached target after handoff");
    assertSameBirth(inspectNative(resources, child.pid), child, "detached child after handoff");
    assert.equal(inspectNative(resources, target.pid)?.ppid, monitor.pid, "detached monitor did not remain target parent");
    await writeFile(retirePath, "retire\n");

    const childReady = await waitForJsonFile(childReadyPath, "detached child pre-retirement marker");
    assert.equal(childReady.type, "child-ready-for-retirement");
    assert.equal(childReady.pid, child.pid);
    const targetExit = await waitForJsonFile(exitPath, "detached target natural exit");
    assert.equal(targetExit.type, "target-exit");
    assert.equal(targetExit.pid, target.pid);
    assert.equal(targetExit.childPid, child.pid);
    assert.equal(targetExit.code, 17);
    const childAtTargetExit = await waitForJsonFile(childTermPath, "detached child at target exit");
    assert.equal(childAtTargetExit.type, "child-saw-target-exit");
    assert.equal(childAtTargetExit.pid, child.pid);
    assert.equal(childAtTargetExit.targetExit, true);
    assertSameBirth(inspectNative(resources, child.pid), child, "detached child before native retirement");

    await waitForGone(resources, target, "detached target after natural exit");
    await waitForGone(resources, child, "detached child after group drain");
    await waitForGone(resources, monitor, "detached monitor after group drain");
    await withTimeout(supervisor.stdout.done, PROCESS_WAIT_TIMEOUT_MS, "detached target stdout EOF");
    await withTimeout(supervisor.stderr.done, PROCESS_WAIT_TIMEOUT_MS, "detached target stderr EOF");
    await withTimeout(supervisor.closed, PROCESS_WAIT_TIMEOUT_MS, "detached wrapper close");
  } finally {
    await cleanupDetached(resources, supervisor, target, child, monitor, directory);
  }
});

function supervisorFixtureScript(mode: "overflow" | "healthy", exitPath: string): string {
  return [
    "#!" + testNodeExecutable(),
    "const fs = require(\"node:fs\");",
    "const mode = " + JSON.stringify(mode) + ";",
    "const exitPath = " + JSON.stringify(exitPath) + ";",
    "const encode = value => {",
    "  const body = Buffer.from(JSON.stringify(value));",
    "  const frame = Buffer.allocUnsafe(4 + body.length);",
    "  frame.writeUInt32LE(body.length, 0);",
    "  body.copy(frame, 4);",
    "  return frame;",
    "};",
    "const send = value => {",
    "  try { fs.writeSync(4, encode(value)); }",
    "  catch { process.exitCode = 1; process.exit(); }",
    "};",
    "const flood = () => {",
    "  const frames = [];",
    "  for (let i = 0; i < 512; i += 1) frames.push(encode({ v: 1, type: \"noise\", id: i }));",
    "  try { fs.writeSync(4, Buffer.concat(frames)); }",
    "  catch { process.exitCode = 1; process.exit(); }",
    "};",
    "send({ v: 1, type: \"hello\" });",
    "let inputBuffer = Buffer.alloc(0);",
    "let requestCount = 0;",
    "const input = fs.createReadStream(null, { fd: 3, autoClose: false });",
    "input.on(\"data\", chunk => {",
    "  inputBuffer = Buffer.concat([inputBuffer, chunk]);",
    "  while (inputBuffer.length >= 4) {",
    "    const length = inputBuffer.readUInt32LE(0);",
    "    if (inputBuffer.length < 4 + length) return;",
    "    inputBuffer = inputBuffer.subarray(4 + length);",
    "    requestCount += 1;",
    "    if (mode === \"overflow\" && requestCount === 1) { setTimeout(flood, 5); continue; }",
    "    if (mode === \"overflow\" && requestCount === 2) {",
    "      send({ v: 1, type: \"closed\", id: 1 });",
    "      process.exit(0);",
    "    }",
    "    if (mode === \"healthy\" && requestCount === 1) {",
    "      send({ v: 1, type: \"spawned\", id: 1, pid: process.pid, startIdentity: \"fixture\" });",
    "      send({ v: 1, type: \"exited\", id: 1, code: 0, signal: null });",
    "      continue;",
    "    }",
    "    if (mode === \"healthy\" && requestCount === 2) {",
    "      send({ v: 1, type: \"closed\", id: 1 });",
    "      process.exit(0);",
    "    }",
    "  }",
    "});",
    "process.on(\"exit\", () => { try { fs.appendFileSync(exitPath, \"exited\\n\"); } catch {} });",
    "process.on(\"SIGTERM\", () => process.exit(143));",
    "setInterval(() => {}, 1000);",
  ].join("\n") + "\n";
}

test("normal exits retire supervisors and descriptors without scope close", { timeout: 30_000 }, async () => {
  const directory = await fixtureDirectory("alder-process-retire-");
  const supervisorBasePath = join(directory, "healthy-supervisor");
  const exitPath = join(directory, "healthy-exits");
  const iterations = 16;
  let scope: ProcessScope | undefined;
  try {
    const supervisorPath = await writeSupervisorFixture(supervisorBasePath, "healthy", exitPath);
    scope = await createProcessScope({ processSupervisorExecutable: supervisorPath } as ApplicationResources);
    for (let index = 0; index < iterations; index += 1) {
      const owned = await scope.spawn({
        executable: testNodeExecutable(),
        args: ["-e", ""],
        cwd: directory,
        environment: testEnvironment(),
        stdio: "pipes",
      });
      assert.deepEqual(
        await withTimeout(owned.exited, 5_000, "normal process exit " + index),
        { code: 0, signal: null },
      );
      const stdout = owned.stdout;
      const stderr = owned.stderr;
      assert.ok(stdout !== null, "normal process stdout is unavailable");
      assert.ok(stderr !== null, "normal process stderr is unavailable");
      await waitForValue("supervisor retirement " + index, async () => {
        try {
          const lines = (await readFile(exitPath, "utf8")).trim().split("\n").filter(Boolean);
          return lines.length >= index + 1 ? lines.length : undefined;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
          throw error;
        }
      }, 5_000);
      await waitForReadableClosed(stdout, "normal process stdout close " + index);
      await waitForReadableClosed(stderr, "normal process stderr close " + index);
    }
    const lines = (await readFile(exitPath, "utf8")).trim().split("\n").filter(Boolean);
    assert.equal(lines.length, iterations, "every normal exit retired its supervisor");
  } finally {
    await scope?.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});
test("supervisor event queue overflow fails and permits clean recovery", { timeout: 30_000 }, async () => {
  const directory = await fixtureDirectory("alder-process-queue-");
  const overflowBasePath = join(directory, "overflow-supervisor");
  const overflowExitPath = join(directory, "overflow-exit");
  const healthyBasePath = join(directory, "healthy-supervisor");
  const healthyExitPath = join(directory, "healthy-exit");
  let overflowScope: ProcessScope | undefined;
  let healthyScope: ProcessScope | undefined;
  const spawnOptions = {
    executable: testNodeExecutable(),
    args: ["-e", ""],
    cwd: directory,
    environment: testEnvironment(),
    stdio: "ignore" as const,
  };
  try {
    const overflowPath = await writeSupervisorFixture(overflowBasePath, "overflow", overflowExitPath);
    overflowScope = await createProcessScope({ processSupervisorExecutable: overflowPath } as ApplicationResources);
    await assert.rejects(
      overflowScope.spawn(spawnOptions),
      /process supervisor event queue overflow/,
    );
    await withTimeout(overflowScope.close(), 5_000, "overflow process scope close");
    await waitForValue("overflow supervisor cleanup", async () => {
      try {
        return await readFile(overflowExitPath, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      }
    }, 5_000);

    const healthyPath = await writeSupervisorFixture(healthyBasePath, "healthy", healthyExitPath);
    healthyScope = await createProcessScope({ processSupervisorExecutable: healthyPath } as ApplicationResources);
    const owned = await healthyScope.spawn(spawnOptions);
    assert.deepEqual(
      await withTimeout(owned.exited, 5_000, "recovered process exit"),
      { code: 0, signal: null },
    );
    await withTimeout(healthyScope.close(), 5_000, "recovered process scope close");
    await waitForValue("recovered supervisor cleanup", async () => {
      try {
        return await readFile(healthyExitPath, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      }
    }, 5_000);
  } finally {
    await overflowScope?.close().catch(() => {});
    await healthyScope?.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

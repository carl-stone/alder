import assert from "node:assert/strict";
import { ChildProcess } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import { createProcessScope } from "../src/processes.js";
import type { DiagnosticFields, DiagnosticSeverity, DiagnosticSink } from "../src/diagnostics.js";

class CollectingDiagnostics implements DiagnosticSink {
  readonly events: Array<{ severity: DiagnosticSeverity; event: string; fields: DiagnosticFields }> = [];
  record(severity: DiagnosticSeverity, event: string, fields: DiagnosticFields = {}): void { this.events.push({ severity, event, fields }); }
  child(): DiagnosticSink { return this; }
}

const environment = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
const options = (source: string) => ({ executable: process.execPath, args: ["-e", source], cwd: process.cwd(), environment, stdio: "pipes" as const });
const exists = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function waitGone(pid: number): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (exists(pid) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(exists(pid), false, `process ${pid} remained alive`);
}

test("owned processes deliver output and exit status without a native supervisor", async () => {
  const scope = await createProcessScope();
  try {
    const child = await scope.spawn(options("process.stdin.on('data', bytes => process.stdout.write(bytes)); process.stdin.on('end', () => process.exitCode = 7)"));
    const chunks: Buffer[] = [];
    child.stdout!.on("data", chunk => chunks.push(chunk));
    const outputEnded = once(child.stdout!, "end");
    child.stdin!.end("source\n");
    assert.deepEqual(await child.exited, { code: 7, signal: null });
    await outputEnded;
    assert.equal(Buffer.concat(chunks).toString(), "source\n");
  } finally { await scope.close(); }
});

test("owned child diagnostics retain argv, cwd, environment and bounded stdout and stderr tails", async () => {
  const diagnostics = new CollectingDiagnostics();
  const scope = await createProcessScope(undefined, diagnostics);
  const childOptions = options("setTimeout(() => { console.log('RAW_CHILD_STDOUT'); console.error('RAW_CHILD_STDERR') }, 20)");
  childOptions.environment.ALDER_CHILD_CONTEXT = "raw-child-environment";
  try {
    const child = await scope.spawn(childOptions);
    child.stdout!.resume(); child.stderr!.resume();
    assert.deepEqual(await child.exited, { code: 0, signal: null });
    await new Promise(resolve => setImmediate(resolve));
    const spawn = diagnostics.events.find(item => item.event === "child.spawn")!;
    assert.equal(spawn.fields.executable, process.execPath);
    assert.deepEqual(spawn.fields.argv, childOptions.args);
    assert.equal(spawn.fields.cwd, process.cwd());
    assert.equal((spawn.fields.environment as Record<string, string>).ALDER_CHILD_CONTEXT, "raw-child-environment");
    const exit = diagnostics.events.find(item => item.event === "child.exit")!;
    assert.match(String(exit.fields.stdoutTail), /RAW_CHILD_STDOUT/);
    assert.match(String(exit.fields.stderrTail), /RAW_CHILD_STDERR/);
  } finally { await scope.close(); }
});

test("scope close stops a running child and its descendant", async () => {
  const scope = await createProcessScope();
  const child = await scope.spawn(options("const c = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio:'ignore'}); console.log(c.pid); setInterval(() => {}, 1000)"));
  const [bytes] = await once(child.stdout!, "data");
  const descendant = Number(bytes.toString().trim());
  assert.ok(exists(descendant));
  await scope.close();
  await Promise.all([waitGone(child.pid), waitGone(descendant)]);
  await scope.close();
  await assert.rejects(scope.spawn(options("")), /closed/);
});

test("closing while a spawn starts cannot leave a child running", async () => {
  const scope = await createProcessScope();
  const starting = scope.spawn(options("setInterval(() => {}, 1000)"));
  const closing = scope.close();
  await assert.rejects(starting, /closed/);
  await closing;
});

test("concurrent child cancellation and scope close stop the owned process tree", async () => {
  const scope = await createProcessScope();
  const child = await scope.spawn(options("const c = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio:'ignore'}); console.log(c.pid); setInterval(() => {}, 1000)"));
  const [bytes] = await once(child.stdout!, "data");
  const descendant = Number(bytes.toString().trim());
  assert.ok(exists(descendant));

  await Promise.all([child.terminate(), scope.close()]);
  await Promise.all([waitGone(child.pid), waitGone(descendant)]);
});

test("denied process-group signals escalate a TERM-ignoring owned child directly", async () => {
  const scope = await createProcessScope();
  const child = await scope.spawn(options("process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)"));
  await once(child.stdout!, "data");
  const originalKill = process.kill;
  process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
    if (pid < 0) {
      const error = new Error("process-group signaling denied") as NodeJS.ErrnoException;
      error.code = "EPERM";
      throw error;
    }
    return originalKill(pid, signal as NodeJS.Signals | number);
  }) as typeof process.kill;
  try {
    await child.terminate();
    assert.equal((await child.exited).signal, "SIGKILL");
    assert.equal(exists(child.pid), false);
  } finally {
    process.kill = originalKill;
    await scope.close();
  }
});

test("failed direct signaling and exit observation reject termination", async () => {
  const scope = await createProcessScope();
  const child = await scope.spawn(options("console.log('ready'); setInterval(() => {}, 1000)"));
  await once(child.stdout!, "data");
  const originalProcessKill = process.kill;
  const originalChildKill = ChildProcess.prototype.kill;
  process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
    if (pid < 0) {
      const error = new Error("process-group signaling denied") as NodeJS.ErrnoException;
      error.code = "EPERM";
      throw error;
    }
    return originalProcessKill(pid, signal as NodeJS.Signals | number);
  }) as typeof process.kill;
  ChildProcess.prototype.kill = function(): boolean {
    const error = new Error("direct signaling denied") as NodeJS.ErrnoException;
    error.code = "EPERM";
    queueMicrotask(() => this.emit("error", error));
    return false;
  };
  try {
    await assert.rejects(child.terminate(), { code: "EPERM" });
    assert.equal(exists(child.pid), true);
  } finally {
    process.kill = originalProcessKill;
    ChildProcess.prototype.kill = originalChildKill;
    try { originalProcessKill(child.pid, "SIGKILL"); } catch {}
    await waitGone(child.pid);
    await scope.close().catch(() => undefined);
  }
});

test("a child that ignores SIGTERM is stopped with bounded escalation", async () => {
  const diagnostics = new CollectingDiagnostics();
  const scope = await createProcessScope(undefined, diagnostics);
  try {
    const child = await scope.spawn(options("process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)"));
    await once(child.stdout!, "data");
    await child.terminate();
    assert.equal((await child.exited).signal, "SIGKILL");
    await waitGone(child.pid);
    assert.ok(diagnostics.events.some(item => item.event === "child.spawn" && item.fields.childPid === child.pid));
    assert.ok(diagnostics.events.some(item => item.event === "child.term"));
    assert.ok(diagnostics.events.some(item => item.event === "child.kill"));
    assert.ok(diagnostics.events.some(item => item.event === "child.exit" && item.fields.signal === "SIGKILL"));
  } finally { await scope.close(); }
});

test("failed spawn can be followed by a successful spawn and scope close", async () => {
  const scope = await createProcessScope();
  try {
    await assert.rejects(scope.spawn({ ...options(""), executable: "/missing-alder-executable" }), { code: "ENOENT" });
    const child = await scope.spawn(options("process.exit(0)"));
    assert.equal((await child.exited).code, 0);
  } finally { await scope.close(); }
});

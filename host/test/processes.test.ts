import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { createProcessScope } from "../src/processes.js";

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

test("a child that ignores SIGTERM is stopped with bounded escalation", async () => {
  const scope = await createProcessScope();
  try {
    const child = await scope.spawn(options("process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)"));
    await once(child.stdout!, "data");
    await child.terminate();
    assert.equal((await child.exited).signal, "SIGKILL");
    await waitGone(child.pid);
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

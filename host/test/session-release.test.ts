import assert from "node:assert/strict";
import test from "node:test";
import { HOST_PROTOCOL } from "../src/protocol.js";
import { connectBackendSession, type AcquireNotebookSessionOptions, type BackendSessionDescriptor } from "../src/sessions.js";

const origin = "http://127.0.0.1:43123";
const continuityProof = "proof";
const descriptor: BackendSessionDescriptor = {
  sessionKey: "b".repeat(64), canonicalPath: "/tmp/session-release.R", origin,
  browserOrigin: "http://" + "c".repeat(32) + ".localhost:43123",
  epoch: "epoch", continuityProof, token: "a".repeat(64), capabilities: [],
};
const requested: AcquireNotebookSessionOptions = {
  path: descriptor.canonicalPath,
  resources: { root: "/tmp/alder", nodeExecutable: process.execPath, hostEntry: "/tmp/host.mjs" },
};
function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json", "X-Alder-Continuity-Proof": continuityProof } });
}
async function connect(context: test.TestContext, onRelease: (init: RequestInit) => Promise<Response>) {
  context.mock.method(globalThis, "fetch", async (_input: string | URL | Request, init?: RequestInit) => {
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body)) as { action?: string };
    if (init?.method === "GET") return json({ protocol: HOST_PROTOCOL, epoch: descriptor.epoch, continuityProof,
      sessionKey: descriptor.sessionKey, canonicalPath: descriptor.canonicalPath, capabilities: [], origin,
      browserOrigin: descriptor.browserOrigin, documentReady: true,
      configuration: { rscript: null, executionMode: "automatic", runOnStartup: true, deferStartup: true } });
    if (body?.action === "attach") return json({ leaseId: "lease", clientId: "client", epoch: descriptor.epoch });
    return onRelease(init ?? {});
  });
  return connectBackendSession(descriptor, requested);
}
test("release sends one detach and stops heartbeat even when callers overlap", async context => {
  let releases = 0;
  let body: unknown;
  const connection = await connect(context, async init => {
    releases += 1; body = JSON.parse(String(init.body));
    await new Promise(resolve => setImmediate(resolve));
    return json({ released: true });
  });
  await Promise.all([connection.release(), connection.release()]);
  await connection.release();
  assert.equal(releases, 1);
  assert.deepEqual(body, { action: "release", leaseId: "lease" });
  await connection.heartbeat();
  await assert.rejects(connection.request("/api/identity"), /lease is released/);
});
test("failed detach is not retried and cannot leave an active local request", async context => {
  let releases = 0;
  const connection = await connect(context, async () => { releases += 1; return json({ error: "offline" }, 503); });
  await assert.rejects(connection.release(), /release failed \(503\)/);
  await assert.rejects(connection.release(), /release failed \(503\)/);
  assert.equal(releases, 1);
  await assert.rejects(connection.request("/api/identity"), /lease is released/);
});
test("stalled detach times out once", { timeout: 3_000 }, async context => {
  let releases = 0;
  const connection = await connect(context, async init => {
    releases += 1;
    return new Promise<Response>((_resolve, reject) => {
      const signal = init.signal!;
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  });
  await assert.rejects(connection.release(), error => error instanceof Error && error.name === "TimeoutError");
  await assert.rejects(connection.release());
  assert.equal(releases, 1);
});

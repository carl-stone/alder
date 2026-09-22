import assert from "node:assert/strict";
import test from "node:test";

import { HOST_PROTOCOL } from "../src/protocol.js";
import { connectBackendSession, type AcquireNotebookSessionOptions, type BackendSessionDescriptor } from "../src/sessions.js";

const origin = "http://127.0.0.1:43123";
const browserOrigin = "http://" + "c".repeat(32) + ".localhost:43123";
const continuityProof = "proof";
const descriptor: BackendSessionDescriptor = {
  sessionKey: "b".repeat(64), canonicalPath: "/tmp/session-release.R", origin, browserOrigin,
  epoch: "epoch", continuityProof, token: "a".repeat(64), capabilities: [],
};
const requested: AcquireNotebookSessionOptions = {
  path: descriptor.canonicalPath,
  resources: { root: "/tmp/alder", nodeExecutable: process.execPath, hostEntry: "/tmp/host.mjs" },
};

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json", "X-Alder-Continuity-Proof": continuityProof } });
}

function identity(): Record<string, unknown> {
  return {
    protocol: HOST_PROTOCOL, epoch: descriptor.epoch, continuityProof, sessionKey: descriptor.sessionKey,
    canonicalPath: descriptor.canonicalPath, capabilities: [], origin, browserOrigin,
    documentReady: true, configuration: { rscript: null, executionMode: "automatic", runOnStartup: true, deferStartup: true },
  };
}

async function connectWithFetch(context: test.TestContext, releaseFetch: (init: RequestInit) => Promise<Response>): Promise<ReturnType<typeof connectBackendSession> extends Promise<infer T> ? T : never> {
  context.mock.method(globalThis, "fetch", async (_input: string | URL | Request, init?: RequestInit) => {
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body)) as { action?: string };
    if (init?.method === "GET") return json(identity());
    if (body?.action === "attach") return json({ leaseId: "lease", clientId: "client", epoch: descriptor.epoch });
    return releaseFetch(init ?? {});
  });
  return connectBackendSession(descriptor, requested);
}

test("SessionConnection propagates a non-success release and retries the exact discard", async context => {
  let attempts = 0;
  const connection = await connectWithFetch(context, async () => {
    attempts += 1;
    return attempts === 1 ? json({ error: "unavailable" }, 503) : json({ released: true });
  });
  await assert.rejects(connection.release("discard"), /release failed \(503\)/);
  await connection.release("discard");
  await connection.release("discard");
  assert.equal(attempts, 2);
});

test("SessionConnection propagates a transport rejection and retries", async context => {
  let attempts = 0;
  const connection = await connectWithFetch(context, async () => {
    attempts += 1;
    if (attempts === 1) throw new TypeError("EXACT_TRANSPORT_FAILURE");
    return json({ released: true });
  });
  await assert.rejects(connection.release("discard"), /EXACT_TRANSPORT_FAILURE/);
  await connection.release("discard");
  assert.equal(attempts, 2);
});

test("abandoning failed releases stops each replaced connection's heartbeat", async context => {
  const callbacks = new Map<object, () => void>();
  const intervals = context.mock.method(globalThis, "setInterval", (callback: () => void) => {
    const handle = { unref: () => undefined };
    callbacks.set(handle, callback);
    return handle as unknown as ReturnType<typeof setInterval>;
  });
  context.mock.method(globalThis, "clearInterval", (handle: ReturnType<typeof setInterval>) => { callbacks.delete(handle); });
  let heartbeats = 0;
  context.mock.method(globalThis, "fetch", async (_input: string | URL | Request, init?: RequestInit) => {
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body)) as { action?: string };
    if (init?.method === "GET") return json(identity());
    if (body?.action === "attach" || body?.action === "heartbeat") {
      if (body.action === "heartbeat") heartbeats += 1;
      return json({ leaseId: "lease", clientId: "client", epoch: descriptor.epoch });
    }
    throw new Error("dead backend");
  });
  const first = await connectBackendSession(descriptor, requested);
  await assert.rejects(first.release(), /dead backend/);
  first.abandon();
  const second = await connectBackendSession(descriptor, requested);
  await assert.rejects(second.release(), /dead backend/);
  second.abandon();
  const third = await connectBackendSession(descriptor, requested);
  assert.equal(intervals.mock.callCount(), 3);
  assert.equal(callbacks.size, 1);
  for (const callback of callbacks.values()) callback();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(heartbeats, 1);
  await assert.rejects(first.release(), /abandoned locally/);
  third.abandon();
  assert.equal(callbacks.size, 0);
});

test("SessionConnection aborts a stalled release and starts a new discard attempt", { timeout: 3_000 }, async context => {
  let attempts = 0;
  const connection = await connectWithFetch(context, async init => {
    attempts += 1;
    if (attempts > 1) return json({ released: true });
    return new Promise<Response>((_resolve, reject) => {
      const signal = init.signal;
      if (!signal) return reject(new Error("release request omitted its timeout signal"));
      const abort = () => reject(signal.reason);
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    });
  });
  await assert.rejects(connection.release("discard"), error => error instanceof Error && error.name === "TimeoutError");
  await connection.release("discard");
  assert.equal(attempts, 2);
});

test("SessionConnection escalates a confirmed normal release to one discard", async context => {
  const dispositions: string[] = [];
  const connection = await connectWithFetch(context, async init => {
    dispositions.push((JSON.parse(String(init.body)) as { disposition: string }).disposition);
    return json({ released: true });
  });
  await connection.release("normal");
  await connection.release("discard");
  await connection.release("discard");
  assert.deepEqual(dispositions, ["normal", "discard"]);
});

test("SessionConnection serializes a gated normal release before one discard escalation", async context => {
  const dispositions: string[] = [];
  const normal = Promise.withResolvers<void>();
  const connection = await connectWithFetch(context, async init => {
    const disposition = (JSON.parse(String(init.body)) as { disposition: string }).disposition;
    dispositions.push(disposition);
    if (disposition === "normal") await normal.promise;
    return json({ released: true });
  });
  const normalRelease = connection.release("normal");
  const firstDiscard = connection.release("discard");
  const secondDiscard = connection.release("discard");
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(dispositions, ["normal"]);
  normal.resolve();
  await Promise.all([normalRelease, firstDiscard, secondDiscard]);
  assert.deepEqual(dispositions, ["normal", "discard"]);
});

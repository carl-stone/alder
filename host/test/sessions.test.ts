import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { HOST_PROTOCOL } from "../src/protocol.js";
import { connectBackendSession, listUntitledRecoveryDescriptors, registerUntitledRecoveryDescriptor, retireUntitledRecoveryDescriptor, selectUntitledRecoveryDescriptor } from "../src/sessions.js";

test("untitled recovery can be listed, selected, and retired", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "alder-untitled-descriptor-"))); const id = randomUUID();
  try {
    const created = await registerUntitledRecoveryDescriptor(id, root, root);
    assert.deepEqual(await selectUntitledRecoveryDescriptor(id, root), created);
    assert.deepEqual(await listUntitledRecoveryDescriptors(root), [created]);
    await retireUntitledRecoveryDescriptor(created, root);
    assert.deepEqual(await listUntitledRecoveryDescriptors(root), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a normally released lease can finish after its loopback host exits, while an active lease cannot", async () => {
  const sessionKey = "d".repeat(64);
  const canonicalPath = "/tmp/alder-closed-host.R";
  const continuityProof = "proof";
  let origin = "";
  let nextLease = 0;
  const server = createServer(async (request, response) => {
    const send = (value: unknown) => {
      response.writeHead(200, { "Content-Type": "application/json", "X-Alder-Continuity-Proof": continuityProof });
      response.end(JSON.stringify(value));
    };
    if (request.url === "/api/identity") {
      send({ protocol: HOST_PROTOCOL, epoch: "epoch", continuityProof, sessionKey, canonicalPath,
        capabilities: [], origin, browserOrigin: origin, address: { host: "127.0.0.1", port: Number(new URL(origin).port), origin, browserOrigin: origin },
        documentReady: true, configuration: { rscript: null, executionMode: "automatic", runOnStartup: true, deferStartup: true } });
      return;
    }
    let body = "";
    for await (const chunk of request) body += chunk;
    const action = (JSON.parse(body) as { action: string }).action;
    if (action === "attach") send({ leaseId: `lease-${++nextLease}`, clientId: `client-${nextLease}`, epoch: "epoch" });
    else send({ released: true });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("loopback server has no port");
  origin = `http://127.0.0.1:${address.port}`;
  try {
    const descriptor = { sessionKey, canonicalPath, origin, browserOrigin: origin, epoch: "epoch", continuityProof,
      token: "a".repeat(64), capabilities: [] };
    const options = { path: canonicalPath, resources: { root: "/tmp/alder-resources", nodeExecutable: "/usr/bin/node", hostEntry: "/tmp/alder-host.mjs" } };
    const closedLease = await connectBackendSession(descriptor, options);
    const activeLease = await connectBackendSession(descriptor, options);
    await closedLease.release();
    await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    });
    await closedLease.release();
    await assert.rejects(activeLease.release());
  } finally {
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

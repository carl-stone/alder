import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, rename, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  acquireNotebookOwnership,
  acquireNotebookSession,
  listUntitledRecoveryDescriptors,
  registerUntitledRecoveryDescriptor,
  retireUntitledRecoveryDescriptor,
  selectUntitledRecoveryDescriptor,
  SessionAuthError,
  SessionUnavailableError,
  untitledRecoveryDescriptorDirectory,
  type NotebookOwnership,
  type UntitledRecoveryDescriptor,
} from "../src/sessions.js";
import { HOST_PROTOCOL } from "../src/protocol.js";

function keyFor(canonicalPath: string): string {
  return createHash("sha256").update("path:" + canonicalPath).digest("hex");
}

function currentProcessStartIdentity(): string {
  try {
    const stat = readFileSync("/proc/" + process.pid + "/stat", "utf8");
    const close = stat.lastIndexOf(")");
    const startTime = stat.slice(close + 2).split(" ")[19];
    return startTime === undefined ? "test-owner-start" : `linux:${startTime}`;
  } catch {
    return "test-owner-start";
  }
}

function browserOriginFor(port: number): string {
  return "http://" + "a".repeat(32) + ".localhost:" + port;
}

function addressFor(port: number): { host: string; port: number; origin: string; browserOrigin: string } {
  return { host: "127.0.0.1", port, origin: "http://127.0.0.1:" + port, browserOrigin: browserOriginFor(port) };
}

function registryPath(runtimeDirectory: string, canonicalPath: string): string {
  return join(runtimeDirectory, keyFor(canonicalPath) + ".json");
}

async function readRegistry(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

async function absent(path: string): Promise<void> {
  await assert.rejects(lstat(path), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");
}

async function closeOwnership(owner: NotebookOwnership | undefined): Promise<void> {
  await owner?.close().catch(() => undefined);
}

async function waitForFile(path: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await lstat(path);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path}`);
      await new Promise(resolveDelay => setTimeout(resolveDelay, 10));
    }
  }
}
function waitForChild(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise(resolveExit => child.once("exit", () => resolveExit()));
}

test("dead stale claim reclamation is serialized to one owner", async () => {
  const root = await mkdtemp(join(tmpdir(), "alder-session-reclaim-race-"));
  const runtimeDirectory = join(root, "runtime");
  const notebook = join(root, "notebook.R");
  const canonicalPath = resolve(notebook);
  let key!: string;
  let registry!: string;
  let lockPath!: string;
  const goPath = join(root, "go");
  const releasePath = join(root, "release");
  const sourcePath = resolve(new URL("../src/sessions.ts", import.meta.url).pathname);
  const hostDirectory = resolve(new URL("..", import.meta.url).pathname);
  const stale = {
    state: "ready",
    pid: 2_000_000_000,
    processNonce: randomUUID(),
    continuityProof: randomUUID(),
    startIdentity: "dead-owner-start",
    canonicalPath,
    origin: "http://127.0.0.1:1",
    epoch: randomUUID(),
    token: "0".repeat(64),
    protocol: HOST_PROTOCOL,
  };
  const workerSource = [
    "import { existsSync, writeFileSync } from 'node:fs';",
    "import { pathToFileURL } from 'node:url';",
    "const { acquireNotebookOwnership } = await import(pathToFileURL(process.env.ALDER_SESSION_SOURCE).href);",
    "const readyPath = process.env.ALDER_SESSION_READY;",
    "const resultPath = process.env.ALDER_SESSION_RESULT;",
    "const runtimeDirectory = process.env.ALDER_SESSION_RUNTIME;",
    "const notebook = process.env.ALDER_SESSION_NOTEBOOK;",
    "writeFileSync(readyPath, 'ready');",
    "while (!existsSync(process.env.ALDER_SESSION_GO)) await new Promise(resolveDelay => setTimeout(resolveDelay, 10));",
    "try {",
    "  const owner = await acquireNotebookOwnership({ path: notebook, runtimeDirectory, origin: 'http://127.0.0.1:41780' });",
    "  writeFileSync(resultPath, JSON.stringify({ ok: true, pid: owner.pid, processNonce: owner.processNonce, epoch: owner.epoch }));",
    "  while (!existsSync(process.env.ALDER_SESSION_RELEASE)) await new Promise(resolveDelay => setTimeout(resolveDelay, 10));",
    "  await owner.close();",
    "} catch (error) {",
    "  writeFileSync(resultPath, JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));",
    "}",
  ].join(String.fromCharCode(10));
  await mkdir(runtimeDirectory, { recursive: true, mode: 0o700 });
  await writeFile(notebook, "notebook" + String.fromCharCode(10));
  key = keyFor(canonicalPath);
  registry = registryPath(runtimeDirectory, canonicalPath);
  lockPath = join(runtimeDirectory, key + ".json.lock");
  await writeFile(registry, JSON.stringify(stale), { mode: 0o600 });
  await mkdir(lockPath, { recursive: true });
  const old = new Date(Date.now() - 120_000);
  await utimes(lockPath, old, old);
  const children = [0, 1].map(index => spawn(process.execPath, ["--import", "tsx/esm", "--input-type=module", "--eval", workerSource], {
    cwd: hostDirectory,
    env: {
      ...process.env,
      ALDER_SESSION_SOURCE: sourcePath,
      ALDER_SESSION_RUNTIME: runtimeDirectory,
      ALDER_SESSION_NOTEBOOK: canonicalPath,
      ALDER_SESSION_GO: goPath,
      ALDER_SESSION_RELEASE: releasePath,
      ALDER_SESSION_READY: join(root, "ready-" + index),
      ALDER_SESSION_RESULT: join(root, "result-" + index),
    },
    stdio: "ignore",
  }));
  try {
    await Promise.all([0, 1].map(index => waitForFile(join(root, "ready-" + index))));
    await writeFile(goPath, "go");
    await Promise.all([0, 1].map(index => waitForFile(join(root, "result-" + index))));
    const results = [0, 1].map(index => JSON.parse(readFileSync(join(root, "result-" + index), "utf8")) as Record<string, unknown>);
    const winners = results.filter(result => result.ok === true);
    assert.equal(winners.length, 1);
    assert.equal(results.length - winners.length, 1);
    const current = await readRegistry(registry);
    assert.equal(current.state, "starting");
    assert.equal(current.processNonce, winners[0]!.processNonce);
    assert.equal(new Set(results.map(result => result.processNonce).filter(value => typeof value === "string")).size, 1);
    await writeFile(releasePath, "release");
    await Promise.all(children.map(child => waitForChild(child)));
  } finally {
    await writeFile(goPath, "go").catch(() => undefined);
    await writeFile(releasePath, "release").catch(() => undefined);
    for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
    await Promise.allSettled(children.map(child => waitForChild(child)));
    await rm(root, { recursive: true, force: true });
  }
});
test("hard-link aliases retain distinct canonical path ownership", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "alder-session-hardlink-"));
  const runtimeDirectory = join(root, "runtime");
  const firstPath = join(root, "first.R");
  const aliasPath = join(root, "alias.R");
  let firstOwner: NotebookOwnership | undefined;
  let secondOwner: NotebookOwnership | undefined;
  try {
    await mkdir(runtimeDirectory, { recursive: true, mode: 0o700 });
    await writeFile(firstPath, "notebook" + String.fromCharCode(10));
    await link(firstPath, aliasPath);
    firstOwner = await acquireNotebookOwnership({ path: firstPath, runtimeDirectory, origin: "http://127.0.0.1:41782" });
    secondOwner = await acquireNotebookOwnership({ path: aliasPath, runtimeDirectory, origin: "http://127.0.0.1:41783" });
    assert.equal(firstOwner.sessionKey, keyFor(resolve(firstPath)));
    assert.equal(secondOwner.sessionKey, keyFor(resolve(aliasPath)));
    assert.notEqual(firstOwner.sessionKey, secondOwner.sessionKey);
  } finally {
    await closeOwnership(secondOwner);
    await closeOwnership(firstOwner);
    await rm(root, { recursive: true, force: true });
  }
});

test("atomic notebook replacement cannot create a second owner", async () => {
  const root = await mkdtemp(join(tmpdir(), "alder-session-replacement-"));
  const runtimeDirectory = join(root, "runtime");
  const notebook = join(root, "notebook.R");
  const staged = join(root, "staged.R");
  let owner: NotebookOwnership | undefined;
  try {
    await mkdir(runtimeDirectory, { recursive: true, mode: 0o700 });
    await writeFile(notebook, "before\n");
    owner = await acquireNotebookOwnership({ path: notebook, runtimeDirectory, origin: "http://127.0.0.1:41782" });
    await writeFile(staged, "after\n");
    await rename(staged, notebook);
    await assert.rejects(
      acquireNotebookOwnership({ path: notebook, runtimeDirectory, origin: "http://127.0.0.1:41783" }),
      error => error instanceof SessionUnavailableError && error.code === "session_unavailable",
    );
    assert.equal(owner.sessionKey, keyFor(resolve(notebook)));
  } finally {
    await closeOwnership(owner);
    await rm(root, { recursive: true, force: true });
  }
});

test("session lease release sends the release action exactly once", async () => {
  const root = await mkdtemp(join(tmpdir(), "alder-session-release-"));
  const runtimeDirectory = join(root, "runtime");
  const notebook = join(root, "notebook.R");
  const canonicalPath = resolve(notebook);
  await writeFile(notebook, "notebook" + String.fromCharCode(10));
  const sessionKey = keyFor(canonicalPath);
  const origin = "http://127.0.0.1:41781";
  const browserOrigin = browserOriginFor(41781);
  const epoch = randomUUID();
  const processNonce = randomUUID();
  const continuityProof = randomUUID();
  const token = "1".repeat(64);
  const leaseId = randomUUID();
  const clientId = randomUUID();
  const registry = registryPath(runtimeDirectory, canonicalPath);
  const requests: Array<{ path: string; body: Record<string, unknown> | undefined }> = [];
  const originalFetch = globalThis.fetch;
  const identity = {
    protocol: HOST_PROTOCOL,
    epoch,
    processNonce,
    continuityProof,
    sessionKey,
    canonicalPath,
    capabilities: [],
    origin,
    browserOrigin,
    address: addressFor(41781),
    documentReady: true,
    configuration: { rscript: null, executionMode: "automatic", runOnStartup: false, deferStartup: false },
  };
  const lease = { leaseId, clientId, nextCommandSequence: 1, epoch };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : undefined;
    requests.push({ path: url.pathname, body });
    const responseBody = url.pathname === "/api/identity" ? identity : lease;
    return new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "X-Alder-Continuity-Proof": continuityProof,
      },
    });
  }) as typeof fetch;
  try {
    await mkdir(runtimeDirectory, { recursive: true, mode: 0o700 });
    await writeFile(registry, JSON.stringify({
      state: "ready",
      pid: process.pid,
      processNonce,
      continuityProof,
      startIdentity: currentProcessStartIdentity(),
      canonicalPath,
      origin,
      address: addressFor(41781),
      epoch,
      token,
      protocol: HOST_PROTOCOL,
    }), { mode: 0o600 });
    const connection = await acquireNotebookSession({ path: notebook, runtimeDirectory });
    await connection.release();
    await connection.release();
    assert.deepEqual(requests.filter(request => request.path === "/api/lease").map(request => request.body), [
      { action: "attach" },
      { action: "release", leaseId },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});
test("prepared Save As reserves an absent target while preserving source authority and identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "alder-sessions-"));
  const runtimeDirectory = join(root, "runtime");
  const source = join(root, "source.R");
  const destination = join(root, "renamed.R");
  await writeFile(source, "source\n");
  const canonicalSource = resolve(source);
  const canonicalDestination = resolve(destination);
  const sourceRegistry = registryPath(runtimeDirectory, canonicalSource);
  const destinationRegistry = registryPath(runtimeDirectory, canonicalDestination);
  let owner: NotebookOwnership | undefined;
  try {
    owner = await acquireNotebookOwnership({
      path: source,
      runtimeDirectory,
      origin: "http://127.0.0.1:41777",
    });
    await owner.publishReady("http://127.0.0.1:41777", addressFor(41777));
    const identity = {
      epoch: owner.epoch,
      processNonce: owner.processNonce,
      token: owner.token,
      pid: owner.pid,
    };
    const prepared = await owner.prepareRekey(destination);

    await absent(destination);
    const sourceBefore = await readRegistry(sourceRegistry);
    const destinationPending = await readRegistry(destinationRegistry);
    assert.equal(sourceBefore.state, "ready");
    assert.equal(sourceBefore.canonicalPath, canonicalSource);
    assert.equal(destinationPending.state, "starting");
    assert.equal(destinationPending.canonicalPath, canonicalDestination);
    for (const field of Object.keys(identity)) assert.equal(destinationPending[field], identity[field as keyof typeof identity]);

    await assert.rejects(
      acquireNotebookOwnership({ path: destination, runtimeDirectory }),
      (error: unknown) => error instanceof SessionUnavailableError && error.code === "session_unavailable",
    );
    assert.deepEqual(await readRegistry(sourceRegistry), sourceBefore);

    let publicationPrepared = false;
    let binderCalled = false;
    await prepared.commit(async () => {
      publicationPrepared = true;
      assert.equal((await readRegistry(destinationRegistry)).state, "starting");
      return () => {
        binderCalled = true;
      };
    });
    assert.equal(publicationPrepared, true);
    assert.equal(binderCalled, true);
    assert.equal(owner.canonicalPath, canonicalDestination);
    assert.equal(owner.sessionKey, keyFor(canonicalDestination));
    assert.equal(owner.epoch, identity.epoch);
    assert.equal(owner.processNonce, identity.processNonce);
    assert.equal(owner.token, identity.token);
    assert.equal(owner.pid, identity.pid);
    const destinationReady = await readRegistry(destinationRegistry);
    assert.equal(destinationReady.state, "ready");
    assert.equal(destinationReady.canonicalPath, canonicalDestination);
    assert.deepEqual(destinationReady.address, sourceBefore.address);
    await absent(sourceRegistry);
  } finally {
    await closeOwnership(owner);
    await rm(root, { recursive: true, force: true });
  }
});
test("failed Save As publication rolls back destination ownership and preserves the source", async () => {
  const root = await mkdtemp(join(tmpdir(), "alder-sessions-publication-failure-"));
  const runtimeDirectory = join(root, "runtime");
  const source = join(root, "source.R");
  const destination = join(root, "renamed.R");
  await writeFile(source, "source\n");
  const canonicalSource = resolve(source);
  const canonicalDestination = resolve(destination);
  const sourceRegistry = registryPath(runtimeDirectory, canonicalSource);
  const destinationRegistry = registryPath(runtimeDirectory, canonicalDestination);
  const destinationLock = join(runtimeDirectory, keyFor(canonicalDestination) + ".json.lock");
  let owner: NotebookOwnership | undefined;
  let replacement: NotebookOwnership | undefined;
  try {
    owner = await acquireNotebookOwnership({ path: source, runtimeDirectory, origin: "http://127.0.0.1:41779" });
    await owner.publishReady("http://127.0.0.1:41779", addressFor(41779));
    const sourceBefore = await readRegistry(sourceRegistry);
    const prepared = await owner.prepareRekey(destination);
    let binderCalls = 0;
    await assert.rejects(
      prepared.commit(async () => () => {
        binderCalls += 1;
        throw new Error("publication binding failed");
      }),
      /publication binding failed/,
    );
    assert.equal(binderCalls, 1);
    assert.equal(owner.canonicalPath, canonicalSource);
    assert.equal(owner.sessionKey, keyFor(canonicalSource));
    assert.deepEqual(await readRegistry(sourceRegistry), sourceBefore);
    await absent(destinationRegistry);
    await absent(destinationLock);

    replacement = await acquireNotebookOwnership({ path: destination, runtimeDirectory, origin: "http://127.0.0.1:41780" });
  } finally {
    await closeOwnership(replacement);
    await closeOwnership(owner);
    await rm(root, { recursive: true, force: true });
  }
});

test("aborting prepared Save As removes only the exact reservation and preserves foreign artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "alder-sessions-"));
  const runtimeDirectory = join(root, "runtime");
  const source = join(root, "source.R");
  const destination = join(root, "renamed.R");
  await writeFile(source, "source\n");
  const canonicalSource = resolve(source);
  const canonicalDestination = resolve(destination);
  const sourceRegistry = registryPath(runtimeDirectory, canonicalSource);
  const destinationRegistry = registryPath(runtimeDirectory, canonicalDestination);
  let owner: NotebookOwnership | undefined;
  try {
    owner = await acquireNotebookOwnership({ path: source, runtimeDirectory, origin: "http://127.0.0.1:41778" });
    await owner.publishReady("http://127.0.0.1:41778", addressFor(41778));
    const sourceBefore = await readRegistry(sourceRegistry);
    const occupied = join(root, "occupied.R");
    await writeFile(occupied, "already here\n");
    await assert.rejects(
      owner.prepareRekey(occupied),
      (error: unknown) => error instanceof SessionUnavailableError && error.code === "session_unavailable",
    );
    const prepared = await owner.prepareRekey(destination);
    await prepared.abort();
    await prepared.abort();
    await absent(destinationRegistry);
    await absent(join(runtimeDirectory, keyFor(canonicalDestination) + ".json.lock"));
    assert.deepEqual(await readRegistry(sourceRegistry), sourceBefore);

    const failed = await owner.prepareRekey(destination);
    await assert.rejects(
      failed.commit(async () => {
        throw new Error("publication preparation failed");
      }),
      /publication preparation failed/,
    );
    await absent(destinationRegistry);
    await absent(join(runtimeDirectory, keyFor(canonicalDestination) + ".json.lock"));

    const second = await owner.prepareRekey(destination);
    const reservation = await readRegistry(destinationRegistry);
    const foreign = { ...reservation, processNonce: randomUUID(), token: "f".repeat(64) };
    await writeFile(destinationRegistry, JSON.stringify(foreign), { mode: 0o600 });
    await second.abort();
    assert.deepEqual(await readRegistry(destinationRegistry), foreign);
    await rm(destinationRegistry, { force: true });
  } finally {
    await closeOwnership(owner);
    await rm(root, { recursive: true, force: true });
  }
});

test("untitled recovery descriptors are independent and retirement is identity-guarded", async () => {
  const root = await mkdtemp(join(tmpdir(), "alder-untitled-recovery-"));
  const dataRoot = join(root, "data");
  const projectA = resolve(join(root, "project-a"));
  const projectB = resolve(join(root, "project-b"));
  const firstId = randomUUID();
  const secondId = randomUUID();
  try {
    const first = await registerUntitledRecoveryDescriptor(firstId, projectA, dataRoot);
    assert.deepEqual(Object.keys(first).sort(), ["createdAt", "id", "projectDirectory", "schemaVersion"]);
    assert.equal(first.schemaVersion, 1);
    assert.equal(first.id, firstId);
    assert.equal(first.projectDirectory, projectA);
    const directory = untitledRecoveryDescriptorDirectory(dataRoot);
    assert.equal((await lstat(directory)).mode & 0o777, 0o700);
    const descriptorPath = join(directory, firstId + ".json");
    assert.equal((await lstat(descriptorPath)).mode & 0o777, 0o600);
    assert.deepEqual(await selectUntitledRecoveryDescriptor(firstId, dataRoot), first);
    assert.deepEqual(await registerUntitledRecoveryDescriptor(firstId, projectA, dataRoot), first);

    const second = await registerUntitledRecoveryDescriptor(secondId, projectB, dataRoot);
    const listed = await listUntitledRecoveryDescriptors(dataRoot);
    assert.deepEqual(listed.map(value => value.id).sort(), [firstId, secondId].sort());

    const replacement: UntitledRecoveryDescriptor = { ...first, projectDirectory: projectB };
    await writeFile(descriptorPath, JSON.stringify(replacement) + "\n");
    await assert.rejects(
      retireUntitledRecoveryDescriptor(first, dataRoot),
      (error: unknown) => error instanceof SessionUnavailableError && /changed before retirement/.test(error.message),
    );
    assert.deepEqual(await selectUntitledRecoveryDescriptor(firstId, dataRoot), replacement);
    await retireUntitledRecoveryDescriptor(replacement, dataRoot);
    await retireUntitledRecoveryDescriptor(second, dataRoot);
    await assert.rejects(selectUntitledRecoveryDescriptor(firstId, dataRoot), SessionUnavailableError);
    assert.deepEqual(await listUntitledRecoveryDescriptors(dataRoot), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("configured external auth requires a paired exact HTTPS origin and token file", async () => {
  const resources = {};
  const cases = [
    { externalOrigin: "https://proxy.example" },
    { tokenFile: "/tmp/alder-token" },
    { externalOrigin: "http://proxy.example", tokenFile: "/tmp/alder-token" },
  ];
  for (const options of cases) {
    await assert.rejects(
      acquireNotebookSession({ path: null, resources, ...options }),
      (error: unknown) => error instanceof SessionAuthError,
    );
  }
});

test("configured external auth refuses attaching to an existing owner", async () => {
  const root = await mkdtemp(join(tmpdir(), "alder-session-auth-owner-"));
  const runtimeDirectory = join(root, "runtime");
  const notebook = join(root, "notebook.R");
  await writeFile(notebook, "notebook");
  let owner: NotebookOwnership | undefined;
  try {
    owner = await acquireNotebookOwnership({ path: notebook, runtimeDirectory });
    await owner.publishReady("http://127.0.0.1:41779", addressFor(41779));
    await assert.rejects(
      acquireNotebookSession({
        path: notebook,
        runtimeDirectory,
        resources: {},
        externalOrigin: "https://proxy.example",
        tokenFile: join(root, "missing-token"),
      }),
      (error: unknown) => error instanceof SessionUnavailableError && /cannot attach to an existing notebook host/.test(error.message),
    );
  } finally {
    await closeOwnership(owner);
    await rm(root, { recursive: true, force: true });
  }
});

test("configured external auth reaches detached candidates without exposing the bearer", async () => {
  const root = await mkdtemp(join(tmpdir(), "alder-session-auth-argv-"));
  const runtimeDirectory = join(root, "runtime");
  const notebook = join(root, "notebook.R");
  const tokenFile = join(root, "token");
  const captureFile = join(root, "spawn-request.json");
  const supervisor = join(root, "capture-supervisor.mjs");
  const hostEntry = join(root, "host-entry.mjs");
  const bearer = "0123456789abcdef".repeat(4);
  await writeFile(notebook, "notebook");
  await writeFile(tokenFile, bearer);
  await chmod(tokenFile, 0o600);
  const supervisorScript = [
    "#!/usr/bin/env node",
    'import { createReadStream, createWriteStream, writeFileSync } from "node:fs";',
    "const capturePath = " + JSON.stringify(captureFile) + ";",
    "const input = createReadStream(null, { fd: 3 });",
    "const output = createWriteStream(null, { fd: 4 });",
    "function send(value, exit = false) {",
    "  const body = Buffer.from(JSON.stringify(value));",
    "  const frame = Buffer.allocUnsafe(body.byteLength + 4);",
    "  frame.writeUInt32LE(body.byteLength, 0);",
    "  body.copy(frame, 4);",
    "  output.write(frame, () => { if (exit) process.exit(0); });",
    "}",
    'send({ v: 1, type: "hello" });',
    "let buffer = Buffer.alloc(0);",
    'input.on("data", chunk => {',
    "  buffer = Buffer.concat([buffer, chunk]);",
    "  while (buffer.byteLength >= 4) {",
    "    const length = buffer.readUInt32LE(0);",
    "    if (buffer.byteLength < length + 4) return;",
    "    const body = buffer.subarray(4, length + 4);",
    "    buffer = buffer.subarray(length + 4);",
    '    const event = JSON.parse(body.toString("utf8"));',
    '    if (event.op === "spawn") {',
    "      writeFileSync(capturePath, JSON.stringify(event));",
    '      send({ v: 1, type: "error", id: event.id, code: "fixture", message: "argv captured" });',
    '    } else if (event.op === "terminate" || event.op === "close") {',
    '      send({ v: 1, type: "closed" }, true);',
    "    }",
    "  }",
    "});",
  ].join("\n") + "\n";
  await writeFile(supervisor, supervisorScript, { mode: 0o755 });
  await chmod(supervisor, 0o755);
  try {
    await assert.rejects(
      acquireNotebookSession({
        path: notebook,
        runtimeDirectory,
        resources: {
          root,
          nodeExecutable: process.execPath,
          hostEntry,
          processSupervisorExecutable: supervisor,
        },
        externalOrigin: "https://proxy.example",
        tokenFile,
        startupTimeoutMs: 1_000,
        deferStartup: true,
      }),
      (error: unknown) => error instanceof Error && !error.message.includes(bearer),
    );
    const request = JSON.parse(await readFile(captureFile, "utf8")) as { args: string[]; environment: Record<string, string> };
    assert.deepEqual(request.args, [hostEntry, "--internal-host", notebook, "--defer-startup", "--external-origin", "https://proxy.example", "--token-file", tokenFile]);
    assert.equal(JSON.stringify(request).includes(bearer), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

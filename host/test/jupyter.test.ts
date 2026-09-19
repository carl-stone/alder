import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { FrameProtocolError } from "../src/framing.js";
import { ArkKernel, decodeMessage, type ArkKernelOptions } from "../src/jupyter.js";
import { createProcessScope, type ProcessScope } from "../src/processes.js";
import type { ApplicationResources } from "../src/resources.js";

const DELIMITER = Buffer.from("<IDS|MSG>");
const KEY = "independent-test-key";
const APPLICATION_ROOT = process.env.ALDER_APPLICATION_ROOT;
const SELECTED_APPLICATION_ROOT = APPLICATION_ROOT === undefined ? undefined : resolve(APPLICATION_ROOT);
const ARK = SELECTED_APPLICATION_ROOT === undefined
  ? "alder-application-root-not-selected"
  : join(SELECTED_APPLICATION_ROOT, "runtime", "ark");
const NO_SPAWN_SCOPE = {
  spawn: async (): Promise<never> => { throw new Error("spawn not expected"); },
  close: async (): Promise<void> => {},
} satisfies ProcessScope;
const integration = { skip: APPLICATION_ROOT === undefined, timeout: 60_000 };

interface WireParts {
  header?: Buffer;
  parent?: Buffer;
  metadata?: Buffer;
  content?: Buffer;
  buffers?: Buffer[];
  identities?: Buffer[];
}

function wire(parts: WireParts = {}): Buffer[] {
  const json = [
    parts.header ?? Buffer.from(JSON.stringify({
      msg_id: "message-1",
      username: "ark",
      session: "kernel-session",
      date: "2026-09-06T00:00:00.000Z",
      msg_type: "comm_msg",
      version: "5.4",
    })),
    parts.parent ?? Buffer.from("{}"),
    parts.metadata ?? Buffer.from("{}"),
    parts.content ?? Buffer.from('{"value":"ok"}'),
  ];
  const digest = createHmac("sha256", KEY);
  for (const frame of json) digest.update(frame);
  return [
    ...(parts.identities ?? [Buffer.from("comm.topic")]),
    DELIMITER,
    Buffer.from(digest.digest("hex"), "ascii"),
    ...json,
    ...(parts.buffers ?? []),
  ];
}

function baseOptions(directory = tmpdir(), processScope: ProcessScope = NO_SPAWN_SCOPE): ArkKernelOptions {
  return {
    executable: ARK,
    startupFile: join(directory, "start.R"),
    connectionDirectory: join(directory, "connections"),
    cwd: directory,
    environment: process.env,
    startupTimeoutMs: 15_000,
    shutdownTimeoutMs: 1_000,
    processScope,
  };
}

function resourcesFor(root: string): ApplicationResources {
  return {
    root,
    cliLauncher: join(root, "bin", "alder"),
    hostEntry: join(root, "host", "alder-host.mjs"),
    rendererDirectory: join(root, "app"),
    workerDirectory: join(root, "worker"),
    rLibraryDirectory: join(root, "r-library"),
    arkExecutable: join(root, "runtime", "ark"),
    airExecutable: join(root, "runtime", "air"),
    quartoExecutable: join(root, "runtime", "quarto"),
    nodeExecutable: join(root, "bin", "node"),
    electronEntry: null,
  };
}

test("signed Jupyter wire messages preserve routing identities and extension buffers", () => {
  const binary = Buffer.from([0, 255, 1, 254]);
  const decoded = decodeMessage(wire({
    identities: [Buffer.from("topic"), Buffer.from("route")],
    buffers: [binary],
  }), KEY);

  assert.deepEqual(decoded.identities, [Buffer.from("topic"), Buffer.from("route")]);
  assert.equal(decoded.header.msg_type, "comm_msg");
  assert.deepEqual(decoded.content, { value: "ok" });
  assert.deepEqual(decoded.buffers, [binary]);
});

test("Jupyter decoder rejects unauthenticated, malformed, and over-limit messages", () => {
  const tampered = wire();
  tampered[2] = Buffer.from("0".repeat(64));
  assert.throws(() => decodeMessage(tampered, KEY), /signature does not match/);

  assert.throws(() => decodeMessage([Buffer.from("no delimiter")], KEY), /delimiter is missing/);
  assert.throws(
    () => decodeMessage([DELIMITER, Buffer.alloc(0), Buffer.from("{}")], KEY),
    /expected at least 5/,
  );

  const invalidUtf8 = wire({ content: Buffer.from([0xc3, 0x28]) });
  assert.throws(() => decodeMessage(invalidUtf8, KEY), /content: JSON is not valid UTF-8/);
  const arrayContent = wire({ content: Buffer.from("[]") });
  assert.throws(() => decodeMessage(arrayContent, KEY), /content must be an object/);

  const valid = wire();
  const bytes = valid.reduce((total, frame) => total + frame.length, 0);
  assert.throws(
    () => decodeMessage(valid, KEY, bytes - 1),
    /exceeds the configured byte limit/,
  );
});

test("Jupyter decoder accepts bounded execute_input source and rejects physical oversize", () => {
  const source = "x".repeat(9 * 1024 * 1024);
  const content = Buffer.from(JSON.stringify({ code: source }), "utf8");
  const header = Buffer.from(JSON.stringify({
    msg_id: "message-large-source",
    username: "ark",
    session: "kernel-session",
    date: "2026-09-06T00:00:00.000Z",
    msg_type: "execute_input",
    version: "5.4",
  }), "utf8");
  const frames = wire({ header, content });
  const physicalLimit = 16 * 1024 * 1024;
  const decoded = decodeMessage(frames, KEY, physicalLimit);
  assert.equal(decoded.header.msg_type, "execute_input");
  assert.equal(decoded.content.code, source);
  const total = frames.reduce((sum, frame) => sum + frame.length, 0);
  assert.equal(total <= physicalLimit, true);
  assert.throws(
    () => decodeMessage(frames, KEY, total - 1),
    /configured byte limit/,
  );
});

test("Ark options and preflight reject unsafe resource settings before spawning", async () => {
  assert.throws(
    () => new ArkKernel({ ...baseOptions(), startupTimeoutMs: 0 }),
    /startupTimeoutMs must be an integer/,
  );
  assert.throws(
    () => new ArkKernel({ ...baseOptions(), shutdownTimeoutMs: Number.NaN }),
    /shutdownTimeoutMs must be an integer/,
  );
  assert.throws(
    () => new ArkKernel({ ...baseOptions(), maxMessageBytes: 2_147_483_648 }),
    /maxMessageBytes must be an integer/,
  );

  const directory = await mkdtemp(join(tmpdir(), "alder-jupyter-preflight-"));
  try {
    await writeFile(join(directory, "start.R"), "options(ark.error_entrace=FALSE)\n");
    const kernel = new ArkKernel({ ...baseOptions(directory), executable: directory });
    await assert.rejects(kernel.start(), /not found or not executable/);
    assert.equal(kernel.processId, undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("live Ark cancellation settles the request and cannot poison the next execution", {
  ...integration,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "alder-jupyter-live-"));
  const connections = join(directory, "connections");
  await mkdir(connections);
  await writeFile(join(directory, "start.R"), "options(ark.error_entrace=FALSE)\n", { mode: 0o600 });
  const ownerScope = await createProcessScope(resourcesFor(SELECTED_APPLICATION_ROOT!));
  let ownedProcess: Awaited<ReturnType<ProcessScope["spawn"]>> | undefined;
  const processScope: ProcessScope = {
    spawn: async options => {
      const process = await ownerScope.spawn(options);
      ownedProcess = process;
      return process;
    },
    close: () => ownerScope.close(),
  };
  const kernel = new ArkKernel(baseOptions(directory, processScope));
  try {
    const [firstInfo, secondInfo] = await Promise.all([kernel.start(), kernel.start()]);
    assert.equal(firstInfo.implementation.toLowerCase(), "ark");
    assert.equal(firstInfo.implementationVersion, "0.1.252");
    assert.deepEqual(secondInfo, firstInfo);
    assert.equal(kernel.ready, true);
    assert.ok(ownedProcess !== undefined);

    const files = (await readdir(connections)).filter((file) => file.endsWith(".json"));
    assert.equal(files.length, 1);
    const connectionPath = join(connections, files[0]!);
    assert.equal((await stat(connectionPath)).mode & 0o777, 0o600);
    const connection = JSON.parse(await readFile(connectionPath, "utf8")) as Record<string, unknown>;
    assert.equal(connection.ip, "127.0.0.1");
    assert.equal(connection.signature_scheme, "hmac-sha256");
    assert.match(String(connection.key), /^[0-9a-f]{64}$/);

    const callbackMarker = join(directory, "callback-finished");
    await assert.rejects(kernel.execute(
      `Sys.sleep(0.2); writeLines("done", ${JSON.stringify(callbackMarker)}); 1 + 1`, {
      onMessage: () => { throw new Error("consumer callback failed"); },
      },
    ), /consumer callback failed/);
    // A consumer error must not settle the execution promise before the exact
    // shell reply and terminal idle. Otherwise the serial tail can launch the
    // next request while this one is still changing R state.
    assert.equal(await readFile(callbackMarker, "utf8"), "done\n");
    assert.equal(kernel.ready, true);

    let resolveEntered!: () => void;
    const entered = new Promise<void>((resolve) => { resolveEntered = resolve; });
    const before = Date.now();
    const interrupted = kernel.execute(
      'cat("alder-interrupt-ready\\n"); flush.console(); Sys.sleep(30); 99',
      {
        onMessage: (message) => {
          if (message.header.msg_type === "stream" &&
              typeof message.content.text === "string" &&
              message.content.text.includes("alder-interrupt-ready")) {
            resolveEntered();
          }
        },
      },
    );
    // Jupyter busy and execute_input can both precede entry into R evaluation.
    // A stream emitted by R itself gives the transport test a causal boundary.
    await entered;
    assert.equal(await kernel.interrupt(), true);
    const interruptedResult = await interrupted;
    assert.ok(Date.now() - before < 20_000, "control interrupt must preempt the sleep");
    assert.equal(interruptedResult.reply.content.status, "ok");

    // A delayed UI Stop can arrive after its cell completed. Ark acknowledges
    // an idle interrupt, and the next request must still execute normally.
    assert.equal(await kernel.interrupt(), true);
    const next = await kernel.execute("2 + 2");
    assert.equal(next.reply.content.status, "ok");
    const result = next.messages.find((message) => message.header.msg_type === "execute_result");
    assert.equal((result?.content.data as Record<string, unknown> | undefined)?.["text/plain"], "[1] 4");

    await assert.rejects(
      kernel.execute("x".repeat(8 * 1024 * 1024 + 1)),
      /source exceeds message limit/,
    );
    assert.equal((await kernel.execute("marker <- 42L")).reply.content.status, "ok");
    assert.equal((await kernel.execute("6 * 7")).reply.content.status, "ok");

    const auxiliary = kernel.execute("Sys.sleep(0.05); inspected <- TRUE", {}, { auxiliary: true });
    const afterInspection = kernel.execute("stopifnot(inspected, identical(marker, 42L)); 43L");
    assert.equal((await auxiliary).reply.content.status, "ok");
    assert.equal((await afterInspection).reply.content.status, "ok");
    const auxiliaryError = await kernel.execute("stop('inspection failed')", {}, { auxiliary: true });
    assert.equal(auxiliaryError.reply.content.status, "error");
    assert.match(String(auxiliaryError.reply.content.evalue), /inspection failed/);
    await assert.rejects(kernel.execute("NULL", {
      onMessage: () => { throw new Error("inspection consumer failed"); },
    }, { auxiliary: true }), /inspection consumer failed/);
    assert.equal((await kernel.execute("stopifnot(identical(marker, 42L)); 44L")).reply.content.status, "ok");

    await kernel.terminate();
    assert.equal(kernel.ready, false);
    assert.deepEqual(await readdir(connections), []);
    await assert.rejects(kernel.execute("1"), /unavailable/);
    await assert.rejects(kernel.start(), /closed/);
    await processScope.close();
    const owned = ownedProcess;
    assert.ok(owned !== undefined);
    await owned.exited;
  } finally {
    await kernel.terminate().catch(() => {});
    await processScope.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { Engine, type EngineOptions } from "../src/engine.js";
import { createProcessScope, type ProcessScope } from "../src/processes.js";
import type { ApplicationResources } from "../src/resources.js";
import { analysisResultSchema, type EvaluationPayload, type REnvironment } from "../src/protocol.js";

const applicationRoot = resolve(
  process.env.ALDER_APPLICATION_ROOT ?? process.env.ALDER_STAGED_ROOT ?? join(process.cwd(), ".application"),
);
const resourcesAvailable = existsSync(join(applicationRoot, "resources", "runtime", "ark")) &&
  existsSync(join(applicationRoot, "resources", "worker", "host-ark.R")) &&
  existsSync(join(applicationRoot, "resources", "r-library"));
const integration = { skip: !resourcesAvailable, timeout: 120_000 };

function resourcesFor(root: string): ApplicationResources {
  return {
    root,
    cliLauncher: join(root, "bin", "alder"),
    hostEntry: join(root, "resources", "host", "alder-host.mjs"),
    rendererDirectory: join(root, "resources", "app"),
    workerDirectory: join(root, "resources", "worker"),
    rLibraryDirectory: join(root, "resources", "r-library"),
    arkExecutable: join(root, "resources", "runtime", "ark"),
    airExecutable: join(root, "resources", "runtime", "air"),
    nodeExecutable: join(root, "resources", "runtime", "node"),
    processSupervisorExecutable: join(root, "resources", "runtime", "alder-process-supervisor"),
    electronEntry: null,
  };
}

function cleanEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (key === "R_HOME" || key.startsWith("R_LIBS") || key.startsWith("ALDER_")) delete environment[key];
  }
  return environment;
}

function selectedRscript(): string {
  if (process.env.ALDER_RSCRIPT !== undefined) return resolve(process.env.ALDER_RSCRIPT);
  return execFileSync("which", ["Rscript"], { encoding: "utf8", env: cleanEnvironment() }).trim();
}

function selectedEnvironment(resources: ApplicationResources): REnvironment {
  const rscript = selectedRscript();
  const environment = cleanEnvironment();
  const rHome = execFileSync(rscript, ["--vanilla", "--slave", "-e", "cat(R.home())"], {
    encoding: "utf8", env: environment,
  }).trim();
  const version = execFileSync(rscript, ["--vanilla", "--slave", "-e", "cat(as.character(getRversion()))"], {
    encoding: "utf8", env: environment,
  }).trim();
  const libraryPaths = execFileSync(rscript, ["--vanilla", "--slave", "-e", "writeLines(.libPaths())"], {
    encoding: "utf8", env: environment,
  }).trim().split(/\r?\n/).filter(Boolean);
  const ordered = [...new Set([resources.rLibraryDirectory, ...libraryPaths])];
  const identity = createHash("sha256").update(JSON.stringify({ rscript, rHome, version, ordered })).digest("hex");
  return { rscript, rHome, version, platform: process.platform, arch: process.arch, libraryPaths: ordered, identity };
}

async function openEngine(directory: string, overrides: Partial<EngineOptions> = {}): Promise<{
  engine: Engine;
  processScope: ProcessScope;
  environment: REnvironment;
}> {
  const resources = resourcesFor(applicationRoot);
  const environment = selectedEnvironment(resources);
  const processScope = await createProcessScope(resources);
  const engine = new Engine({
    resources,
    processScope,
    environment,
    notebookDirectory: directory,
    artifactDirectory: join(directory, "artifacts"),
    cacheDirectory: join(directory, "cache"),
    startupTimeoutMs: 45_000,
    shutdownTimeoutMs: 5_000,
    ...overrides,
  });
  return { engine, processScope, environment };
}

async function closeEngine(engine: Engine, processScope: ProcessScope, directory: string): Promise<void> {
  await engine.close().catch(() => {});
  await processScope.close().catch(() => {});
  await rm(directory, { recursive: true, force: true });
}

function payload(kernelEpoch: string, operationId: string, cellId: string, source: string): EvaluationPayload {
  return {
    sessionEpoch: "engine-v2-test-session",
    kernelEpoch,
    operationId,
    runId: `run-${operationId}`,
    cellId,
    revision: 1,
    documentRevision: 1,
    source,
    definitions: [],
    locals: [],
    opaque: false,
  };
}

test("live v2 Engine starts analyzer and kernel independently, analyzes ranges, and evaluates", integration,
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "alder-engine-v2-"));
    const { engine, processScope } = await openEngine(directory);
    try {
      const analyzer = await engine.startAnalyzer();
      assert.equal(typeof analyzer.packageVersion, "string");
      assert.equal(typeof analyzer.analysisEnvironmentId, "string");
      assert.equal((engine as unknown as { kernel?: unknown }).kernel, undefined);

      const kernel = await engine.startKernel();
      assert.equal(kernel.name, "ark");
      assert.equal(typeof kernel.kernelEpoch, "string");
      const handshake = await engine.start();
      assert.equal(handshake.protocol, "alder-engine-v2");
      assert.equal(handshake.analyzerReady, true);
      assert.equal(handshake.kernelReady, true);
      assert.equal(handshake.captureReady, true);
      assert.equal(handshake.kernel?.kernelEpoch, kernel.kernelEpoch);
      assert.equal(handshake.kernel?.version, "0.1.252");
      assert.equal(handshake.kernel?.buildVersion, "0.1.252-alder.1");
      assert.equal(handshake.kernel?.mimePublisher, "alder-json-v1");
      const outputStore = engine.prepareOutputStore({
        sessionEpoch: "engine-v2-test-session", documentRevision: 1,
      });
      assert.deepEqual(outputStore.snapshot({ documentRevision: 1 }).records, []);

      const analysis = await engine.analyze([
        { id: "unicode", revision: 3, type: "code", source: "value <- \"λ\"\nvalue" },
        { id: "ranges", revision: 1, type: "code", source: "é <- 1\n\tβ" },
        { id: "supplementary", revision: 1, type: "code", source: "message <- \"😀\"; unicode" },
        { id: "self-update", revision: 1, type: "code", source: "x <- x + 1" },
      ], 8);
      const checked = analysisResultSchema.parse(analysis);
      assert.equal(checked.analysisEnvironmentId, analyzer.analysisEnvironmentId);
      assert.deepEqual(checked.cells[3]?.selfRefs, ["x"]);
      assert.deepEqual(checked.cells[0]?.defs, ["value"]);
      const firstRange = checked.cells[0]?.ranges?.value?.[0];
      assert.deepEqual(firstRange?.start, { line: 0, character: 0 });
      assert.deepEqual(firstRange?.end, { line: 0, character: 5 });
      const accented = checked.cells[1]?.ranges?.["é"]?.[0];
      assert.deepEqual(accented, {
        start: { line: 0, character: 0 }, end: { line: 0, character: 1 },
      });
      const tabbedReference = checked.cells[1]?.ranges?.["β"]?.[0];
      assert.deepEqual(tabbedReference, {
        start: { line: 1, character: 1 }, end: { line: 1, character: 2 },
      });
      const supplementaryReference = checked.cells[2]?.ranges?.unicode?.[0];
      assert.deepEqual(supplementaryReference, {
        start: { line: 0, character: 17 }, end: { line: 0, character: 24 },
      });
      const makeCommentLine = (length: number): string =>
        "#" + "\u0001" + "a".repeat(length - 2);
      const maxCommentSource = [
        ...Array.from({ length: 31 }, () => makeCommentLine(1_048_575)),
        makeCommentLine(1_048_576),
      ].join("\n");
      assert.equal(Buffer.byteLength(maxCommentSource, "utf8"), 33_554_432);
      const maxAnalysis = analysisResultSchema.parse(await engine.analyze([
        { id: "max-comment", revision: 1, type: "code", source: maxCommentSource },
      ], 9));
      assert.deepEqual(maxAnalysis.cells[0]?.defs, []);
      assert.deepEqual(maxAnalysis.cells[0]?.refs, []);
      assert.equal(maxAnalysis.cells[0]?.error, null);
      const maxEvaluated = await engine.evaluate(
        payload(kernel.kernelEpoch, "max-comment", "max-comment", maxCommentSource),
      );
      assert.equal(maxEvaluated.ok, true);
      const evaluated = await engine.evaluate(payload(kernel.kernelEpoch, "eval", "unicode", "1 + 1"));
      assert.equal(evaluated.ok, true);
      assert.match(JSON.stringify(evaluated.outputs), /2/);
      const batchFirst = payload(kernel.kernelEpoch, "batch", "batch-a", "x <- 40", []);
      batchFirst.definitions = ["x"];
      const batchSecond = payload(kernel.kernelEpoch, "batch", "batch-b", "x + 2", []);
      const batch = await engine.evaluateBatch([batchFirst, batchSecond]);
      assert.equal(batch[0]?.ok, true);
      assert.equal(batch[1]?.ok, true);
      assert.match(JSON.stringify(batch[1]?.outputs), /42/);
      await engine.restart();
      assert.deepEqual(outputStore.snapshot({ documentRevision: 1 }).records, []);
    } finally {
      await closeEngine(engine, processScope, directory);
    }
  });

test("ordinary R errors preserve condition metadata and leave the kernel usable", integration,
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "alder-engine-error-"));
    const { engine, processScope } = await openEngine(directory);
    try {
      const handshake = await engine.start();
      const epoch = handshake.kernel!.kernelEpoch;
      const failed = await engine.evaluate(payload(epoch, "ordinary-error", "ordinary-error", "stop(structure(list(message = \"ordinary error\", call = quote(sentinel_call())), class = c(\"simpleError\", \"error\", \"condition\")))"));
      assert.equal(failed.ok, false);
      assert.equal(failed.error?.message, "ordinary error");
      const failedCondition = (failed.error?.details as { condition?: {
        class?: unknown;
        call?: unknown;
        trace?: unknown;
      } } | undefined)?.condition;
      assert.deepEqual(failedCondition?.class, ["simpleError", "error", "condition"]);
      assert.equal(failedCondition?.call, "sentinel_call()");
      assert.ok(Array.isArray(failedCondition?.trace));

      const collision = await engine.evaluate(payload(epoch, "condition-collision", "condition-collision",
        "stop(structure(list(message = \"collision\", details = list(condition = \"raw-condition\", data = \"raw-data\")), class = c(\"simpleError\", \"error\", \"condition\")))"));
      assert.equal(collision.ok, false);
      assert.equal(collision.error?.message, "collision");
      const collisionDetails = collision.error?.details as {
        condition?: { class?: unknown; call?: unknown; trace?: unknown };
        data?: unknown;
      } | undefined;
      assert.deepEqual(collisionDetails?.data, { condition: "raw-condition", data: "raw-data" });
      assert.deepEqual(collisionDetails?.condition?.class, ["simpleError", "error", "condition"]);
      assert.equal(collisionDetails?.condition?.call, null);
      assert.ok(Array.isArray(collisionDetails?.condition?.trace));
      const recovered = await engine.evaluate(payload(epoch, "after-error", "after-error", "40 + 2"));
      assert.equal(recovered.ok, true);
      assert.match(JSON.stringify(recovered.outputs), /42/);
    } finally {
      await closeEngine(engine, processScope, directory);
    }
  });
test("Alder log notifications preserve exact OutputLog lines", integration,
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "alder-engine-log-lines-"));
    const { engine, processScope } = await openEngine(directory);
    try {
      const handshake = await engine.start();
      const epoch = handshake.kernel!.kernelEpoch;

      const stream = await engine.evaluate(payload(
        epoch,
        "jupyter-stream-log",
        "jupyter-stream-log",
        String.raw`cat("stream line one\nstream line two\n")`,
      ));
      assert.equal(stream.ok, true);
      assert.deepEqual(stream.log, ["stream line one", "stream line two"]);

      const logEvents: unknown[] = [];
      const alder = await engine.evaluate(
        payload(
          epoch,
          "alder-event-log",
          "alder-event-log",
          String.raw`renderer <- structure(1L, class = "alder_log_renderer")
print.alder_log_renderer <- function(x, ...) {
  message("renderer message")
  warning("renderer warning")
  cat("renderer output\n")
}
message("message line")
warning("warning line")
out$append(renderer)`,
        ),
        (event) => {
          if (event.type === "output" && event.kind === "log") logEvents.push(event.payload);
        },
      );
      assert.equal(alder.ok, true);
      const eventLines = logEvents.flatMap((payload) => {
        assert.ok(typeof payload === "object" && payload !== null);
        const lines = (payload as { lines?: unknown }).lines;
        assert.ok(Array.isArray(lines));
        assert.ok(lines.every((line): line is string => typeof line === "string"));
        return lines;
      });
      assert.deepEqual(eventLines, [
        "message line",
        "Warning: warning line",
        "renderer message",
        "Warning: renderer warning",
      ]);
      assert.deepEqual(alder.log, [
        "message line",
        "Warning: warning line",
        "renderer message",
        "Warning: renderer warning",
      ]);
    } finally {
      await closeEngine(engine, processScope, directory);
    }
  });
test("Engine restart re-resolves notebook directory without replaying state", integration,
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "alder-engine-restart-"));
    const destination = await mkdtemp(join(tmpdir(), "alder-engine-restart-destination-"));
    const { engine, processScope } = await openEngine(directory);
    try {
      const first = await engine.start();
      const firstEpoch = first.kernel!.kernelEpoch;
      const store = engine.prepareOutputStore({ sessionEpoch: "engine-v2-test-session", documentRevision: 1 });
      const set = await engine.evaluate(payload(firstEpoch, "set", "one", "persisted <- 42L; persisted"));
      assert.equal(set.ok, true);
      const firstRecord = store.records()[0];
      assert.ok(firstRecord);
      const second = await engine.restart({
        notebookDirectory: destination,
        cacheDirectory: join(destination, "cache"),
      });
      assert.notEqual(second.kernel!.kernelEpoch, firstEpoch);
      assert.equal(existsSync(join(directory, "artifacts")), true);
      assert.equal(engine.outputStore, store);
      assert.equal(store.records().some((record) => record.id === firstRecord.id), false);
      const context = await engine.evaluate(payload(
        second.kernel!.kernelEpoch,
        "context",
        "context",
        `cat(normalizePath(getwd(), winslash = "/", mustWork = TRUE), sep = "")`,
      ));
      assert.equal(context.ok, true);
      const runtimePath = context.log?.join("") ?? "";
      const normalizedDestination = resolve(destination).split("\\").join("/");
      assert.ok(runtimePath.includes(normalizedDestination));
      const read = await engine.evaluate(payload(second.kernel!.kernelEpoch, "read", "two", "exists('persisted', inherits = FALSE)"));
      assert.equal(read.ok, true);
      assert.match(JSON.stringify(read.outputs), /FALSE/);
    } finally {
      await closeEngine(engine, processScope, directory);
      await rm(destination, { recursive: true, force: true });
    }
  });

test("Engine rejects an authenticated Ark event with a wrong request identity", integration,
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "alder-engine-correlation-"));
    const { engine, processScope } = await openEngine(directory);
    try {
      const handshake = await engine.start();
      const epoch = handshake.kernel!.kernelEpoch;
      const source = `local({
        runtime <- get("RUNTIME", envir = asNamespace("alder"), inherits = FALSE)
        target <- environment(runtime$ark_evaluate)
        token <- get("ark_event_token", envir = target, inherits = FALSE)
        publish <- get("ark_publish_mimebundle", envir = as.environment("tools:positron"), inherits = FALSE)
        event <- list(token = token, request = "wrong-request", sequence = 1L,
          type = "progress", session_epoch = "engine-v2-test-session", kernel_epoch = ${JSON.stringify(epoch)},
          run_id = "run-correlate", operation_id = "correlate", cell_id = "correlate", revision = 1L,
          payload = list(progress = list(kind = "progress", value = 1, total = NULL, label = "", done = FALSE)))
        data <- list(); data[["application/vnd.alder.event+json"]] <- event
        publish(jsonlite::toJSON(data, auto_unbox = TRUE, null = "null", force = TRUE))
      })`;
      await assert.rejects(
        engine.evaluate(payload(epoch, "correlate", "correlate", source)),
        /request identity does not match/,
      );
    } finally {
      await closeEngine(engine, processScope, directory);
    }
  });

test("Engine rejects malformed authenticated progress before emitting it", integration,
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "alder-engine-progress-"));
    const { engine, processScope } = await openEngine(directory);
    try {
      const handshake = await engine.start();
      const epoch = handshake.kernel!.kernelEpoch;
      const source = `local({
        runtime <- get("RUNTIME", envir = asNamespace("alder"), inherits = FALSE)
        emit <- get("ark_emit", envir = environment(runtime$ark_evaluate), inherits = FALSE)
        emit(list(type = "progress", sequence = 1L,
          payload = list(progress = list(kind = "evil", value = 1, total = NULL, label = "", done = FALSE))))
      })`;
      await assert.rejects(
        engine.evaluate(payload(epoch, "bad-progress", "bad-progress", source)),
        /invalid progress output/,
      );
    } finally {
      await closeEngine(engine, processScope, directory);
    }
  });
test("Engine rejects malformed artifact descriptors before release authority", integration, async () => {
  const directory = await mkdtemp(join(tmpdir(), "alder-engine-release-"));
  const { engine, processScope } = await openEngine(directory);
  try {
    const handshake = await engine.start();
    const forgedDescriptor = {
      handle: "forged",
      mimeType: "application/octet-stream",
      byteLength: 0,
      chunkBytes: 262_144,
      epoch: "session",
      documentRevision: 1,
      kernelEpoch: null,
      [Symbol("forged")]: true,
    };
    await assert.rejects(
      engine.request("release_outputs", { artifacts: [forgedDescriptor] }),
      /invalid artifact descriptor/,
    );
    await assert.rejects(
      engine.request("release_outputs", { artifacts: [{ handle: "evil" }] }),
      /invalid artifact descriptor/,
    );
    const response = await engine.evaluate(payload(
      handshake.kernel!.kernelEpoch,
      "release-followup",
      "release-followup",
      "1 + 1",
    ));
    assert.equal(response.ok, true);
  } finally {
    await closeEngine(engine, processScope, directory);
  }
});
test("Engine clear_cell accepts one bounded batch and clears only those cell bindings", integration, async () => {
  const directory = await mkdtemp(join(tmpdir(), "alder-engine-clear-cell-"));
  const { engine, processScope } = await openEngine(directory);
  try {
    const handshake = await engine.start();
    const epoch = handshake.kernel!.kernelEpoch;
    const first = payload(epoch, "clear-seed-a", "clear-cell-a", "clear_a <- 11L; clear_a");
    first.definitions = ["clear_a"];
    const second = payload(epoch, "clear-seed-b", "clear-cell-b", "clear_b <- 22L; clear_b");
    second.definitions = ["clear_b"];
    const retained = payload(epoch, "clear-seed-retained", "retained-cell", "retained <- 33L; retained");
    retained.definitions = ["retained"];
    assert.equal((await engine.evaluate(first)).ok, true);
    assert.equal((await engine.evaluate(second)).ok, true);
    assert.equal((await engine.evaluate(retained)).ok, true);
    assert.deepEqual(
      await engine.request("clear_cell", { ids: ["clear-cell-a", "clear-cell-b"] }),
      { ok: true },
    );
    const probe = await engine.evaluate(payload(
      epoch,
      "clear-probe",
      "clear-probe",
      'paste(exists("clear_a", inherits = FALSE), exists("clear_b", inherits = FALSE), retained, sep = "|")',
    ));
    assert.equal(probe.ok, true);
    assert.match(JSON.stringify(probe.outputs), /FALSE\|FALSE\|33/);
  } finally {
    await closeEngine(engine, processScope, directory);
  }
});
test("Engine setEnvironment accepts pre-start and fully-stopped recovery", integration, async () => {
  const directory = await mkdtemp(join(tmpdir(), "alder-engine-environment-"));
  const { engine, processScope, environment } = await openEngine(directory, { cacheDirectory: undefined });
  try {
    const replacement = { ...environment, identity: createHash("sha256").update("replacement").digest("hex") };
    engine.setEnvironment(replacement);
    await engine.start();
    assert.throws(() => engine.setEnvironment(environment), /fully stopped/);
    const unavailable = {
      ...environment,
      rscript: join(directory, "missing-rscript"),
      identity: createHash("sha256").update("unavailable").digest("hex"),
    };
    await assert.rejects(() => engine.restart({ environment: unavailable }));
    engine.setEnvironment(environment);
    await engine.start();
  } finally {
    await closeEngine(engine, processScope, directory);
  }
});

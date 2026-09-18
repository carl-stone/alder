import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
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
const resourcesAvailable = existsSync(join(applicationRoot, "runtime", "ark")) &&
  existsSync(join(applicationRoot, "worker", "host-ark.R")) &&
  existsSync(join(applicationRoot, "r-library"));
const integration = { skip: !resourcesAvailable, timeout: 120_000 };

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
    nodeExecutable: join(root, "bin", "node"),
    processSupervisorExecutable: join(root, "runtime", "alder-process-supervisor"),
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

test("stock Ark starts, repeats evaluations, and returns native plot output", integration,
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "alder-engine-ark-plot-"));
    const { engine, processScope } = await openEngine(directory);
    try {
      const epoch = (await engine.start()).kernel!.kernelEpoch;
      for (const [index, source] of [
        "plot(c(1, 2, 3), type = 'b')",
        "plot(c(3, 2, 1), type = 'b')",
      ].entries()) {
        const result = await engine.evaluate(payload(epoch, `plot-${index}`, `plot-${index}`, source));
        assert.equal(result.ok, true);
        assert.ok(result.outputs?.some((output) => output.data.kind === "image"));
      }
    } finally {
      await closeEngine(engine, processScope, directory);
    }
  });

test("stock Ark keeps scalar, form, and button widget values in R", integration,
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "alder-engine-widgets-"));
    const { engine, processScope } = await openEngine(directory);
    try {
      const epoch = (await engine.start()).kernel!.kernelEpoch;
      const evaluate = async (id: string, source: string, definitions: string[] = []) => {
        const request = payload(epoch, id, id, source);
        request.definitions = definitions;
        const result = await engine.evaluate(request);
        assert.equal(result.ok, true, result.error?.message);
        return result;
      };
      await evaluate("import", "library(alder)");

      const slider = await evaluate("slider", "gain <- ui$slider(0, 10, value = 2); gain", ["gain"]);
      assert.match(JSON.stringify(slider.outputs), /"kind":"widget"/);
      assert.match(JSON.stringify(await evaluate("slider-before", "gain$value * 7")), /14/);
      assert.equal((await engine.request("set_widget", { name: "gain", path: [], op_id: 1, value: 4 })).ok, true);
      assert.match(JSON.stringify(await evaluate("slider-after", "gain$value * 7")), /28/);

      await evaluate("form", "settings <- ui$form(ui$array(factor = ui$slider(0, 10, 2), enabled = ui$checkbox(FALSE))); settings", ["settings"]);
      assert.match(JSON.stringify(await evaluate("form-before", "if (is.null(settings$value)) 'not submitted' else settings$value$factor * 7")), /not submitted/);
      assert.equal((await engine.request("set_widget", { name: "settings", path: ["factor"], op_id: 2, value: 4 })).ok, true);
      assert.equal((await engine.request("set_widget", { name: "settings", path: ["enabled"], op_id: 3, value: true })).ok, true);
      assert.match(JSON.stringify(await evaluate("form-draft", "if (is.null(settings$value)) 'not submitted' else settings$value$factor * 7")), /not submitted/);
      assert.equal((await engine.request("set_widget", { name: "settings", path: [], op_id: 4, submit: true })).ok, true);
      assert.match(JSON.stringify(await evaluate("form-after", "settings$value$factor * 7")), /28/);

      await evaluate("button", "clicks <- ui$button(); clicks", ["clicks"]);
      assert.equal((await engine.request("set_widget", { name: "clicks", path: [], op_id: 5, value: 1 })).ok, true);
      assert.match(JSON.stringify(await evaluate("button-after", "clicks$value")), /1/);
    } finally {
      await closeEngine(engine, processScope, directory);
    }
  });
test("stock Ark preserves append, log, progress, and deferred output", integration, async () => {
  const directory = await mkdtemp(join(tmpdir(), "alder-engine-output-"));
  const { engine, processScope } = await openEngine(directory);
  try {
    const epoch = (await engine.start()).kernel!.kernelEpoch;
    assert.equal((await engine.evaluate(payload(epoch, "output-import", "import", "library(alder)"))).ok, true);
    const kinds: string[] = [];
    const ordered = await engine.evaluate(payload(epoch, "ordered", "ordered", `
      out$append(out$md("**First**: six observations"))
      cat("Second: calculated table\\n")
      out$append(data.frame(group = c("a", "b"), total = c(6L, 15L)))
      "Fourth: complete"
    `), (event) => {
      if (event.type === "output") kinds.push(event.kind);
    });
    assert.equal(ordered.ok, true, ordered.error?.message);
    assert.deepEqual(kinds, ["append", "log", "append", "append"]);
    assert.deepEqual(ordered.outputs?.map((record) => record.data.kind), ["markdown", "table", "text"]);
    assert.match(JSON.stringify(ordered.outputs?.[1]?.data), /"total"/);
    assert.match(JSON.stringify(ordered.outputs?.[2]?.data), /Fourth: complete/);

    const progress: Array<{ value: number; done: boolean }> = [];
    const progressed = await engine.evaluate(payload(epoch, "progress", "progress", `
      p <- out$progress(total = 3, label = "Rows")
      for (i in 1:3) p$update(i)
      p$close()
      sum(1:3)
    `), (event) => {
      if (event.type === "output" && event.kind === "progress") {
        const record = (event.payload as { progress: { value: number; done: boolean } }).progress;
        progress.push({ value: record.value, done: record.done });
      }
    });
    assert.equal(progressed.ok, true, progressed.error?.message);
    assert.deepEqual(progress, [
      { value: 1, done: false }, { value: 2, done: false },
      { value: 3, done: false }, { value: 3, done: true },
    ]);
    assert.match(JSON.stringify(progressed.outputs), /\[1\] 6/);

    const deferred = await engine.evaluate(payload(epoch, "deferred", "deferred", `
      out$lazy(function() out$vstack(out$md("**Deferred**: six"),
        data.frame(i = 1:3, doubled = c(2L, 4L, 6L))), label = "Show detail")
    `));
    assert.equal(deferred.ok, true, deferred.error?.message);
    const lazy = deferred.outputs?.[0]?.data as { kind: string; key: string; state: string };
    assert.equal(lazy.kind, "lazy");
    assert.equal(lazy.state, "collapsed");
    const expanded = await engine.request("lazy_eval", { key: lazy.key, id: "deferred", token: "output-detail" }, {
      outputScope: {
        sessionEpoch: "engine-v2-test-session", documentRevision: 1, kernelEpoch: epoch,
        runId: deferred.outputs![0]!.runId, cellId: "deferred", revision: 1,
      },
    });
    assert.equal(expanded.ok, true, expanded.error?.message);
    assert.match(JSON.stringify(expanded.output), /Deferred/);
    assert.match(JSON.stringify(expanded.output), /doubled/);
  } finally {
    await closeEngine(engine, processScope, directory);
  }
});

test("stock Ark cache reuses values and invalidates changed code and dependencies", integration, async () => {
  const directory = await mkdtemp(join(tmpdir(), "alder-engine-cache-"));
  const { engine, processScope } = await openEngine(directory);
  try {
    let epoch = (await engine.start()).kernel!.kernelEpoch;
    const evaluate = async (id: string, source: string) => {
      const result = await engine.evaluate(payload(epoch, id, id, source));
      assert.equal(result.ok, true, result.error?.message);
      return result;
    };
    await evaluate("cache-import", "library(alder)");
    await evaluate("cache-multiplier", "multiplier <- 2L");
    await evaluate("cache-memory-function", `memo <- cache$memory(function(x) { message("compute memory"); x * multiplier })`);
    const firstMemory = await evaluate("cache-memory-first", "c(memo(3L), memo(3L))");
    assert.match(JSON.stringify(firstMemory.outputs), /6 6/);
    assert.equal(firstMemory.log?.filter((line) => line.includes("compute memory")).length, 1);
    const reusedMemory = await evaluate("cache-memory-reuse", "memo(3L)");
    assert.match(JSON.stringify(reusedMemory.outputs), /\[1\] 6/);
    assert.equal(reusedMemory.log?.some((line) => line.includes("compute memory")), false);

    await evaluate("cache-disk-function", `saved <- cache$disk(function(x) { message("compute disk"); x * multiplier })`);
    const firstDisk = await evaluate("cache-disk-first", "c(saved(4L), saved(4L))");
    assert.match(JSON.stringify(firstDisk.outputs), /8 8/);
    assert.equal(firstDisk.log?.filter((line) => line.includes("compute disk")).length, 1);
    assert.equal((await readdir(join(directory, "cache"))).filter((name) => name.endsWith(".rds")).length, 1);
    const reusedDisk = await evaluate("cache-disk-reuse", "saved(4L)");
    assert.match(JSON.stringify(reusedDisk.outputs), /\[1\] 8/);
    assert.equal(reusedDisk.log?.some((line) => line.includes("compute disk")), false);

    await evaluate("cache-multiplier-changed", "multiplier <- 3L");
    const changedMemory = await evaluate("cache-memory-changed", "memo(3L)");
    const changedDisk = await evaluate("cache-disk-changed", "saved(4L)");
    assert.match(JSON.stringify(changedMemory.outputs), /\[1\] 9/);
    assert.match(JSON.stringify(changedDisk.outputs), /\[1\] 12/);
    assert.equal(changedMemory.log?.some((line) => line.includes("compute memory")), true);
    assert.equal(changedDisk.log?.some((line) => line.includes("compute disk")), true);

    await evaluate("cache-disk-function-changed", `saved <- cache$disk(function(x) { message("compute disk body"); x * multiplier + 1L })`);
    const changedCode = await evaluate("cache-disk-body-changed", "saved(4L)");
    assert.match(JSON.stringify(changedCode.outputs), /\[1\] 13/);
    assert.equal(changedCode.log?.some((line) => line.includes("compute disk body")), true);
    assert.equal((await readdir(join(directory, "cache"))).filter((name) => name.endsWith(".rds")).length, 3);

    epoch = (await engine.restart()).kernel!.kernelEpoch;
    await evaluate("cache-restart-import", "library(alder)");
    await evaluate("cache-restart-multiplier", "multiplier <- 3L");
    await evaluate("cache-restart-function", `saved <- cache$disk(function(x) { message("compute disk"); x * multiplier })`);
    const afterRestart = await evaluate("cache-restart-hit", "saved(4L)");
    assert.match(JSON.stringify(afterRestart.outputs), /\[1\] 12/);
    assert.equal(afterRestart.log?.some((line) => line.includes("compute disk")), false);
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
        event <- list(token = token, request = "wrong-request", sequence = 1L,
          type = "progress", session_epoch = "engine-v2-test-session", kernel_epoch = ${JSON.stringify(epoch)},
          run_id = "run-correlate", operation_id = "correlate", cell_id = "correlate", revision = 1L,
          payload = list(progress = list(kind = "progress", value = 1, total = NULL, label = "", done = FALSE)))
        encoded <- base64enc::base64encode(charToRaw(as.character(jsonlite::toJSON(
          event, auto_unbox = TRUE, null = "null", force = TRUE))))
        marker <- intToUtf8(30L)
        cat(marker, "ALDER:", token, ":", encoded, ":", marker, "\n",
          sep = "", file = stderr())
      })`;
      await assert.rejects(
        engine.evaluate(payload(epoch, "correlate", "correlate", source)),
        /request identity does not match/,
      );
    } finally {
      await closeEngine(engine, processScope, directory);
    }
  });

test("R message sinks do not swallow Alder cell events", integration, async () => {
  const directory = await mkdtemp(join(tmpdir(), "alder-engine-message-sink-"));
  const { engine, processScope } = await openEngine(directory);
  try {
    const epoch = (await engine.start()).kernel!.kernelEpoch;
    const redirected = await engine.evaluate(payload(epoch, "message-sink", "message-sink",
      'con <- file(tempfile(), "w"); sink(con, type = "message"); 42L'));
    assert.equal(redirected.ok, true);
    assert.match(JSON.stringify(redirected.outputs), /42/);
    const restored = await engine.evaluate(payload(epoch, "message-restore", "message-restore",
      'sink(type = "message"); close(con); 7L'));
    assert.equal(restored.ok, true);
    assert.match(JSON.stringify(restored.outputs), /7/);
  } finally {
    await closeEngine(engine, processScope, directory);
  }
});

test("automatic variable snapshots leave promises and user methods untouched", integration, async () => {
  const directory = await mkdtemp(join(tmpdir(), "alder-engine-snapshot-passive-"));
  const { engine, processScope } = await openEngine(directory);
  try {
    const epoch = (await engine.start()).kernel!.kernelEpoch;
    const setup = await engine.evaluate(payload(epoch, "snapshot-setup", "snapshot-setup", `
      snapshot_forced <- FALSE
      delayedAssign("snapshot_promise", { snapshot_forced <<- TRUE; 7L }, assign.env = .GlobalEnv)
      snapshot_method_calls <- 0L
      dim.snapshot_probe <- function(x) { snapshot_method_calls <<- snapshot_method_calls + 1L; NULL }
      object.size.snapshot_probe <- function(x) { snapshot_method_calls <<- snapshot_method_calls + 1L; 1L }
      snapshot_object <- structure(1L, class = "snapshot_probe")
    `));
    assert.equal(setup.ok, true);
    const snapshot = await engine.request("env_snapshot", {});
    assert.equal(snapshot.ok, true);
    assert.ok(snapshot.variables?.some((variable) => variable.name === "snapshot_promise"));
    assert.ok(snapshot.variables?.some((variable) => variable.name === "snapshot_object"));
    const state = await engine.evaluate(payload(epoch, "snapshot-state", "snapshot-state",
      'stopifnot(!snapshot_forced, identical(snapshot_method_calls, 0L)); "untouched"'));
    assert.equal(state.ok, true);
    assert.match(JSON.stringify(state.outputs), /untouched/);
    const explicit = await engine.request("get_value", { name: "snapshot_promise" }, {
      outputScope: {
        sessionEpoch: "engine-v2-test-session", documentRevision: 1, kernelEpoch: epoch,
        runId: null, cellId: null, revision: null,
      },
    });
    assert.equal(explicit.ok, true);
    const forced = await engine.evaluate(payload(epoch, "snapshot-forced", "snapshot-forced", "snapshot_forced"));
    assert.match(JSON.stringify(forced.outputs), /TRUE/);
  } finally {
    await closeEngine(engine, processScope, directory);
  }
});

test("nested output conversion preserves malformed child errors", integration, async () => {
  const directory = await mkdtemp(join(tmpdir(), "alder-engine-output-walk-"));
  const { engine, processScope } = await openEngine(directory);
  try {
    const epoch = (await engine.start()).kernel!.kernelEpoch;
    const result = await engine.evaluate(payload(epoch, "nested-output", "nested-output", `
      structure(list(kind = "layout", layout = "hstack",
        attrs = list(gap = 0, align = "start", justify = "start"),
        children = list(
          list(kind = "text", text = "kept", truncated = FALSE),
          list(kind = "image", artifact = "../forged.png"))),
        class = c("alder_output", "list"))
    `));
    assert.equal(result.ok, true);
    assert.equal(result.outputs?.[0]?.data.kind, "layout");
    assert.match(JSON.stringify(result.outputs), /kept/);
    assert.match(JSON.stringify(result.outputs), /alder output artifact is unavailable/);
    const deep = await engine.evaluate(payload(epoch, "deep-output", "deep-output", `
      node <- list(kind = "text", text = "leaf", truncated = FALSE)
      for (i in seq_len(40L)) node <- list(kind = "layout", layout = "callout",
        attrs = list(variant = "info"), children = list(node))
      structure(node, class = c("alder_output", "list"))
    `));
    assert.equal(deep.ok, true);
    assert.match(JSON.stringify(deep.outputs), /alder output nesting limit exceeded/);
  } finally {
    await closeEngine(engine, processScope, directory);
  }
});

test("project package versions win before Alder imports load", integration, async () => {
  const directory = await mkdtemp(join(tmpdir(), "alder-engine-project-import-"));
  const projectLibrary = join(directory, "project-library");
  await mkdir(projectLibrary);
  const resources = resourcesFor(applicationRoot);
  const selected = selectedEnvironment(resources);
  const jsonlitePath = execFileSync(selected.rscript, ["--vanilla", "--slave", "-e",
    'cat(find.package("jsonlite"))'], { encoding: "utf8", env: cleanEnvironment() }).trim();
  await cp(jsonlitePath, join(projectLibrary, "jsonlite"), { recursive: true });
  const environment = {
    ...selected,
    libraryPaths: [selected.libraryPaths[0]!, projectLibrary, ...selected.libraryPaths.slice(1)],
  };
  const { engine, processScope } = await openEngine(directory, { environment });
  try {
    const epoch = (await engine.start()).kernel!.kernelEpoch;
    const evaluated = await engine.evaluate(payload(epoch, "project-import", "project-import",
      'getNamespaceInfo("jsonlite", "path")'));
    assert.equal(evaluated.ok, true);
    assert.match(JSON.stringify(evaluated.outputs), /project-library/);
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

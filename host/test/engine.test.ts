import assert from "node:assert/strict";
import {
  access, chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Engine, type EngineOptions } from "../src/engine.js";
import type { ArkKernel, JupyterMessage } from "../src/jupyter.js";
import {
  MAX_NOTEBOOK_CELLS,
  type EngineEvent,
  type EvaluationPayload,
} from "../src/protocol.js";

const installedPackage = process.env.ALDER_R_PACKAGE;
const integration = { skip: installedPackage === undefined, timeout: 30_000 };
const unixIntegration = {
  ...integration,
  skip: integration.skip || process.platform === "win32",
};

function payload(
  operationId: string,
  cellId: string,
  source: string,
  definitions: string[] = [],
): EvaluationPayload {
  return {
    sessionEpoch: "engine-test-epoch",
    operationId,
    runId: `run-${operationId}`,
    cellId,
    revision: 1,
    source,
    definitions,
    locals: [],
    opaque: false,
  };
}

function newEngine(directory: string, options: Partial<EngineOptions> = {}): Engine {
  return new Engine({
    packagePath: installedPackage,
    notebookDirectory: directory,
    startupTimeoutMs: 30_000,
    ...options,
  });
}

function largeCodecPayload(directory: string, count = 2_500): Record<string, unknown> {
  return {
    bytes: "",
    ids: [],
    path: join(directory, "large-notebook.R"),
    cells: Array.from({ length: count }, (_, index) => ({
      id: `service-${index}`,
      type: "code",
      body: [`value_${index} <- ${index}`],
      options: {},
    })),
    metadata: {},
  };
}

function deadline<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function waitForValue<T>(
  read: () => T | undefined,
  timeoutMs: number,
  label: string,
): Promise<T> {
  const expires = Date.now() + timeoutMs;
  return new Promise<T>((resolveValue, rejectValue) => {
    const poll = (): void => {
      const value = read();
      if (value !== undefined) resolveValue(value);
      else if (Date.now() >= expires) rejectValue(new Error(`${label} timed out`));
      else setTimeout(poll, 10);
    };
    poll();
  });
}

function alderEventType(message: JupyterMessage): string | undefined {
  if (message.header.msg_type !== "display_data" &&
      message.header.msg_type !== "update_display_data") return undefined;
  const data = message.content.data;
  if (typeof data !== "object" || data === null || Array.isArray(data)) return undefined;
  const html = (data as Record<string, unknown>)["text/html"];
  if (typeof html !== "string") return undefined;
  const match = /^<!--ALDER_EVENT_V1:[A-Za-z0-9_-]+:([A-Za-z0-9+/]*={0,2})-->$/.exec(html);
  if (match === null) return undefined;
  const decoded = JSON.parse(Buffer.from(match[1]!, "base64").toString("utf8")) as unknown;
  return typeof decoded === "object" && decoded !== null && !Array.isArray(decoded) &&
    typeof (decoded as { type?: unknown }).type === "string"
    ? (decoded as { type: string }).type
    : undefined;
}

function clearOutputMessage(wait: boolean): JupyterMessage {
  return {
    identities: [],
    header: {
      msg_id: "synthetic-clear-output",
      username: "ark",
      session: "engine-test",
      date: new Date(0).toISOString(),
      msg_type: "clear_output",
      version: "5.4",
    },
    parentHeader: {},
    metadata: {},
    content: { wait },
    buffers: [],
  };
}

test("starts both initialized R roles and analyzes without evaluating source", integration,
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "alder-engine-test-"));
    const marker = join(directory, "must-not-exist");
    const traceDirectory = join(directory, "trace");
    await mkdir(traceDirectory);
    const engine = newEngine(directory, {
      environment: { ALDER_PERF_TRACE_DIR: traceDirectory },
    });
    try {
      const ready = await engine.start();
      assert.equal(ready.protocol, "alder-engine-v1");
      assert.equal(ready.kernelReady, true);
      assert.equal(ready.analyzerReady, true);
      assert.equal(ready.captureReady, true);
      assert.deepEqual(ready.kernel, {
        name: "ark",
        version: "0.1.252",
        protocol: "5.4",
      });

      const result = await engine.analyze([
        { id: "one", revision: 3, type: "code", source: "x <- 40" },
        { id: "two", revision: 7, type: "code", source: "x + 2" },
        {
          id: "effect",
          revision: 1,
          type: "code",
          source: `writeLines("evaluated", ${JSON.stringify(marker)})`,
        },
      ], 11);
      assert.equal(result.revision, 11);
      assert.deepEqual(result.cells[0]?.defs, ["x"]);
      assert.deepEqual(result.cells[1]?.refs, ["x"]);
      await assert.rejects(access(marker));
      await assert.rejects(engine.analyze(Array.from(
        { length: MAX_NOTEBOOK_CELLS + 1 },
        (_, index) => ({
          id: `too-many-${index}`,
          revision: 0,
          type: "code" as const,
          source: "",
        }),
      ), 12), /10000 cell limit/);

      const traceFiles = await readdir(traceDirectory);
      const hostTrace = traceFiles.find((file) => file === `host-${process.pid}.jsonl`);
      assert.ok(hostTrace);
      const traceText = await readFile(join(traceDirectory, hostTrace), "utf8");
      const records = traceText.trim().split("\n").map(
        (line) => JSON.parse(line) as Record<string, unknown>,
      );
      const begin = records.find((record) =>
        record.event === "begin" && record.stage === "host.engine.request");
      const end = records.find((record) =>
        record.event === "end" && record.stage === "host.engine.request");
      assert.equal(begin?.clock, "process.hrtime.bigint");
      assert.equal(end?.span, begin?.span);
      assert.ok(typeof end?.duration_ms === "number" && end.duration_ms >= 0);

      const rTraceFiles = traceFiles.filter((file) => file.startsWith("trace-"));
      assert.ok(rTraceFiles.length >= 1);
      const rTrace = (await Promise.all(rTraceFiles.map(
        (file) => readFile(join(traceDirectory, file), "utf8"),
      ))).join("\n");
      assert.match(rTrace, /"stage":"analyzer\.request"/);
      assert.match(rTrace, /"stage":"analyzer\.cell_defs_refs"/);
      assert.equal(`${traceText}\n${rTrace}`.includes(marker), false);
    } finally {
      await engine.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

test("the selected R executable overrides an inherited R_HOME", unixIntegration,
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "alder-r-selection-"));
    const wrapper = join(directory, "selected-rscript");
    const log = join(directory, "r-home.log");
    await writeFile(wrapper, [
      "#!/bin/sh",
      'printf \'%s\\n\' "${R_HOME-<unset>}" >> "$R_HOME_LOG"',
      'exec "$SELECTED_RSCRIPT" "$@"',
      "",
    ].join("\n"));
    await chmod(wrapper, 0o700);
    const engine = newEngine(directory, {
      rscript: wrapper,
      environment: {
        R_HOME: join(directory, "wrong-r-home"),
        R_HOME_LOG: log,
        SELECTED_RSCRIPT: process.env.ALDER_RSCRIPT ?? "Rscript",
      },
    });
    try {
      await engine.start();
      const result = await engine.evaluate(payload(
        "selected-r", "selected-r", 'normalizePath(R.home(), winslash = "/")',
      ));
      assert.equal(result.ok, true);
      const homes = (await readFile(log, "utf8")).trim().split("\n");
      assert.equal(homes[0], "<unset>");
      assert.ok(homes.length >= 3);
      assert.ok(homes.slice(1).every((home) => home === homes[1]));
      assert.match(JSON.stringify(result.outputs), new RegExp(
        homes[1]!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      ));
    } finally {
      await engine.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

test("failed R selection does not allocate runtime directories", integration,
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "alder-r-selection-failure-"));
    const artifactDirectory = join(directory, "must-not-create-artifacts");
    const cacheDirectory = join(directory, "must-not-create-cache");
    const engine = newEngine(directory, {
      rscript: join(directory, "missing-rscript"),
      artifactDirectory,
      cacheDirectory,
    });
    try {
      await assert.rejects(engine.start(), /could not start selected R/);
      await assert.rejects(access(artifactDirectory));
      await assert.rejects(access(cacheDirectory));
    } finally {
      await engine.close().catch(() => {});
      await rm(directory, { recursive: true, force: true });
    }
  });

test("close aborts an analyzer startup without waiting for its handshake timeout",
  unixIntegration, async () => {
    const directory = await mkdtemp(join(tmpdir(), "alder-engine-start-close-"));
    const analyzerScript = join(directory, "hanging-analyzer.R");
    await writeFile(analyzerScript, "Sys.sleep(60)\n", { mode: 0o600 });
    const engine = newEngine(directory, {
      analyzerScript,
      shutdownTimeoutMs: 250,
    });
    const starting = engine.start();
    void starting.catch(() => {});
    try {
      const analyzerPid = await waitForValue(
        () => (engine as unknown as { analyzer?: { processId?: number } })
          .analyzer?.processId,
        5_000,
        "analyzer process start",
      );
      await deadline(engine.close(), 5_000, "engine close during startup");
      await assert.rejects(starting, /closed|cancelled|exited|signal/);
      assert.throws(() => process.kill(analyzerPid, 0), { code: "ESRCH" });
      await assert.rejects(engine.start(), /closed/);
    } finally {
      await engine.close().catch(() => {});
      await starting.catch(() => {});
      await rm(directory, { recursive: true, force: true });
    }
  });

test("restart supersedes a start that has not entered its lifecycle turn", integration,
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "alder-engine-start-restart-"));
    const engine = newEngine(directory);
    try {
      const starting = engine.start();
      const restarting = engine.restart();
      await assert.rejects(starting, /superseded by restart/);
      const ready = await restarting;
      assert.equal(ready.kernelReady, true);
      const evaluated = await engine.evaluate(payload(
        "restart-superseded-start", "restart-superseded-start", "6 * 7",
      ));
      assert.equal(evaluated.ok, true);
      assert.match(JSON.stringify(evaluated.outputs), /42/);
    } finally {
      await engine.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

test("a slow pure service cannot block required source analysis", {
  ...integration,
  timeout: 45_000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "alder-engine-test-"));
  const engine = newEngine(directory);
  try {
    const ready = await engine.start();
    assert.ok(ready.capabilities.includes("analysis"));
    assert.ok(ready.capabilities.includes("pure-services"));

    const servicePayload = largeCodecPayload(directory);
    let serviceSettled = false;
    const service = engine.service("codec.document", servicePayload)
      .finally(() => { serviceSettled = true; });
    await new Promise<void>((resolveImmediate) => setImmediate(resolveImmediate));

    const analysis = await engine.analyze([
      { id: "required", revision: 1, type: "code", source: "answer <- 42" },
    ], 1);
    assert.deepEqual(analysis.cells[0]?.defs, ["answer"]);
    assert.equal(serviceSettled, false);

    const document = await service as { cells?: unknown[] };
    assert.equal(document.cells?.length, 2_500);
  } finally {
    await engine.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("service peer failure leaves analysis and execution available", integration,
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "alder-engine-test-"));
    const engine = newEngine(directory);
    let unsubscribe = (): void => {};
    try {
      await engine.start();
      const servicePid = (engine as unknown as {
        servicePeer?: { processId?: number };
      }).servicePeer?.processId;
      assert.ok(servicePid !== undefined && servicePid > 0);
      const serviceFailure = new Promise<void>((resolveFailure, rejectFailure) => {
        const timer = setTimeout(
          () => rejectFailure(new Error("service failure was not reported")),
          5_000,
        );
        unsubscribe = engine.onFailure((role) => {
          if (role !== "services") return;
          clearTimeout(timer);
          resolveFailure();
        });
      });
      const pendingService = assert.rejects(
        engine.service("codec.document", largeCodecPayload(directory)),
        /service exited|service is unavailable|could not write to service/,
      );
      await new Promise<void>((resolveImmediate) => setImmediate(resolveImmediate));
      process.kill(servicePid, "SIGKILL");
      await Promise.all([serviceFailure, pendingService]);

      await assert.rejects(
        engine.service("markdown.render", { body: ["unavailable"] }),
        /service is unavailable/,
      );
      const analysis = await engine.analyze([
        { id: "still-live", revision: 1, type: "code", source: "answer <- 42" },
      ], 1);
      assert.deepEqual(analysis.cells[0]?.defs, ["answer"]);
      const evaluated = await engine.evaluate(payload(
        "service-failed-run",
        "service-failed-run",
        "6 * 7",
      ));
      assert.equal(evaluated.ok, true);
      assert.match(JSON.stringify(evaluated.outputs), /42/);
    } finally {
      unsubscribe();
      await engine.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

test("persistent evaluation preserves state and emits terminal identity", integration,
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "alder-engine-test-"));
    const artifactDirectory = join(directory, "artifacts");
    const engine = newEngine(directory, { artifactDirectory });
    const events: EngineEvent[] = [];
    try {
      await engine.start();
      const [captureName] = (await readdir(artifactDirectory)).filter(
        (name) => name.startsWith(".alder-capture-"),
      );
      assert.ok(captureName);
      const captureDirectory = join(artifactDirectory, captureName);
      const initialCaptureFiles = await readdir(captureDirectory);
      assert.equal(initialCaptureFiles.length, 1);
      await engine.evaluate(
        payload("set", "one", 'set.seed(42); options(alder.engine.test="kept"); x <- 40; x', ["x"]),
        (event) => events.push(event),
      );
      const result = await engine.evaluate(
        payload("read", "two", 'x + 2; identical(getOption("alder.engine.test"), "kept")'),
        (event) => events.push(event),
      );
      assert.equal(result.ok, true);
      assert.match(JSON.stringify(result.outputs), /TRUE/);
      assert.deepEqual(
        events.map((event) => event.type),
        ["started", "completed", "started", "completed"],
      );
      const terminal = events.at(-1);
      assert.equal(terminal?.type, "completed");
      assert.equal(terminal?.operationId, "read");
      assert.equal(terminal?.cellId, "two");
      assert.equal(terminal?.revision, 1);
      const kernel = (engine as unknown as { kernel: ArkKernel }).kernel;
      const encoded = await kernel.execute(String.raw`local({
        emit <- get("ark_emit", environment(get("RUNTIME", asNamespace("alder"))$ark_evaluate))
        latin <- rawToChar(as.raw(233)); Encoding(latin) <- "latin1"
        cases <- list(
          list(type="started"), list(type="finished"), list(type="batch_end"),
          list(type="result", output=list(kind="text", text="café\nλ\t\"", truncated=FALSE)),
          list(type="result", output=list(kind="text", text=I("one"), truncated=FALSE)),
          list(type="result", output=list(kind="text", text=NA_character_, truncated=FALSE)),
          list(type="result", output=list(kind="text", text=latin, truncated=FALSE)),
          list(type="probe", value=character()), list(type="probe", value=list()),
          list(type="probe", value=I("one")), list(type="probe", value=NA),
          list(type="probe", value=1/3)
        )
        for (value in cases) {
          cat(as.character(jsonlite::toJSON(value, auto_unbox=TRUE, null="null", na="null", force=TRUE)), "\n", sep="")
          emit(value)
        }
      })`);
      assert.equal(encoded.reply.content.status, "ok");
      const references = encoded.messages.filter((message) => message.header.msg_type === "stream")
        .map((message) => message.content.text).join("").trim().split("\n").map((line) => JSON.parse(line));
      const actual = encoded.messages.flatMap((message) => {
        const html = (message.content.data as Record<string, unknown> | undefined)?.["text/html"];
        const match = typeof html === "string" ? html.match(/<!--ALDER_EVENT_V1:[A-Za-z0-9_-]+:([A-Za-z0-9+/=]+)-->/) : null;
        return match ? [Buffer.from(match[1]!, "base64").toString("utf8")] : [];
      });
      assert.equal(actual.length, 12);
      assert.deepEqual(actual.map((value) => JSON.parse(value)), references);
      assert.ok(actual.slice(0, 4).every((value) => value.includes("\n")), "plain records use Ark's native encoder");
      assert.ok(actual.slice(4).every((value) => !value.includes("\n")), "other records retain jsonlite semantics");
      assert.deepEqual(await readdir(captureDirectory), initialCaptureFiles);
      await engine.close();
      await assert.rejects(access(captureDirectory));
    } finally {
      await engine.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

test("native batches preserve cell results, callbacks, graphics and last value", integration,
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "alder-engine-batch-"));
    const cacheDirectory = join(directory, "cache");
    const engine = newEngine(directory, {
      cacheDirectory, environment: { ALDER_PERF_TRACE_DIR: directory },
    });
    const events: EngineEvent[] = [];
    try {
      await engine.start();
      const results = await engine.evaluateBatch([
        payload("batch", "batch-a", [
          "addTaskCallback(function(expr,value,ok,visible) {",
          "  if (identical(value, 1L)) cat('first callback\\n')",
          "  TRUE",
          "}, name='alder-batch-test')",
          "graphics::plot(1:3); a <- 1L; a",
        ].join("\n"), ["a"]),
        payload("batch", "batch-b", "stopifnot(identical(.Last.value, 1L)); b <- a + 1L; b", ["b"]),
        payload("batch", "batch-c", "stopifnot(identical(.Last.value, 2L)); c <- b + 1L; c", ["c"]),
      ], (event) => { events.push(event); });
      assert.deepEqual(results.map((result) => result?.ok), [true, true, true]);
      for (const [index, result] of results.entries()) {
        assert.match(JSON.stringify(result?.outputs), new RegExp(`\\[1\\] ${index + 1}`));
      }
      assert.ok((results[0]!.outputs as Array<{ kind: string }>).some((output) => output.kind === "image"));
      assert.ok(results.slice(1).every((result) => !(result!.outputs as Array<{ kind: string }>).some((output) => output.kind === "image")));
      assert.deepEqual(results[0]!.log, ["first callback"]);
      assert.deepEqual(results[1]!.log, []);
      assert.deepEqual(events.filter((event) => event.type !== "output").map((event) => [event.cellId, event.type]), [
        ["batch-a", "started"], ["batch-a", "completed"],
        ["batch-b", "started"], ["batch-b", "completed"],
        ["batch-c", "started"], ["batch-c", "completed"],
      ]);
      assert.equal(new Set(events.map((event) => event.requestId)).size, 1);
      const traces = (await readFile(join(directory, `host-${process.pid}.jsonl`), "utf8"))
        .trim().split("\n").map((line) => JSON.parse(line));
      const batchTrace = traces.find((record) => record.event === "end" && record.fields?.cmd === "eval_batch");
      assert.equal(batchTrace?.fields.operation_id, "batch");
      assert.equal(batchTrace?.fields.run_id, events[0]!.runId);
      assert.equal(batchTrace?.fields.session_epoch, events[0]!.sessionEpoch);
      assert.deepEqual((await readdir(cacheDirectory)).filter((name) => name.startsWith(".alder-batch-")), []);
      const next = await engine.evaluate(payload("batch-next", "batch-next", "stopifnot(identical(.Last.value, 3L)); 42L"));
      assert.equal(next.ok, true);
    } finally {
      await engine.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

test("native batch invalidation, Stop, errors and out$stop prevent queued effects", integration,
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "alder-engine-batch-stop-"));
    const marker = join(directory, "queued-effect");
    const engine = newEngine(directory);
    try {
      await engine.start();
      for (const mode of ["edit", "interrupt", "error", "stop"] as const) {
        let interruption: Promise<unknown> | undefined;
        const source = mode === "error" ? "a <- 1L; stop('batch failure')"
          : mode === "stop" ? "out$stop()" : "Sys.sleep(0.1); a <- 1L; a";
        const results = await engine.evaluateBatch([
          payload("batch-stop", "batch-root", source, ["a"]),
          payload("batch-stop", "batch-child", `writeLines('ran', ${JSON.stringify(marker)}); 2L`),
        ], (event) => {
          if (event.type !== "started" || event.cellId !== "batch-root") return;
          if (mode === "edit") engine.invalidateBatch(new Set(["batch-child"]));
          if (mode === "interrupt") interruption = engine.interrupt(event.requestId);
        });
        await interruption;
        assert.equal(results[0]?.ok, mode === "edit" || mode === "stop", mode);
        if (mode === "interrupt") assert.equal(results[0]?.error?.interrupted, true);
        if (mode === "error") assert.equal(results[0]?.error?.message, "batch failure");
        if (mode === "stop") assert.equal(results[0]?.stopped, true);
        assert.equal(results[1], undefined, mode);
        await assert.rejects(access(marker));
        assert.equal((await engine.evaluate(payload("batch-recovery", "batch-recovery", "42L"))).ok, true);
      }
      let interruption: Promise<unknown> | undefined;
      const partial = await engine.evaluateBatch([
        payload("partial-batch", "partial-root", "a <- 1L; a", ["a"]),
        payload("partial-batch", "partial-child", "Sys.sleep(1); b <- a + 1L; b", ["b"]),
        payload("partial-batch", "partial-leaf", `writeLines('ran', ${JSON.stringify(marker)}); 3L`),
      ], (event) => {
        if (event.type === "started" && event.cellId === "partial-child") {
          interruption = engine.interrupt(event.requestId);
        }
      });
      await interruption;
      assert.equal(partial[0]?.ok, true);
      assert.equal(partial[1]?.error?.interrupted, true);
      assert.equal(partial[2], undefined);
      await assert.rejects(access(marker));
      assert.equal((await engine.request("get_value", { name: "b" })).ok, false);

      await assert.rejects(engine.evaluateBatch([
        payload("batch-consumer", "consumer-root", "out$append(1L); Sys.sleep(0.1); 1L"),
        payload("batch-consumer", "consumer-child", `writeLines('ran', ${JSON.stringify(marker)}); 2L`),
      ], (event) => {
        if (event.type === "output") throw new Error("batch output rejected");
      }), /batch output rejected/);
      await assert.rejects(access(marker));
      assert.equal((await engine.evaluate(payload("consumer-recovery", "consumer-recovery", "42L"))).ok, true);
    } finally {
      await engine.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

test("Ark keeps implementation state private and streams renderer conditions", integration,
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "alder-engine-test-"));
    const engine = newEngine(directory);
    const events: EngineEvent[] = [];
    try {
      await engine.start();
      const clean = await engine.evaluate(payload(
        "private-runtime",
        "private-runtime",
        "identical(ls(.GlobalEnv, all.names = TRUE), character())",
      ));
      assert.match(JSON.stringify(clean.outputs), /TRUE/);

      const rendered = await engine.evaluate(payload(
        "renderer-condition",
        "renderer-condition",
        [
          "as.data.frame.noisy_frame <- function(x, ...) {",
          '  warning("renderer warning")',
          "  NextMethod()",
          "}",
          "d <- data.frame(value = 1:2)",
          'class(d) <- c("noisy_frame", "data.frame")',
          "d",
        ].join("\n"),
        ["as.data.frame.noisy_frame", "d"],
      ), (event) => events.push(event));
      assert.equal(rendered.ok, true);
      assert.ok((rendered.outputs as Array<{ kind?: string }>).some(
        (output) => output.kind === "table",
      ));
      assert.match(rendered.log?.join("\n") ?? "", /renderer warning/);
      assert.ok(events.some((event) => event.type === "output" && event.kind === "log"));
    } finally {
      await engine.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

test("evaluation clears its own previous bindings before replacement source", integration, async () => {
  const directory = await mkdtemp(join(tmpdir(), "alder-engine-replace-"));
  const engine = newEngine(directory);
  try {
    await engine.start();
    const initial = await engine.evaluate(payload("initial", "one", "old <- 1; old", ["old"]));
    assert.equal(initial.ok, true);
    const replacement = await engine.evaluate(payload("replacement", "one",
      "stopifnot(!exists('old', inherits = FALSE)); current <- 2; current", ["current"]));
    assert.equal(replacement.ok, true);
    assert.match(JSON.stringify(replacement.outputs), /\[1\] 2/);
    assert.equal((await engine.request("get_value", { name: "old" })).ok, false);
  } finally {
    await engine.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("native print failures roll back definitions and auxiliary requests preserve last value",
  integration, async () => {
    const directory = await mkdtemp(join(tmpdir(), "alder-engine-native-print-"));
    const engine = newEngine(directory);
    try {
      await engine.start();
      const failed = await engine.evaluate(payload(
        "native-print-failure",
        "native-print-failure",
        [
          "print.htmlwidget <- function(x, ...) {",
          "  stop(structure(list(message = 'native print failed', call = NULL,",
          "    code = 'native_print_failed'),",
          "    class = c('native_print_failure', 'error', 'condition')))",
          "}",
          "native_value <- structure(list(), class = 'htmlwidget')",
          "native_value",
        ].join("\n"),
        ["print.htmlwidget", "native_value"],
      ));
      assert.equal(failed.ok, false);
      assert.equal(failed.error?.message, "native print failed");
      assert.equal(failed.error?.code, "native_print_failed");
      const removed = await engine.request("get_value", { name: "native_value" });
      assert.equal(removed.ok, false);

      const prefixOnly = await engine.evaluate(payload(
        "condition-prefix",
        "condition-prefix",
        [
          "stop(structure(list(message = 'prefix field', call = NULL,",
          "  code_detail = 'must-not-partially-match'),",
          "  class = c('prefix_error', 'error', 'condition')))",
        ].join("\n"),
      ));
      assert.equal(prefixOnly.ok, false);
      assert.equal(prefixOnly.error?.message, "prefix field");
      assert.equal(prefixOnly.error?.code, undefined);

      const value = await engine.evaluate(payload(
        "last-value-set", "last-value-set", "last_value <- 42L; last_value", ["last_value"],
      ));
      assert.equal(value.ok, true);
      const variables = await engine.request("env_snapshot", {});
      assert.equal(variables.ok, true);
      const partialName = await engine.request("get_value", { name_suffix: "last_value" });
      assert.equal(partialName.ok, false);
      const preserved = await engine.evaluate(payload(
        "last-value-read", "last-value-read", "identical(.Last.value, 42L)",
      ));
      assert.equal(preserved.ok, true);
      assert.match(JSON.stringify(preserved.outputs), /TRUE/);
    } finally {
      await engine.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

test("opaque preparation acknowledges and interrupts inside an active binding", integration,
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "alder-engine-active-binding-"));
    const engine = newEngine(directory);
    try {
      await engine.start();
      const installed = await engine.evaluate(payload(
        "active-binding-install",
        "active-binding-install",
        [
          "makeActiveBinding('prep_binding', function(value) {",
          "  if (!missing(value)) stop('active binding is read-only')",
          "  cat('active-binding-entered\\n')",
          "  flush.console()",
          "  repeat Sys.sleep(1)",
          "}, .GlobalEnv)",
        ].join("\n"),
        ["prep_binding"],
      ));
      assert.equal(installed.ok, true);

      let requestId: number | undefined;
      let resolveEntered!: () => void;
      const entered = new Promise<void>((resolve) => { resolveEntered = resolve; });
      const preparing = engine.evaluate({
        ...payload("active-binding-prep", "active-binding-prep", "42L"),
        opaque: true,
      }, (event) => {
        if (event.type === "started") requestId = event.requestId;
        if (event.type === "output" && event.kind === "log" &&
            JSON.stringify(event.payload).includes("active-binding-entered")) {
          resolveEntered();
        }
      });
      await deadline(entered, 5_000, "active binding entry");
      assert.ok(requestId !== undefined);
      assert.deepEqual(await engine.interrupt(requestId), {
        requested: true,
        requestId,
      });
      const interrupted = await deadline(preparing, 5_000, "active binding interrupt");
      assert.equal(interrupted.ok, false);
      assert.equal(interrupted.error?.interrupted, true);

      const recovered = await engine.evaluate(payload(
        "active-binding-recover", "active-binding-recover", "rm(prep_binding); 6 * 7",
      ));
      assert.equal(recovered.ok, true);
      assert.match(JSON.stringify(recovered.outputs), /42/);
    } finally {
      await engine.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

test("persistent kernel keeps RNG, libraries, external pointers and error effects", integration,
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "alder-engine-test-"));
    const engine = newEngine(directory);
    try {
      await engine.start();
      const initialized = await engine.evaluate(payload(
        "semantics-set",
        "semantics-one",
        [
          "set.seed(42)",
          "first <- runif(1)",
          "library(splines)",
          "old_libs <- .libPaths()",
          ".libPaths(c(tempdir(), old_libs))",
          'pointer <- methods::new("externalptr")',
          "pointer_alias <- pointer",
          "box <- new.env()",
          "box$value <- 1L",
          "first",
        ].join("\n"),
        ["first", "old_libs", "pointer", "pointer_alias", "box"],
      ));
      assert.equal(initialized.ok, true);
      assert.match(JSON.stringify(initialized.outputs), /0\.914806/);

      const continued = await engine.evaluate(payload(
        "semantics-read",
        "semantics-two",
        [
          "second <- runif(1)",
          "list(first = first, second = second,",
          '  library = "package:splines" %in% search(),',
          '  libpath = identical(.libPaths()[[1L]], tempdir()),',
          '  pointer = typeof(pointer) == "externalptr" && identical(pointer, pointer_alias))',
        ].join("\n"),
        ["second"],
      ));
      const continuedText = JSON.stringify(continued.outputs);
      assert.match(continuedText, /0\.914806/);
      assert.match(continuedText, /0\.937075/);
      assert.match(continuedText, /TRUE/);

      const failed = await engine.evaluate(payload(
        "semantics-error",
        "semantics-error",
        'box$value <- 9L; options(alder.error.effect = "kept"); stop("expected failure")',
      ));
      assert.equal(failed.ok, false);
      assert.match(failed.error?.message ?? "", /expected failure/);
      const effects = await engine.evaluate(payload(
        "semantics-effects",
        "semantics-effects",
        'identical(box$value, 9L) && identical(getOption("alder.error.effect"), "kept") && identical(pointer, pointer_alias)',
      ));
      assert.match(JSON.stringify(effects.outputs), /TRUE/);
    } finally {
      await engine.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

test("Ark captures native plotting inside functions and owns its artifacts", integration,
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "alder-engine-test-"));
    const artifactDirectory = join(directory, "artifacts");
    const engine = newEngine(directory, { artifactDirectory });
    try {
      await engine.start();
      const plotted = await engine.evaluate(payload(
        "capture-plot",
        "capture-two",
        [
          "draw_from_function <- function() graphics::plot(1:4, 4:1)",
          "draw_from_function()",
          "list(device = names(grDevices::dev.cur()),",
          "  scratch = length(list.files(",
          '    tempdir(), pattern = "^alder-base-device-")))',
        ].join("\n"),
        ["draw_from_function"],
      ));
      assert.equal(plotted.ok, true);
      const outputs = plotted.outputs as Array<{ kind?: string }>;
      assert.ok(outputs.some((output) => output.kind === "image"));
      assert.match(JSON.stringify(outputs), /device/);
      assert.match(JSON.stringify(outputs), /scratch.*0/);
      const image = outputs.find((output) => output.kind === "image") as
        { kind: string; artifact: string };
      await access(join(artifactDirectory, image.artifact));

      const hostOwned = join(artifactDirectory, "host-owned.html");
      await writeFile(hostOwned, "retained");
      const ignored = await engine.request("release_outputs", {
        artifacts: ["host-owned.html"],
      });
      assert.deepEqual(ignored.missing, ["host-owned.html"]);
      await access(hostOwned);
      const traversal = await engine.request("release_outputs", {
        artifacts: ["../host-owned.html"],
      });
      assert.equal(traversal.ok, false);
      await access(hostOwned);
      const released = await engine.request("release_outputs", {
        artifacts: [image.artifact],
      });
      assert.equal(released.ok, true);
      assert.deepEqual(released.released, [image.artifact]);
      await assert.rejects(access(join(artifactDirectory, image.artifact)));

      const recovered = await engine.evaluate(payload(
        "capture-recover",
        "capture-recover",
        "graphics::plot(1:2); 42L",
      ));
      assert.ok((recovered.outputs as Array<{ kind?: string }>).some(
        (output) => output.kind === "image",
      ));
      assert.match(JSON.stringify(recovered.outputs), /42/);
    } finally {
      await engine.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

test("streams ordered output and the analyzer remains live during evaluation", integration,
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "alder-engine-test-"));
    const engine = newEngine(directory);
    const events: EngineEvent[] = [];
    try {
      await engine.start();
      let startedResolve!: () => void;
      const started = new Promise<void>((resolve) => { startedResolve = resolve; });
      let evaluationDone = false;
      const evaluation = engine.evaluate(
        payload(
          "stream",
          "stream-cell",
          'out$append(1:3); p <- out$progress(1); p$update(1); message("hello"); Sys.sleep(1.5); "tail"',
          ["p"],
        ),
        (event) => {
          events.push(event);
          if (event.type === "started") startedResolve();
        },
      ).finally(() => { evaluationDone = true; });
      await started;
      const analysis = await engine.analyze([
        { id: "other", revision: 1, type: "code", source: "answer <- 42" },
      ], 1);
      assert.equal(evaluationDone, false);
      assert.deepEqual(analysis.cells[0]?.defs, ["answer"]);
      await evaluation;
      const outputEvents = events.filter(
        (event): event is Extract<EngineEvent, { type: "output" }> => event.type === "output",
      );
      assert.deepEqual(outputEvents.map((event) => event.sequence), [1, 2, 3]);
      assert.deepEqual(outputEvents.map((event) => event.kind), [
        "append", "progress", "log",
      ]);
      assert.equal(events.at(-1)?.type, "completed");
    } finally {
      await engine.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

test("Jupyter deferred clear resets streamed outputs before the next output", integration,
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "alder-engine-clear-output-"));
    const engine = newEngine(directory);
    const events: EngineEvent[] = [];
    try {
      await engine.start();
      const kernel = (engine as unknown as { kernel?: ArkKernel }).kernel;
      assert.ok(kernel);
      const execute = kernel.execute.bind(kernel);
      let injected = false;
      kernel.execute = ((code, callbacks = {}, options = {}) => execute(code, {
        ...callbacks,
        onMessage: (message) => {
          callbacks.onMessage?.(message);
          if (!injected && alderEventType(message) === "append") {
            injected = true;
            callbacks.onMessage?.(clearOutputMessage(true));
          }
        },
      }, options)) as ArkKernel["execute"];
      try {
        const response = await engine.evaluate(payload(
          "clear-output", "clear-output", "out$append(1L); cat('tail'); 42L",
        ), (event) => events.push(event));
        assert.equal(response.ok, true);
        assert.equal(injected, true);
        assert.equal(response.outputs?.length, 1);
        assert.match(JSON.stringify(response.outputs), /42/);
        assert.deepEqual(response.log, ["tail"]);
        const outputEvents = events.filter(
          (event): event is Extract<EngineEvent, { type: "output" }> =>
            event.type === "output",
        );
        assert.deepEqual(outputEvents.map((event) => event.kind), [
          "append", "clear", "log",
        ]);
        assert.deepEqual(outputEvents.map((event) => event.sequence), [1, 2, 3]);
        assert.deepEqual(outputEvents[1]?.payload, {});
      } finally {
        kernel.execute = execute;
      }
    } finally {
      await engine.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

test("discarded evaluation output artifacts are removed when a consumer callback fails",
  integration, async () => {
    const directory = await mkdtemp(join(tmpdir(), "alder-engine-discard-output-"));
    const artifactDirectory = join(directory, "artifacts");
    const engine = newEngine(directory, { artifactDirectory });
    try {
      await engine.start();
      await assert.rejects(engine.evaluate(payload(
        "discard-output",
        "discard-output",
        "graphics::plot(1:3); out$append(grDevices::recordPlot()); 42L",
      ), (event) => {
        if (event.type === "output" && event.kind === "append") {
          throw new Error("consumer rejected streamed output");
        }
      }), /consumer rejected streamed output/);
      const remaining = (await readdir(artifactDirectory)).filter(
        (name) => !name.startsWith(".alder-capture-"),
      );
      assert.deepEqual(remaining, []);
    } finally {
      await engine.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

test("a Stop delivered after the R completion marker stays successful and cannot spill",
  integration, async () => {
    const directory = await mkdtemp(join(tmpdir(), "alder-engine-late-stop-"));
    const engine = newEngine(directory);
    let stop: Promise<{ requested: boolean; requestId?: number }> | undefined;
    let stoppedRequestId: number | undefined;
    try {
      await engine.start();
      const kernel = (engine as unknown as { kernel?: ArkKernel }).kernel;
      assert.ok(kernel);
      const execute = kernel.execute.bind(kernel);
      const interrupt = kernel.interrupt.bind(kernel);
      let releaseInterrupt!: () => void;
      const delivered = new Promise<boolean>((resolve) => {
        releaseInterrupt = () => resolve(true);
      });
      kernel.interrupt = () => delivered;
      kernel.execute = ((code, callbacks = {}, options = {}) => execute(code, {
        ...callbacks,
        onMessage: (message) => {
          callbacks.onMessage?.(message);
          if (alderEventType(message) === "finished") releaseInterrupt();
        },
      }, options)) as ArkKernel["execute"];
      try {
        const first = engine.evaluate(payload(
          "late-stop-first", "late-stop-first", "40L + 2L",
        ), (event) => {
          if (event.type === "started") {
            stoppedRequestId = event.requestId;
            stop = engine.interrupt(event.requestId);
          }
        });
        const second = engine.evaluate(payload(
          "late-stop-second", "late-stop-second", "6L * 7L",
        ));
        const [firstResult, secondResult] = await Promise.all([first, second]);
        assert.ok(stop !== undefined && stoppedRequestId !== undefined);
        assert.deepEqual(await stop, {
          requested: true,
          requestId: stoppedRequestId,
        });
        assert.equal(firstResult.ok, true);
        assert.match(JSON.stringify(firstResult.outputs), /42/);
        assert.equal(secondResult.ok, true);
        assert.match(JSON.stringify(secondResult.outputs), /42/);
      } finally {
        kernel.execute = execute;
        kernel.interrupt = interrupt;
      }
    } finally {
      await engine.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

test("interrupt is request-scoped and the same kernel remains usable", integration,
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "alder-engine-test-"));
    const engine = newEngine(directory);
    try {
      await engine.start();
      const before = Date.now();
      const pending = engine.evaluate(
        payload("stop-before-ack", "slow-before-ack", "repeat Sys.sleep(1)"),
      );
      const requestedBeforeAck = await engine.interrupt();
      assert.equal(requestedBeforeAck.requested, true);
      const interrupted = await pending;
      assert.equal(interrupted.ok, false);
      assert.equal(interrupted.error?.interrupted, true);

      for (let attempt = 0; attempt < 5; attempt += 1) {
        const interruptedAfterAck = await engine.evaluate(
          payload(
            `stop-after-ack-${attempt}`,
            `slow-after-ack-${attempt}`,
            "repeat Sys.sleep(1)",
          ),
          (event) => {
            if (event.type === "started") void engine.interrupt(event.requestId);
          },
        );
        assert.equal(interruptedAfterAck.ok, false);
        assert.equal(interruptedAfterAck.error?.interrupted, true);
      }
      assert.ok(Date.now() - before < 5_000);
      const next = await engine.evaluate(payload("after-stop", "next", "6 * 7"));
      assert.equal(next.ok, true);
      assert.match(JSON.stringify(next.outputs), /42/);
      assert.deepEqual(await engine.interrupt(), { requested: false });
    } finally {
      await engine.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

test("unexpected kernel death is reported once and restart creates a usable epoch", integration,
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "alder-engine-test-"));
    const artifactDirectory = join(directory, "artifacts");
    const engine = newEngine(directory, { artifactDirectory });
    const failures: Array<{ role: string; message: string }> = [];
    const unsubscribe = engine.onFailure((role, error) => {
      failures.push({ role, message: error.message });
    });
    try {
      await engine.start();
      const [oldCaptureName] = (await readdir(artifactDirectory)).filter(
        (name) => name.startsWith(".alder-capture-"),
      );
      assert.ok(oldCaptureName);
      const oldCaptureDirectory = join(artifactDirectory, oldCaptureName);
      let evaluationStarted!: () => void;
      const started = new Promise<void>((resolveStarted) => {
        evaluationStarted = resolveStarted;
      });
      const dying = engine.evaluate(
        payload("die", "die", "repeat Sys.sleep(1)"),
        (event) => { if (event.type === "started") evaluationStarted(); },
      );
      await started;
      const kernelPid = (engine as unknown as {
        kernel?: { processId?: number };
      }).kernel?.processId;
      assert.ok(kernelPid !== undefined && kernelPid > 0);
      process.kill(kernelPid, "SIGKILL");
      await assert.rejects(
        dying,
        /Ark exited|kernel exited|before responding/,
      );
      assert.equal(failures.length, 1);
      assert.equal(failures[0]?.role, "kernel");
      await access(oldCaptureDirectory);
      const ready = await engine.restart();
      assert.equal(ready.kernelReady, true);
      await assert.rejects(access(oldCaptureDirectory));
      const [newCaptureName] = (await readdir(artifactDirectory)).filter(
        (name) => name.startsWith(".alder-capture-"),
      );
      assert.ok(newCaptureName);
      assert.notEqual(newCaptureName, oldCaptureName);
      const recovered = await engine.evaluate(payload("recovered", "recovered", "42"));
      assert.match(JSON.stringify(recovered.outputs), /42/);
    } finally {
      unsubscribe();
      await engine.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

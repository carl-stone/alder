import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHarness, delay, sanitizedEnvironment, waitForExecutionReady } from "./_common.mjs";

async function waitTerminal(harness, operationId, timeout = 120_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const envelope = await harness.query({ type: "operation", operationId });
    const operation = envelope.result;
    if (["done", "error", "interrupted", "cancelled"].includes(operation?.status)) return operation;
    if (Date.now() >= deadline) throw new Error("operation_timeout: " + operationId);
    await delay(40);
  }
}

async function issue(harness, command) {
  const admission = await harness.nextCommand(command);
  assert.equal(admission.accepted, true, JSON.stringify(admission));
  return waitTerminal(harness, admission.operationId);
}
async function waitForSnapshot(harness, predicate, timeout = 30_000) {
  assert.equal(typeof predicate, "function");
  const deadline = Date.now() + timeout;
  for (;;) {
    const current = await harness.snapshot();
    if (predicate(current)) return current;
    if (Date.now() >= deadline) throw new Error("snapshot_condition_timeout");
    await delay(100);
  }
}

export async function run(ctx) {
  const source = [
    "# %%", "x <- 40", "x",
    "# %%", "y <- x + 2", "y",
    "# %%", "make_adder <- function(n) function(v) v + n", "adder <- make_adder(5)", "adder(7)",
    "# %%", "library(alder)", "square <- cache$memory(function(v) v ^ 2)", "square(4)",
  ].join("\n") + "\n";
  const harness = await createHarness(ctx, { id: "r-semantics", source });
  try {
    await waitForExecutionReady(harness);
    const initial = await harness.snapshot();
    assert.equal(initial.runtime.kernelState, "ready");
    assert.equal(initial.runtime.executionReady, true);
    const initialKernel = initial.runtime.kernelEpoch;
    const first = initial.cells[0];
    const second = initial.cells[1];
    const third = initial.cells[2];
    const fourth = initial.cells[3];
    assert.ok(first && second && third && fourth);

    const dependent = await issue(harness, { type: "run", scope: "cell", target: { cellId: second.id }, expectedDocumentRevision: initial.documentRevision });
    assert.equal(dependent.status, "done", JSON.stringify(dependent));
    let current = await harness.snapshot();
    const dependentOutputs = current.cells.slice(0, 2).flatMap(cell => cell.outputs).map(output => JSON.stringify(output));
    assert.match(dependentOutputs.join("\n"), /40/);
    assert.match(dependentOutputs.join("\n"), /42/);

    const closure = await issue(harness, { type: "run", scope: "cell", target: { cellId: third.id }, expectedDocumentRevision: current.documentRevision });
    assert.equal(closure.status, "done", JSON.stringify(closure));
    current = await waitForSnapshot(harness, snapshotValue => snapshotValue.variables.some(variable => variable.name === "adder" && variable.owner === third.id));
    assert.match(current.cells[2].outputs.map(output => JSON.stringify(output)).join("\n"), /12/);
    assert.ok(current.variables.some(variable => variable.name === "adder" && variable.owner === third.id));

    const cached = await issue(harness, { type: "run", scope: "cell", target: { cellId: fourth.id }, expectedDocumentRevision: current.documentRevision });
    assert.equal(cached.status, "done", JSON.stringify(cached));
    current = await harness.snapshot();
    assert.match(current.cells[3].outputs.map(output => JSON.stringify(output)).join("\n"), /16/);
    assert.equal(current.runtime.kernelEpoch, initialKernel);

    const failureCreationId = "r-semantics-failure";
    const createdFailure = await issue(harness, {
      type: "transaction", expectedDocumentRevision: current.documentRevision,
      changes: [{
        type: "create", creationId: failureCreationId, after: { cellId: fourth.id },
        cellType: "code", body: ["tmp <- 99", "library(stats)", "stop('owned failure')"], options: {},
      }],
    });
    assert.equal(createdFailure.status, "done", JSON.stringify(createdFailure));
    const createdFailureId = createdFailure.result?.created?.[failureCreationId];
    assert.equal(typeof createdFailureId, "string", JSON.stringify(createdFailure));
    current = await harness.snapshot();
    const failure = current.cells.find(cell => cell.id === createdFailureId);
    assert.ok(failure, JSON.stringify(current.cells));
    const failed = await issue(harness, { type: "run", scope: "cell", target: { cellId: createdFailureId }, expectedDocumentRevision: current.documentRevision });
    assert.equal(failed.status, "error", JSON.stringify(failed));
    assert.match(JSON.stringify(failed.error), /owned failure/);
    current = await harness.snapshot();
    const failureKernel = current.runtime.kernelEpoch;
    current = await waitForSnapshot(harness, snapshotValue => !snapshotValue.variables.some(variable => variable.name === "tmp"));
    assert.equal(current.runtime.kernelEpoch, failureKernel);
    assert.match(JSON.stringify(current.cells.find(cell => cell.id === createdFailureId)?.error), /owned failure/);
    assert.equal(current.variables.some(variable => variable.name === "tmp"), false);
    const removedFailure = await issue(harness, {
      type: "transaction", expectedDocumentRevision: current.documentRevision,
      changes: [{ type: "delete", cell: { cellId: createdFailureId }, expectedRevision: failure.revision }],
    });
    assert.equal(removedFailure.status, "done", JSON.stringify(removedFailure));
    current = await harness.snapshot();
    const beforeBarrierRestartEpoch = current.runtime.kernelEpoch;

    const missing = await issue(harness, { type: "inspect", name: "tmp", kernelEpoch: current.runtime.kernelEpoch });
    assert.equal(missing.status, "error", JSON.stringify(missing));
    assert.match(JSON.stringify(missing.error), /tmp|not found|unavailable|stale_value|not current/i);

    const stillUsable = await issue(harness, { type: "run", scope: "cell", target: { cellId: second.id }, expectedDocumentRevision: current.documentRevision });
    assert.equal(stillUsable.status, "done", JSON.stringify(stillUsable));
    current = await harness.snapshot();
    assert.notEqual(current.runtime.kernelEpoch, beforeBarrierRestartEpoch);
    assert.equal(current.runtime.kernelState, "ready");

    const beforeExplicitRestartEpoch = current.runtime.kernelEpoch;
    const restarted = await issue(harness, { type: "restart", replay: false, expectedDocumentRevision: current.documentRevision });
    assert.equal(restarted.status, "done", JSON.stringify(restarted));
    current = await harness.snapshot();
    assert.notEqual(current.runtime.kernelEpoch, beforeExplicitRestartEpoch);
    assert.equal(current.runtime.kernelState, "ready");
    const afterRestartRun = await issue(harness, { type: "run", scope: "cell", target: { cellId: first.id }, expectedDocumentRevision: current.documentRevision });
    assert.equal(afterRestartRun.status, "done", JSON.stringify(afterRestartRun));

    const deleted = await issue(harness, {
      type: "transaction", expectedDocumentRevision: current.documentRevision,
      changes: [{ type: "delete", cell: { cellId: first.id }, expectedRevision: first.revision }],
    });
    assert.equal(deleted.status, "done", JSON.stringify(deleted));
    current = await harness.snapshot();
    const surviving = current.cells.find(cell => cell.id === second.id);
    assert.ok(surviving);
    assert.notEqual(surviving.status, "done");

    const plain = spawnSync(harness.selectedR, ["--vanilla", "-e", [
      "suppressPackageStartupMessages(library(alder))",
      "stopifnot(is.list(cache), is.function(cache$memory))",
      "f <- cache$memory(function(x) x + 1)",
      "stopifnot(identical(f(4), 5))",
      "stopifnot(inherits(out$md('ordinary R value'), 'alder_output'))",
      "cat(as.character(getRversion()), '\n')",
    ].join(";"), "--args"], {
      encoding: "utf8",
      env: sanitizedEnvironment({ R_LIBS: ctx.applicationRoot + "/" + ctx.manifest.resources.rLibraryDirectory }),
      timeout: 30_000,
    });
    assert.equal(plain.status, 0, plain.stderr || plain.stdout);
    assert.match(plain.stdout, /^4[.]/);

    return {
      id: "r-semantics",
      identity: {
        artifact: { sourceCommit: ctx.manifest.sourceCommit, hostProtocol: ctx.manifest.hostProtocol, engineProtocol: ctx.manifest.engineProtocol },
        runtime: { rscript: harness.selectedR, rVersion: current.runtime.rEnvironment?.version, kernelEpochBeforeRestart: initialKernel, kernelEpochAfterRestart: current.runtime.kernelEpoch, executionReady: current.runtime.executionReady },
        semantics: { dependency: "40/42", closure: "12", cache: "16", ownedErrorCleanup: true, plainRHelper: true },
      },
    };
  } finally {
    await harness.close();
  }
}

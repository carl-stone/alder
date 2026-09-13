import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createHarness, delay, waitForExecutionReady } from "./_common.mjs";

function unwrap(value) {
  return value && typeof value === "object" && "result" in value ? value.result : value;
}

async function waitTerminal(harness, operationId, timeout = 120_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const operation = unwrap(await harness.query({ type: "operation", operationId }));
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


export async function run(ctx) {
  assert.equal(ctx.manifest.hostProtocol, "alder-host-v2");
  assert.equal(ctx.manifest.engineProtocol, "alder-engine-v2");
  const lockPath = join(ctx.applicationRoot, dirname(ctx.manifest.resources.hostEntry), "locks", "ark-lock.json");
  const lock = JSON.parse(await readFile(lockPath, "utf8"));
  assert.equal(lock.schemaVersion, 1);
  assert.equal(lock.baseCommit, ctx.manifest.runtimes.ark.baseCommit);
  assert.equal(lock.patch.sha256, ctx.manifest.runtimes.ark.patchSha256);
  assert.equal(lock.mimePublisher, "alder-json-v1");
  assert.equal(ctx.manifest.runtimes.ark.mimePublisher, "alder-json-v1");
  assert.equal(ctx.manifest.runtimes.ark.upstreamVersion, lock.upstreamVersion);
  assert.notEqual(ctx.manifest.runtimes.ark.buildVersion, ctx.manifest.runtimes.ark.upstreamVersion);

  const validSource = [
    "# %%",
    "as.environment('tools:positron')[[\"ark_publish_mimebundle\"]](\"{\\\"application/json\\\":{\\\"empty_array\\\":[],\\\"empty_object\\\":{},\\\"scalar\\\":1e20,\\\"unicode\\\":\\\"λ\\\"}}\", \"{\\\"publisher\\\":\\\"ark\\\"}\", \"{}\")",
    "# %%",
    "cat('native-stream\\n')",
    "# %%",
    "plot(1:3)",
  ].join("\n") + "\n";
  const valid = await createHarness(ctx, { id: "ark-publisher", source: validSource });
  try {
    await waitForExecutionReady(valid);
    const initial = await valid.snapshot();
    const run = await issue(valid, { type: "run", scope: "all", expectedDocumentRevision: initial.documentRevision });
    assert.equal(run.status, "done", JSON.stringify(run));
    const current = await valid.snapshot();
    const publisherOutputs = current.cells[0].outputs;
    const jsonRecord = publisherOutputs.find(output => output.data?.mime === "application/json");
    assert.ok(jsonRecord, JSON.stringify(publisherOutputs));
    assert.deepEqual(jsonRecord.data.value, { empty_array: [], empty_object: {}, scalar: 1e20, unicode: "λ" });
    assert.equal(publisherOutputs.length, 1, "one public publisher call must create one output record");
    assert.equal(publisherOutputs.some(output => JSON.stringify(output).includes("ALDER_EVENT_V1")), false);
    assert.equal(current.cells[1].log.join("\n").includes("native-stream"), true);
    const plotOutputs = current.cells[2].outputs;
    assert.equal(plotOutputs.filter(output => output.data?.kind === "image").length, 1, JSON.stringify(plotOutputs));

    const invalidValue = await createHarness(ctx, {
      id: "ark-publisher-invalid",
      source: [
        "# %%",
        "as.environment('tools:positron')[[\"ark_publish_mimebundle\"]](\"[]\", \"{}\", \"{}\")",
      ].join("\n") + "\n",
    });
    try {
      await waitForExecutionReady(invalidValue);
      const invalidInitial = await invalidValue.snapshot();
      const invalidRun = await issue(invalidValue, { type: "run", scope: "all", expectedDocumentRevision: invalidInitial.documentRevision });
      assert.equal(invalidRun.status, "error", JSON.stringify(invalidRun));
      assert.match(JSON.stringify(invalidRun.error), /object|JSON|data/i);
      const invalidFinal = await invalidValue.snapshot();
      assert.equal(invalidFinal.cells[0].outputs.length, 0);
    } finally {
      await invalidValue.close();
    }

    let deep = "0";
    for (let index = 0; index < 65; index += 1) deep = '{"v":' + deep + "}";
    const deepHarness = await createHarness(ctx, {
      id: "ark-publisher-depth",
      source: [
        "# %%",
        "as.environment('tools:positron')[[\"ark_publish_mimebundle\"]](" + JSON.stringify(deep) + ", \"{}\", \"{}\")",
      ].join("\n") + "\n",
    });
    try {
      await waitForExecutionReady(deepHarness);
      const deepInitial = await deepHarness.snapshot();
      const deepRun = await issue(deepHarness, { type: "run", scope: "all", expectedDocumentRevision: deepInitial.documentRevision });
      assert.equal(deepRun.status, "error", JSON.stringify(deepRun));
      assert.match(JSON.stringify(deepRun.error), /depth|nest|JSON/i);
      const deepFinal = await deepHarness.snapshot();
      assert.equal(deepFinal.cells[0].outputs.length, 0);
    } finally {
      await deepHarness.close();
    }

    return {
      id: "ark-publisher",
      identity: {
        artifact: { sourceCommit: ctx.manifest.sourceCommit, ark: ctx.manifest.runtimes.ark, lock: { baseCommit: lock.baseCommit, patchSha256: lock.patch.sha256, rustToolchain: lock.rustToolchain } },
        runtime: { rscript: valid.selectedR, rVersion: current.runtime.rEnvironment?.version, kernelEpoch: current.runtime.kernelEpoch, processNonce: valid.registry.processNonce, publicMimePublisher: true },
        publisher: { objectFidelity: true, nativeStreamCount: 1, plotCount: 1, invalidPayloadRejected: true, deepPayloadRejected: true, privateHooksObserved: false },
      },
    };
  } finally {
    await valid.close();
  }
}

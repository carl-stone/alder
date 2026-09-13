import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  cleanupScenarioResources,
  createHarness,
  redact,
  sanitizedEnvironment,
  waitForExecutionReady,
} from './_common.mjs';

const TOOL_NAMES = [
  'notebook_state', 'list_cells', 'read_cell', 'add_cell', 'edit_cell', 'delete_cell',
  'move_cell', 'rename_cell', 'disable_cell', 'run_cell', 'run_all', 'run_stale',
  'interrupt', 'get_value', 'set_widget', 'save', 'check', 'apply_transaction',
  'edit_cell_ranges', 'select_r', 'set_runtime', 'reload_source', 'get_help',
  'recovery_state', 'shutdown', 'restart', 'format', 'save_as', 'read_output',
  'table_page', 'materialize_output', 'operation_status', 'read_events', 'get_config',
  'set_config', 'get_layout', 'set_layout', 'set_app', 'packages_status',
  'packages_declare', 'packages_install', 'publish', 'upload_file',
];
const RESOURCE_URIS = [
  'alder://notebook/source', 'alder://notebook/dag', 'alder://notebook/state',
];
const RESOURCE_TEMPLATES = [
  'alder://cell/{cell}/outputs', 'alder://operations/{operation}', 'alder://outputs/{output}',
];
const TOOL_ARGUMENT_KEYS = {
  notebook_state: [],
  list_cells: ['offset', 'limit'],
  read_cell: ['cell'],
  add_cell: ['operationId', 'commandSequence', 'expectedDocumentRevision', 'after', 'body', 'type', 'options'],
  edit_cell: ['operationId', 'commandSequence', 'expectedDocumentRevision', 'cell', 'body', 'type', 'expectedRevision'],
  delete_cell: ['operationId', 'commandSequence', 'expectedDocumentRevision', 'cell', 'expectedRevision'],
  move_cell: ['operationId', 'commandSequence', 'expectedDocumentRevision', 'cell', 'after'],
  rename_cell: ['operationId', 'commandSequence', 'expectedDocumentRevision', 'cell', 'name', 'expectedRevision'],
  disable_cell: ['operationId', 'commandSequence', 'expectedDocumentRevision', 'cell', 'disabled', 'expectedRevision'],
  run_cell: ['operationId', 'commandSequence', 'expectedDocumentRevision', 'cell', 'changes', 'wait'],
  run_all: ['operationId', 'commandSequence', 'expectedDocumentRevision', 'changes', 'wait'],
  run_stale: ['operationId', 'commandSequence', 'expectedDocumentRevision', 'changes', 'wait'],
  interrupt: ['operationId', 'commandSequence', 'runId'],
  get_value: ['operationId', 'commandSequence', 'name', 'kernelEpoch'],
  set_widget: ['operationId', 'commandSequence', 'name', 'path', 'update', 'kernelEpoch', 'expectedRevision'],
  save: ['operationId', 'commandSequence', 'expectedDocumentRevision'],
  check: [],
  apply_transaction: ['operationId', 'commandSequence', 'changes', 'expectedDocumentRevision'],
  edit_cell_ranges: ['operationId', 'commandSequence', 'expectedDocumentRevision', 'cell', 'edits', 'expectedRevision'],
  select_r: ['operationId', 'commandSequence', 'rscript', 'persistDefault', 'expectedDocumentRevision'],
  set_runtime: ['operationId', 'commandSequence', 'on_cell_change', 'on_startup', 'expectedDocumentRevision'],
  reload_source: ['operationId', 'commandSequence', 'expectedDocumentRevision', 'expectedDiskDigest', 'expectedDiskVersion'],
  get_help: ['contents'],
  recovery_state: [],
  shutdown: ['operationId', 'commandSequence', 'expectedDocumentRevision', 'expectedClientIds', 'confirmed'],
  restart: ['operationId', 'commandSequence', 'replay', 'expectedDocumentRevision', 'wait'],
  format: ['operationId', 'commandSequence', 'cellIds', 'expectedRevisions', 'expectedDocumentRevision'],
  save_as: ['operationId', 'commandSequence', 'path', 'expectedDestination', 'expectedDocumentRevision'],
  read_output: ['handle', 'offset', 'limit'],
  table_page: ['operationId', 'commandSequence', 'handle', 'offset', 'limit', 'sortBy', 'sortDescending', 'filter', 'kernelEpoch'],
  materialize_output: ['operationId', 'commandSequence', 'key', 'kernelEpoch', 'wait'],
  operation_status: ['operation'],
  read_events: ['epoch', 'cursor'],
  get_config: [],
  set_config: ['operationId', 'commandSequence', 'patch', 'expectedSidecarVersion', 'expectedDocumentRevision'],
  get_layout: [],
  set_layout: ['operationId', 'commandSequence', 'layout', 'expectedSidecarVersion', 'expectedDocumentRevision'],
  set_app: ['operationId', 'commandSequence', 'patch', 'expectedDocumentRevision'],
  packages_status: [],
  packages_declare: ['operationId', 'commandSequence', 'packages', 'expectedSidecarVersion', 'expectedDocumentRevision'],
  packages_install: ['operationId', 'commandSequence', 'packages', 'expectedDocumentRevision', 'kernelEpoch', 'wait'],
  publish: ['operationId', 'commandSequence', 'includeCode', 'outputPath', 'expectedDocumentRevision', 'wait'],
  upload_file: ['operationId', 'commandSequence', 'name', 'path', 'files', 'kernelEpoch'],
};
const SOURCE = [
  '# %%',
  'library(alder)',
  '# %%',
  'x <- 2',
  '# %%',
  'x + 1',
  '# %%',
  'control <- ui$slider(1, 5, value = 3, label = "Catalog control")',
  'control',
  '# %%',
  'files <- ui$file(label = "Catalog files", multiple = TRUE)',
  'files',
  '# %%',
  'table_value <- data.frame(id = seq_len(40), parity = rep(c("odd", "even"), 20), value = seq_len(40) * 2)',
  'table_value',
  '# %%',
  'lazy_value <- out$lazy(function() "ALDER_MCP_LAZY", label = "Materialize catalog output")',
  'lazy_value',
  '# %%',
  'out$image(jsonlite::base64_dec("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="))',
  '# %%',
  'Sys.sleep(30)',
  '"ALDER_MCP_SLOW"',
  '# %%',
  'format_target<-function(value){value+1}',
  '',
].join('\n');

export async function run(ctx) {
  const harness = await createHarness(ctx, { id: 'mcp-catalog', source: SOURCE });
  let agent;

  try {
    agent = await openAgent(ctx, harness, 'mcp-catalog-agent');
    const listed = await agent.client.listTools();
    assert.deepEqual(listed.tools.map((tool) => tool.name), TOOL_NAMES);
    const schemas = Object.fromEntries(listed.tools.map((tool) => [tool.name, tool.inputSchema]));
    assertCatalogSchemas(schemas);

    const exercised = new Set();
    const operationIds = [];
    const outputHandles = new Set();
    const tracker = { epoch: null, documentRevision: null, cursor: null, nextCommandSequence: null, kernelEpoch: null };
    let operationCounter = 0;

    const call = async (name, arguments_ = {}) => {
      assert.ok(TOOL_NAMES.includes(name), `unknown catalog tool ${name}`);
      assertCatalogArguments(schemas[name], arguments_, name);
      const response = await agent.client.callTool({ name, arguments: arguments_ });
      const envelope = decodeTool(response);
      updateTracker(envelope, tracker);
      exercised.add(name);
      const admission = envelope.result?.admission;
      if (isRecord(admission) && Number.isSafeInteger(admission.nextCommandSequence)) {
        tracker.nextCommandSequence = admission.nextCommandSequence;
      }
      if (Number.isSafeInteger(envelope.result?.nextCommandSequence)) {
        tracker.nextCommandSequence = envelope.result.nextCommandSequence;
      }
      return envelope;
    };

    const nextOperationId = () => {
      operationCounter += 1;
      const operationId = `mcp-catalog-operation-${String(operationCounter).padStart(3, '0')}`;
      operationIds.push(operationId);
      return operationId;
    };

    const callEffect = async (name, arguments_ = {}) => {
      const schema = schemas[name];
      const properties = schema.properties ?? {};
      const prepared = { ...arguments_ };
      if (Object.hasOwn(properties, 'operationId')) prepared.operationId = nextOperationId();
      if (Object.hasOwn(properties, 'commandSequence')) {
        assert.ok(Number.isSafeInteger(tracker.nextCommandSequence), `MCP lease sequence unavailable for ${name}`);
        prepared.commandSequence = tracker.nextCommandSequence;
      }
      if (Object.hasOwn(properties, 'expectedDocumentRevision') && prepared.expectedDocumentRevision === undefined) {
        assert.ok(Number.isSafeInteger(tracker.documentRevision), `document revision unavailable for ${name}`);
        prepared.expectedDocumentRevision = tracker.documentRevision;
      }
      const envelope = await call(name, prepared);
      const admission = envelope.result?.admission;
      assert.ok(isRecord(admission), `${name} did not return an admission envelope`);
      assert.equal(admission.accepted, true, `${name} admission was rejected: ${JSON.stringify(admission)}`);
      assert.equal(admission.sequenceConsumed, true, `${name} did not consume its command sequence`);
      assert.equal(admission.operationId, prepared.operationId);
      assert.equal(admission.commandSequence, prepared.commandSequence);
      assert.equal(admission.nextCommandSequence, prepared.commandSequence + 1);
      assert.equal(envelope.operation?.id, prepared.operationId, `${name} operation identity mismatch`);
      return envelope;
    };

    const state = async () => {
      const envelope = await call('notebook_state');
      const result = envelope.result;
      assert.ok(isRecord(result), 'notebook_state did not return bounded state');
      assert.equal(result.protocol, 'alder-host-v2');
      assert.equal(result.epoch, tracker.epoch);
      assert.equal(result.documentRevision, tracker.documentRevision);
      tracker.kernelEpoch = result.runtime?.kernelEpoch ?? null;
      return result;
    };
    const cells = async () => {
      const envelope = await call('list_cells');
      assert.ok(Array.isArray(envelope.result), 'list_cells result is not a cell array');
      return envelope.result;
    };
    const cell = async (id) => {
      const envelope = await call('read_cell', { cell: id });
      assert.equal(envelope.result?.id, id);
      return envelope.result;
    };
    const sidecarVersion = (snapshot, name) => snapshot.sidecars?.[name]?.version ?? null;

    const initialStateEnvelope = await call('notebook_state');
    const initialState = initialStateEnvelope.result;
    assert.ok(isRecord(initialState), 'initial bounded notebook state missing');
    assert.equal(initialState.epoch, harness.registry.epoch);
    assert.equal(initialState.protocol, 'alder-host-v2');
    assert.ok(Number.isSafeInteger(initialState.nextCommandSequence));
    tracker.kernelEpoch = initialState.runtime?.kernelEpoch ?? null;
    const initialSourceBytes = await readFile(harness.notebook);
    assert.deepEqual(initialSourceBytes, Buffer.from(SOURCE), 'staged source bytes changed before MCP access');

    const resources = await agent.client.listResources();
    const resourceUris = resources.resources.map((resource) => resource.uri);
    for (const uri of RESOURCE_URIS) assert.ok(resourceUris.includes(uri), `missing MCP resource ${uri}`);
    const templates = await agent.client.listResourceTemplates();
    assert.deepEqual(templates.resourceTemplates.map((template) => template.uriTemplate), RESOURCE_TEMPLATES);

    const sourceResource = await readResource(agent, 'alder://notebook/source', tracker);
    assert.equal(sourceResource.entry.mimeType, 'text/plain');
    assert.equal(sourceResource.entry.text, SOURCE, 'source resource is not the exact notebook source');
    assert.deepEqual(Buffer.from(sourceResource.entry.text), initialSourceBytes);
    for (const uri of ['alder://notebook/dag', 'alder://notebook/state']) {
      const resource = await readResource(agent, uri, tracker);
      assert.equal(resource.entry.mimeType, 'application/json');
      assert.ok(isRecord(JSON.parse(resource.entry.text)), `${uri} is not JSON`);
    }

    const initialCells = await cells();
    assert.equal(initialCells.length, initialState.cells.length);
    assert.equal((await cell(initialCells[0].id)).id, initialCells[0].id);
    await waitForExecutionReady(harness);
    for (const query of [
      ['check', {}],
      ['get_help', { contents: '**MCP catalog help**' }],
      ['recovery_state', {}],
      ['read_events', { epoch: tracker.epoch, cursor: tracker.cursor }],
      ['get_config', {}],
      ['get_layout', {}],
      ['packages_status', {}],
    ]) {
      const envelope = await call(query[0], query[1]);
      if (query[0] === 'get_help') assert.ok(isRecord(envelope.result));
      if (query[0] === 'read_events') assert.ok(Array.isArray(envelope.result?.events));
    }

    const originalLastCell = initialCells.at(-1).id;
    const addEnvelope = await callEffect('add_cell', {
      after: null,
      body: ['added <- 1'],
      type: 'code',
      options: {},
    });
    assert.ok(isRecord(addEnvelope.result.value));
    let currentCells = await cells();
    const added = currentCells.find((candidate) => candidate.body.join('\n') === 'added <- 1');
    assert.ok(added, 'added cell was not listed');

    await callEffect('edit_cell', {
      cell: added.id,
      body: ['added <- 2'],
      type: added.type,
      expectedRevision: added.revision,
    });
    let addedCurrent = await cell(added.id);
    await callEffect('rename_cell', {
      cell: added.id,
      name: 'added_cell',
      expectedRevision: addedCurrent.revision,
    });
    addedCurrent = await cell(added.id);
    await callEffect('move_cell', { cell: added.id, after: originalLastCell });
    for (const disabled of [true, false]) {
      addedCurrent = await cell(added.id);
      await callEffect('disable_cell', {
        cell: added.id,
        disabled,
        expectedRevision: addedCurrent.revision,
      });
    }
    addedCurrent = await cell(added.id);
    await callEffect('edit_cell_ranges', {
      cell: added.id,
      edits: [{ start: { line: 0, character: 9 }, end: { line: 0, character: 10 }, text: '3' }],
      expectedRevision: addedCurrent.revision,
    });

    const transactionCreationId = 'transaction-created';
    const transaction = await callEffect('apply_transaction', {
      changes: [{
        type: 'create',
        creationId: transactionCreationId,
        after: { cellId: added.id },
        cellType: 'code',
        body: ['transaction_value <- 4'],
        options: {},
      }],
    });
    assert.ok(isRecord(transaction.result.value));
    currentCells = await cells();
    const transactionCell = currentCells.find((candidate) => candidate.id === transactionCreationId || candidate.body.join('\n') === 'transaction_value <- 4');
    assert.ok(transactionCell, 'transaction-created cell was not listed');

    const formatTarget = currentCells.find((candidate) => candidate.body.join('\n') === 'format_target<-function(value){value+1}');
    assert.ok(formatTarget, 'format target cell missing');
    await callEffect('format', {
      cellIds: [formatTarget.id],
      expectedRevisions: { [formatTarget.id]: formatTarget.revision },
    });

    const afterConfig = await state();
    await callEffect('set_runtime', { on_cell_change: 'lazy', on_startup: false });
    await callEffect('set_config', {
      patch: { editor: { live_diagnostics: false } },
      expectedSidecarVersion: sidecarVersion(afterConfig, 'config'),
    });
    const afterConfigWrite = await state();
    const allForLayout = afterConfigWrite.cells;
    await callEffect('set_layout', {
      layout: {
        version: 1,
        layout: 'grid',
        cells: Object.fromEntries(allForLayout.map((candidate, index) => [candidate.id, { x: 0, y: index, w: 12, h: 1 }])),
      },
      expectedSidecarVersion: sidecarVersion(afterConfigWrite, 'layout'),
    });
    await callEffect('set_app', { patch: { layout: 'grid', width: 'medium', include_code: true } });
    const afterPackages = await state();
    await callEffect('packages_declare', {
      packages: ['jsonlite'],
      expectedSidecarVersion: sidecarVersion(afterPackages, 'packages'),
    });
    const beforePackageInstall = await state();
    await callEffect('packages_install', {
      packages: ['jsonlite'],
      kernelEpoch: beforePackageInstall.runtime?.kernelEpoch ?? null,
      wait: true,
    });
    await state();
    await callEffect('select_r', { rscript: harness.selectedR, persistDefault: false });
    await state();
    await callEffect('restart', { replay: false, wait: true });
    const afterRestart = await state();
    assert.ok(typeof afterRestart.runtime?.kernelEpoch === 'string', 'restart did not expose a kernel epoch');

    const saved = await callEffect('save');
    assert.equal(saved.result.value?.ok ?? true, true);
    const beforeReload = await state();
    assert.equal(beforeReload.disk.state, 'present');
    assert.match(beforeReload.disk.digest, /^[0-9a-f]{64}$/);
    assert.equal(typeof beforeReload.disk.version, 'string');
    await callEffect('reload_source', {
      expectedDiskDigest: beforeReload.disk.digest,
      expectedDiskVersion: beforeReload.disk.version,
    });
    await state();

    const slowCell = (await cells()).find((candidate) => candidate.body.some((line) => line.includes('Sys.sleep(30)')));
    assert.ok(slowCell, 'slow interrupt cell missing');
    const slowRun = await callEffect('run_cell', { cell: slowCell.id, wait: false });
    const slowOperationId = slowRun.operation.id;
    let slowOperation;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const status = await call('operation_status', { operation: slowOperationId });
      slowOperation = status.result;
      if (['running', 'done', 'error', 'interrupted', 'cancelled'].includes(slowOperation?.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(slowOperation, 'run_cell operation status missing');
    await callEffect('interrupt', slowOperation.runId === undefined || slowOperation.runId === null ? {} : { runId: slowOperation.runId });
    const interruptedStatus = await waitForOperation(agent, slowOperationId, call, 120);
    assert.ok(
      ['interrupted', 'cancelled', 'done'].includes(interruptedStatus.status)
        || (interruptedStatus.status === 'error' && interruptedStatus.error?.code === 'interrupted'),
      `unexpected interrupt status ${interruptedStatus.status}:${interruptedStatus.error?.code ?? 'none'}:${interruptedStatus.error?.message ?? 'none'}`,
    );

    const slowCurrent = await cell(slowCell.id);
    await callEffect('edit_cell', {
      cell: slowCell.id,
      body: ['"ALDER_MCP_FAST"'],
      type: slowCurrent.type,
      expectedRevision: slowCurrent.revision,
    });
    await callEffect('run_stale', { wait: true });
    await callEffect('run_all', { wait: true });
    await state();

    const valueEnvelope = await callEffect('get_value', {
      name: 'x',
      kernelEpoch: tracker.kernelEpoch,
    });
    assert.ok(isRecord(valueEnvelope.result.value), 'get_value did not return a runtime result');

    currentCells = await cells();
    const controlCell = currentCells.find((candidate) => candidate.body.some((line) => line.includes('ui$slider')));
    assert.ok(controlCell, 'slider cell missing after execution');
    await callEffect('upload_file', {
      name: 'files',
      path: [],
      files: [{ name: 'catalog.txt', content_base64: Buffer.from('catalog upload\n').toString('base64') }],
      kernelEpoch: tracker.kernelEpoch,
    });
    await callEffect('set_widget', {
      name: 'control',
      path: [],
      update: { value: 5 },
      kernelEpoch: tracker.kernelEpoch,
      expectedRevision: controlCell.revision,
    });
    await callEffect('run_stale', { wait: true });

    const outputState = await state();
    const outputs = outputState.cells.flatMap((candidate) => candidate.outputs ?? []);
    assert.ok(outputs.length > 0, 'run_all produced no output records');
    const tableOutput = outputs.find((output) => output.data?.kind === 'table');
    const lazyOutput = outputs.find((output) => output.data?.kind === 'lazy');
    const imageOutput = outputs.find((output) => ((output.data?.kind === 'image')
      || (output.data?.kind === 'media' && output.data.media_type === 'image'))
      && isRecord(output.data.artifact));
    assert.ok(tableOutput?.data?.handle, 'table output handle missing');
    assert.ok(lazyOutput?.data?.key, 'lazy output key missing');
    assert.ok(imageOutput?.data?.artifact?.handle, 'image artifact handle missing');
    outputHandles.add(imageOutput.data.artifact.handle);

    const tableEnvelope = await callEffect('table_page', {
      handle: tableOutput.data.handle,
      offset: 0,
      limit: 5,
      sortBy: '',
      sortDescending: false,
      filter: '',
      kernelEpoch: tracker.kernelEpoch,
    });
    const tablePage = findObject(tableEnvelope.result.value, (value) => value.nrow !== undefined && Array.isArray(value.preview));
    assert.ok(tablePage, 'table_page returned no page');
    assert.equal(tablePage.offset, 0);
    assert.ok(tablePage.preview.length <= 5);

    const lazyEnvelope = await callEffect('materialize_output', {
      key: lazyOutput.data.key,
      kernelEpoch: tracker.kernelEpoch,
      wait: true,
    });
    assert.ok(findObject(lazyEnvelope.result.value, (value) => value.kind === 'text' && typeof value.text === 'string' && value.text.includes('ALDER_MCP_LAZY')), 'lazy output did not materialize');

    const artifactDescriptor = imageOutput.data.artifact;
    let artifactOffset = 0;
    let artifactBytes = Buffer.alloc(0);
    for (;;) {
      const pageEnvelope = await call('read_output', { handle: artifactDescriptor.handle, offset: artifactOffset, limit: 17 });
      const page = pageEnvelope.result;
      assert.equal(page.encoding, 'base64');
      assert.equal(page.offset, artifactOffset);
      const chunk = Buffer.from(page.data, 'base64');
      assert.equal(chunk.byteLength, page.nextOffset - page.offset);
      assert.ok(page.nextOffset <= artifactDescriptor.byteLength);
      artifactBytes = Buffer.concat([artifactBytes, chunk]);
      artifactOffset = page.nextOffset;
      if (page.eof) break;
    }
    assert.equal(artifactOffset, artifactDescriptor.byteLength);
    assert.equal(artifactBytes.byteLength, artifactDescriptor.byteLength);
    const eofEnvelope = await call('read_output', { handle: artifactDescriptor.handle, offset: artifactDescriptor.byteLength, limit: 1 });
    assert.equal(eofEnvelope.result.eof, true);
    assert.equal(eofEnvelope.result.data, '');

    currentCells = await cells();
    const outputResourceUris = [];
    for (const currentCell of currentCells) {
      const uri = `alder://cell/${encodeURIComponent(currentCell.id)}/outputs`;
      outputResourceUris.push(uri);
      const resource = await readResource(agent, uri, tracker);
      assert.ok(Array.isArray(JSON.parse(resource.entry.text)), `cell output resource ${uri} is not an array`);
    }
    const operationUri = `alder://operations/${encodeURIComponent(slowOperationId)}`;
    const operationResource = await readResource(agent, operationUri, tracker);
    assert.equal(JSON.parse(operationResource.entry.text).result?.id, slowOperationId);
    const outputUri = `alder://outputs/${encodeURIComponent(artifactDescriptor.handle)}`;
    const outputResource = await readResource(agent, outputUri, tracker);
    const outputPage = JSON.parse(outputResource.entry.text);
    assert.equal(outputPage.offset, 0);
    assert.equal(outputPage.encoding, 'base64');
    assert.equal(Buffer.from(outputPage.data, 'base64').byteLength, outputPage.nextOffset - outputPage.offset);

    const deleteTarget = await cell(transactionCell.id);
    await callEffect('delete_cell', { cell: deleteTarget.id, expectedRevision: deleteTarget.revision });
    const sourceBeforeSaveAs = await readResource(agent, 'alder://notebook/source', tracker);
    const saveAsPath = join(ctx.evidence, 'fixtures', 'mcp-catalog', 'saved-as.R');
    await callEffect('save_as', { path: saveAsPath, expectedDestination: 'absent' });
    assert.deepEqual(await readFile(saveAsPath), Buffer.from(sourceBeforeSaveAs.entry.text));
    await callEffect('run_all', { wait: true });
    await callEffect('publish', {
      includeCode: true,
      outputPath: join(ctx.evidence, 'fixtures', 'mcp-catalog', 'published.html'),
      wait: true,
    });

    const finalState = await state();
    const finalSource = await readResource(agent, 'alder://notebook/source', tracker);
    assert.equal(finalSource.entry.text, await readFile(saveAsPath, 'utf8'));
    const expectedClientIds = finalState.activeClientIds;
    assert.ok(Array.isArray(expectedClientIds) && expectedClientIds.length > 0, 'shutdown requires the active MCP client identities');
    const advertisedResources = [...RESOURCE_URIS, ...RESOURCE_TEMPLATES, ...outputResourceUris, operationUri, outputUri];
    await writeFile(join(ctx.evidence, 'mcp-catalog.json'), `${JSON.stringify({
      tools: [...exercised],
      resources: advertisedResources,
      operations: operationIds,
      outputHandles: [...outputHandles],
      epoch: tracker.epoch,
      documentRevision: tracker.documentRevision,
      pid: harness.registry.pid,
    }, null, 2)}\n`);
    await callEffect('shutdown', { expectedClientIds, confirmed: true });

    await closeAgent(agent);
    agent = undefined;

    assert.deepEqual([...exercised].sort(), [...TOOL_NAMES].sort(), 'catalog did not exercise every advertised tool');
    return {
      id: 'mcp-catalog',
      identity: {
        protocol: 'alder-host-v2',
        tools: TOOL_NAMES,
        resources: advertisedResources,
        epoch: harness.registry.epoch,
        pid: harness.registry.pid,
      },
    };
  } finally {
    await cleanupScenarioResources(() => agent && closeAgent(agent), () => harness.close());
  }
}

async function openAgent(ctx, harness, name) {
  const launcher = join(ctx.applicationRoot, ctx.manifest.resources.cliLauncher);
  const cwd = resolve(ctx.evidence, 'mcp-agents', name);
  const runtimeData = resolve(harness.dataHome);
  await mkdir(cwd, { recursive: true });
  const transport = new StdioClientTransport({
    command: launcher,
    args: ['mcp', harness.notebook],
    cwd,
    env: sanitizedEnvironment({
      HOME: cwd,
      XDG_CONFIG_HOME: join(cwd, 'config'),
      XDG_DATA_HOME: runtimeData,
    }),
    stderr: 'pipe',
    maxBufferSize: 16 * 1024 * 1024,
  });
  const client = new Client({ name, version: 'smoke' });
  await client.connect(transport);
  return { client, transport };
}

async function closeAgent(agent) {
  await cleanupScenarioResources(() => agent.client.close(), () => agent.transport.close());
}

function assertCatalogSchemas(schemas) {
  assert.equal(Object.keys(schemas).length, TOOL_NAMES.length);
  for (const name of TOOL_NAMES) {
    const schema = schemas[name];
    assert.ok(schema, `missing schema for ${name}`);
    assert.equal(schema.type, 'object');
    assert.equal(schema.additionalProperties, false, `${name} schema must be strict`);
    assert.deepEqual(Object.keys(schema.properties ?? {}).sort(), [...TOOL_ARGUMENT_KEYS[name]].sort(), `${name} schema changed`);
  }
  assert.equal(Object.hasOwn(schemas.publish.properties, 'includeCode'), true);
  assert.equal(Object.hasOwn(schemas.publish.properties, 'include_code'), false);
  assert.equal(Object.hasOwn(schemas.edit_cell.properties, 'expectedRevision'), true);
  assert.equal(Object.hasOwn(schemas.edit_cell.properties, 'expected_revision'), false);
  assert.equal(Object.hasOwn(schemas.table_page.properties, 'sortBy'), true);
  assert.equal(Object.hasOwn(schemas.table_page.properties, 'sort_by'), false);
  assert.equal(schemas.upload_file.properties.files.items.additionalProperties, false);
  assert.deepEqual(Object.keys(schemas.upload_file.properties.files.items.properties).sort(), ['content_base64', 'name']);
}

function assertCatalogArguments(schema, arguments_, name) {
  assert.ok(isRecord(arguments_), `${name} arguments must be an object`);
  const allowed = new Set(Object.keys(schema.properties ?? {}));
  for (const key of Object.keys(arguments_)) assert.ok(allowed.has(key), `${name} sent obsolete argument ${key}`);
  for (const required of schema.required ?? []) assert.ok(Object.hasOwn(arguments_, required), `${name} omitted required ${required}`);
}

function decodeTool(result) {
  assert.equal(result?.isError, false, `MCP tool failed: ${JSON.stringify(redact(result))}`);
  const summary = result?.content?.find((entry) => entry.type === 'text')?.text;
  assert.equal(typeof summary, 'string', `MCP tool returned no concise text summary: ${JSON.stringify(redact(result))}`);
  assert.ok(!/^\s*[\[{]/.test(summary), `MCP tool text must be a concise summary, not JSON: ${summary}`);
  const envelope = result?.structuredContent;
  assert.ok(isRecord(envelope), `MCP tool returned no structuredContent envelope: ${JSON.stringify(redact(result))}`);
  assert.equal(typeof envelope.epoch, 'string');
  assert.ok(Number.isSafeInteger(envelope.documentRevision) && envelope.documentRevision >= 0);
  assert.ok(Number.isSafeInteger(envelope.cursor) && envelope.cursor >= 0);
  for (const key of Object.keys(envelope)) assert.ok(['epoch', 'documentRevision', 'cursor', 'operation', 'result', 'error'].includes(key), `unknown envelope field ${key}`);
  return envelope;
}

function updateTracker(envelope, tracker) {
  tracker.epoch = envelope.epoch;
  tracker.documentRevision = envelope.documentRevision;
  tracker.cursor = envelope.cursor;
}

async function readResource(agent, uri, tracker) {
  const response = await agent.client.readResource({ uri });
  const entry = response.contents?.find((candidate) => candidate.uri === uri);
  assert.ok(entry, `resource ${uri} was not returned`);
  assert.equal(typeof entry.text, 'string', `resource ${uri} is not textual`);
  assert.deepEqual(Object.keys(entry._meta?.alder ?? {}).sort(), ['cursor', 'documentRevision', 'epoch']);
  assert.equal(entry._meta.alder.epoch, tracker.epoch);
  assert.equal(entry._meta.alder.documentRevision, tracker.documentRevision);
  assert.ok(Number.isSafeInteger(entry._meta.alder.cursor) && entry._meta.alder.cursor >= tracker.cursor, 'resource cursor regressed');
  tracker.cursor = entry._meta.alder.cursor;
  return { response, entry };
}

async function waitForOperation(agent, operationId, call, attempts) {
  let latest;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const status = await call('operation_status', { operation: operationId });
    latest = status.result;
    if (['done', 'error', 'interrupted', 'cancelled'].includes(latest?.status)) return latest;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return latest;
}

function findObject(value, predicate) {
  if (predicate(value)) return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findObject(item, predicate);
      if (found !== undefined) return found;
    }
  } else if (isRecord(value)) {
    for (const item of Object.values(value)) {
      const found = findObject(item, predicate);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

import {
  cleanSemanticEnvironment,
  compareSemanticOutcomes,
  formatSemanticFailure,
  generateSemanticPrograms,
  minimizeSemanticProgram,
  parseSemanticCaseCount,
  parseSemanticOutcomes,
  parseSemanticShrinkAttempts,
  parseSemanticSeeds,
  renderObservedNotebook,
  runBoundedCommand,
  runDifferentialPrograms,
  runPackagedPrograms,
  runRscriptPrograms,
  sameDifferenceSignature,
  selectReplayCase,
  temporarySemanticDirectory,
  removeSemanticDirectory,
  type SemanticOutcome,
  type SemanticProgram,
} from "./r-semantics.js";

function observed(overrides: Partial<SemanticOutcome> = {}): SemanticOutcome {
  return {
    caseIndex: 0, cellIndex: 0, status: "ok", value: "value-integer", state: "state",
    stdout: "stdout", visible: "visible", warnings: "warnings", error: "error",
    valuePreview: "42L", statePreview: "list(x = 42L)", warningsPreview: "list()", errorPreview: "NULL",
    ...overrides,
  };
}

test("semantic comparison detects value type, output, warning, error and state differences", () => {
  const baseline = observed();
  for (const [field, changed] of [
    ["value", observed({ value: "value-double", valuePreview: "42" })],
    ["stdout", observed({ stdout: "changed stdout" })],
    ["visible", observed({ visible: "changed visible" })],
    ["warnings", observed({ warnings: "changed warning", warningsPreview: "warning class changed" })],
    ["error", observed({ error: "changed error", errorPreview: "error class changed" })],
    ["state", observed({ state: "changed state", statePreview: "list(x = 43L)" })],
  ] as const) {
    assert.equal(compareSemanticOutcomes([baseline], [changed])?.field, field);
  }
  assert.equal(compareSemanticOutcomes([baseline], [baseline]), null);
  assert.equal(compareSemanticOutcomes([baseline], [])?.field, "missing");
});

test("seeded grammar replays exactly and covers the required semantic categories", () => {
  const first = generateSemanticPrograms(0xa1de2026);
  const replay = generateSemanticPrograms(0xa1de2026);
  const other = generateSemanticPrograms(0xa1de2027);
  assert.deepEqual(replay, first);
  assert.notDeepEqual(other, first);
  const categories = first.map(value => value.category);
  for (const expected of [
    "numeric scalar assignment", "logical comparison", "character vector indexing", "special numeric vector",
    "nested list indexing", "matrix attributes and subset", "data frame subset", "option parity and pure calls",
    "deterministic warning", "deterministic error", "stdout and visible value", "multi-cell dependency state", "case isolation",
  ]) assert.ok(categories.includes(expected), expected);
});

test("packaged notebooks keep generated source in ordinary cells and probes separate", () => {
  const program = generateSemanticPrograms(0xa1de2026)[11]!;
  const cells = renderObservedNotebook([program]).split("# %%\n").slice(1);
  assert.equal(cells.length, program.cells.length * 2);
  assert.equal(cells[0]!.trimEnd(), program.cells[0]!.source);
  assert.ok(!cells[0]!.includes("eval(parse"));
  assert.match(cells[1]!, /@@ALDER_R_PROBE@@/);
});

test("grammar-aware minimization removes cells and simplifies expressions within its attempt bound", async () => {
  const original: SemanticProgram = {
    id: "minimize", seed: 1, caseIndex: 0, category: "planted mismatch",
    cells: [
      { source: "noise <- 99L", simpler: ["1L"] },
      { source: "sentinel <- 42L; sentinel + 1L", simpler: ["sentinel <- 42L", "42L"] },
    ],
  };
  const minimized = await minimizeSemanticProgram(original,
    async candidate => candidate.cells.some(value => value.source.includes("42L")), 8);
  assert.deepEqual(minimized.program.cells.map(value => value.source), ["42L"]);
  assert.ok(minimized.attempts <= 8);
});

test("minimization rejects a reduction that changes the mismatch signature", async () => {
  const expected = compareSemanticOutcomes([observed()], [observed({ value: "different" })])!;
  const original: SemanticProgram = { id: "identity", seed: 1, caseIndex: 0, category: "identity", cells: [{ source: "42L", probe: "42L", simpler: ["cat('different')"] }] };
  const minimized = await minimizeSemanticProgram(original, async candidate => {
    const changed = compareSemanticOutcomes([observed()], [observed({ stdout: candidate.cells[0]!.source })]);
    return sameDifferenceSignature(expected, changed);
  }, 4);
  assert.equal(minimized.program.cells[0]!.source, "42L");
});

test("observation parsing rejects reordered markers before comparison", () => {
  const programs: SemanticProgram[] = [{ id: "order", seed: 1, caseIndex: 0, category: "order", cells: [{ source: "1L" }, { source: "2L" }] }];
  const marker = (cellIndex: number) => `@@ALDER_R_SEMANTICS@@0|${cellIndex}|ok||||||||||`;
  assert.throws(() => parseSemanticOutcomes(`${marker(1)}\n${marker(0)}\n`, programs), /unexpected observation 0:1; expected 0:0/);
});

test("seed parsing caps count and values", () => {
  assert.deepEqual(parseSemanticSeeds("0,0xffffffff"), [0, 0xffff_ffff]);
  assert.throws(() => parseSemanticSeeds(Array.from({ length: 17 }, (_, index) => String(index)).join(",")), /1 to 16/);
  assert.throws(() => parseSemanticSeeds("0x100000000"), /uint32/);
  assert.throws(() => parseSemanticSeeds("1,,2"), /uint32/);
});

test("bounded execution reports timeout, crash and output overflow and leaves no child", async () => {
  const directory = await temporarySemanticDirectory();
  const environment = cleanSemanticEnvironment();
  try {
    const timeout = await runBoundedCommand({
      executable: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"], cwd: directory, environment,
      timeoutMs: 50, maxOutputBytes: 1_024,
    });
    assert.equal(timeout.timedOut, true);
    assert.notEqual(timeout.signal, null);
    assert.throws(() => process.kill(timeout.pid, 0));

    const crash = await runBoundedCommand({
      executable: process.execPath, args: ["-e", "process.kill(process.pid, 'SIGKILL')"], cwd: directory, environment,
      timeoutMs: 1_000, maxOutputBytes: 1_024,
    });
    assert.equal(crash.timedOut, false);
    assert.equal(crash.signal, "SIGKILL");

    const overflow = await runBoundedCommand({
      executable: process.execPath, args: ["-e", "process.stdout.write('x'.repeat(8192))"], cwd: directory, environment,
      timeoutMs: 1_000, maxOutputBytes: 128,
    });
    assert.equal(overflow.outputExceeded, true);
    assert.throws(() => process.kill(overflow.pid, 0));
  } finally { await removeSemanticDirectory(directory); }
});

test("Rscript observation isolates cases while retaining multi-cell state, warnings and errors", { timeout: 30_000 }, async () => {
  const directory = await temporarySemanticDirectory();
  const rscript = execFileSync("which", ["Rscript"], { encoding: "utf8", env: cleanSemanticEnvironment() }).trim();
  const programs = generateSemanticPrograms(0xa1de2026);
  const environment = { ...cleanSemanticEnvironment(), HOME: directory };
  try {
    const outcomes = await runRscriptPrograms(programs, { rscript, cwd: directory, environment });
    const at = (caseIndex: number, cellIndex = 0) => outcomes.find(value => value.caseIndex === caseIndex && value.cellIndex === cellIndex)!;
    assert.match(at(8).warningsPreview, /generated warning/);
    assert.equal(at(8).status, "ok");
    assert.match(at(9).errorPreview, /generated error/);
    assert.equal(at(9).status, "error");
    assert.match(at(10).stdout, /first\n\[1\] "second"/);
    assert.match(at(11, 2).statePreview, /base_value/);
    assert.equal(at(13).valuePreview, "FALSE");
  } finally { await removeSemanticDirectory(directory); }
});

test("Rscript observation rejects per-case timeout and captured output overflow", { timeout: 30_000 }, async () => {
  const directory = await temporarySemanticDirectory();
  const rscript = execFileSync("which", ["Rscript"], { encoding: "utf8", env: cleanSemanticEnvironment() }).trim();
  const environment = { ...cleanSemanticEnvironment(), HOME: directory };
  const semanticProgram = (source: string): SemanticProgram => ({
    id: "bounded", seed: 1, caseIndex: 0, category: "bounds", cells: [{ source }],
  });
  try {
    await assert.rejects(runRscriptPrograms([semanticProgram("repeat { sqrt(2) }")], { rscript, cwd: directory, environment }), /case 0:0 timeout/);
    await assert.rejects(runRscriptPrograms([semanticProgram("cat(strrep('x', 70000L)); 1L")], { rscript, cwd: directory, environment }), /case 0:0 overflow/);
  } finally { await removeSemanticDirectory(directory); }
});

const applicationRoot = process.env.ALDER_APPLICATION_ROOT ?? process.env.ALDER_STAGED_ROOT;
test("seeded ordinary R semantics match Rscript through the packaged Alder and Ark path", {
  skip: applicationRoot === undefined, timeout: 10 * 60_000,
}, async context => {
  const directory = await temporarySemanticDirectory();
  const started = performance.now();
  const rscript = await realpath(process.env.ALDER_RSCRIPT ?? execFileSync("which", ["Rscript"], { encoding: "utf8" }).trim());
  const seeds = parseSemanticSeeds(process.env.ALDER_R_SEMANTICS_SEED);
  const caseCount = parseSemanticCaseCount(process.env.ALDER_R_SEMANTICS_CASES);
  const shrinkAttempts = parseSemanticShrinkAttempts(process.env.ALDER_R_SEMANTICS_SHRINK_ATTEMPTS);
  const generated = seeds.flatMap(seed => generateSemanticPrograms(seed, caseCount));
  const programs = selectReplayCase(generated, process.env.ALDER_R_SEMANTICS_CASE);
  const environment = {
    ...cleanSemanticEnvironment(), HOME: directory,
    XDG_CONFIG_HOME: join(directory, "config"), XDG_DATA_HOME: join(directory, "data"),
    XDG_CACHE_HOME: join(directory, "cache"), XDG_STATE_HOME: join(directory, "state"),
    PATH: `${dirname(rscript)}:${process.env.PATH ?? ""}`,
  };
  try {
    const result = await runDifferentialPrograms(programs, {
      applicationRoot: resolve(applicationRoot!), rscript, cwd: directory, environment,
    });
    await waitForNoOwnedProcesses(directory);
    if (result.difference) {
      const failing = programs[result.difference.caseIndex]!;
      const minimized = await minimizeSemanticProgram(failing, async candidate => {
        const attemptDirectory = await temporarySemanticDirectory();
        try {
          const attempt = await runDifferentialPrograms([candidate], {
            applicationRoot: resolve(applicationRoot!), rscript, cwd: attemptDirectory,
            environment: { ...environment, HOME: attemptDirectory }, timeoutMs: 45_000,
          });
          return sameDifferenceSignature(result.difference!, attempt.difference);
        } finally { await removeSemanticDirectory(attemptDirectory); }
      }, shrinkAttempts);
      assert.fail(formatSemanticFailure(failing, result.difference, minimized.program));
    }
    const actual = result.actual;
    const warning = actual.find(value => value.warningsPreview.includes("generated warning"));
    const error = actual.find(value => value.errorPreview.includes("generated error"));
    const multiCell = programs.findIndex(value => value.category === "multi-cell dependency state");
    const isolation = programs.findIndex(value => value.category === "case isolation");
    if (programs.some(value => value.category === "deterministic warning")) assert.ok(warning, "packaged corpus must retain its warning condition");
    if (programs.some(value => value.category === "deterministic error")) assert.equal(error?.status, "error");
    const direct = programs.findIndex(value => value.category === "stdout and visible value");
    if (direct >= 0) {
      assert.match(actual.find(value => value.caseIndex === direct)?.stdout ?? "", /first\n\[1\] "second"/);
      assert.match(actual.find(value => value.caseIndex === direct)?.visible ?? "", /42/);
    }
    const optionParity = programs.findIndex(value => value.category === "option parity and pure calls");
    if (optionParity >= 0) assert.match(actual.find(value => value.caseIndex === optionParity)?.visible ?? "", /6\.14159/);
    if (multiCell >= 0) assert.ok(actual.some(value => value.caseIndex === multiCell && value.cellIndex === 2 && value.statePreview.includes("derived")));
    if (isolation >= 0) assert.equal(actual.find(value => value.caseIndex === isolation)?.valuePreview, "FALSE");
    context.diagnostic(JSON.stringify({
      seeds: seeds.map(value => `0x${value.toString(16).padStart(8, "0")}`), cases: programs.length,
      cells: programs.reduce((sum, value) => sum + value.cells.length, 0),
      categories: [...new Set(programs.map(value => value.category))], durationMs: Math.round(performance.now() - started), ownedChildren: 0,
    }));
  } finally { await removeSemanticDirectory(directory); }
});

test("packaged extraction failure shuts down every owned process", {
  skip: applicationRoot === undefined, timeout: 2 * 60_000,
}, async () => {
  const directory = await temporarySemanticDirectory();
  const rscript = await realpath(process.env.ALDER_RSCRIPT ?? execFileSync("which", ["Rscript"], { encoding: "utf8" }).trim());
  const program: SemanticProgram = {
    id: "extraction-overflow", seed: 1, caseIndex: 0, category: "extraction overflow",
    cells: [{ source: "cat(strrep('x', 70000L)); 1L", probe: "1L" }],
  };
  try {
    await assert.rejects(runPackagedPrograms([program], {
      applicationRoot: resolve(applicationRoot!), rscript, cwd: directory,
      environment: { ...cleanSemanticEnvironment(), HOME: directory, PATH: `${dirname(rscript)}:${process.env.PATH ?? ""}` },
    }), /overflow/);
    await waitForNoOwnedProcesses(directory);
  } finally { await removeSemanticDirectory(directory); }
});

async function waitForNoOwnedProcesses(marker: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const rows = execFileSync("/bin/ps", ["-axo", "pid=,command="], { encoding: "utf8" })
      .split("\n").filter(line => line.includes(marker));
    if (rows.length === 0) return;
    if (Date.now() >= deadline) assert.fail(`packaged semantic execution left owned children:\n${rows.join("\n")}`);
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
  }
}

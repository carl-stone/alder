import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { SeededRandom, seedLabel } from "./seeded.js";

export const DEFAULT_R_SEMANTIC_SEEDS = [0xa1de2026, 0x5eed1234] as const;
export const DEFAULT_R_SEMANTIC_CASES = 14;
export const R_SEMANTIC_CASE_TIMEOUT_MS = 20_000;
export const R_SEMANTIC_CELL_TIMEOUT_MS = 2_000;
export const R_SEMANTIC_OUTPUT_BYTES = 4 * 1024 * 1024;
export const R_SEMANTIC_CASE_OUTPUT_BYTES = 64 * 1024;
const MAX_CELL_SOURCE_BYTES = 4_096;
const MAX_CELLS_PER_PROGRAM = 4;
const MAX_SEEDS = 16;
const MARKER = "@@ALDER_R_SEMANTICS@@";
const PROBE_MARKER = "@@ALDER_R_PROBE@@";

export interface SemanticCell {
  source: string;
  probe?: string;
  simpler?: readonly string[];
}

export interface SemanticProgram {
  id: string;
  seed: number;
  caseIndex: number;
  category: string;
  stateNames?: readonly string[];
  cells: readonly SemanticCell[];
}

export interface SemanticOutcome {
  caseIndex: number;
  cellIndex: number;
  status: "ok" | "error" | "timeout" | "overflow";
  value: string;
  state: string;
  stdout: string;
  visible: string;
  warnings: string;
  error: string;
  valuePreview: string;
  statePreview: string;
  warningsPreview: string;
  errorPreview: string;
}

export interface SemanticDifference {
  caseIndex: number;
  cellIndex: number;
  field: keyof Omit<SemanticOutcome, "caseIndex" | "cellIndex"> | "missing";
  reference: SemanticOutcome | null;
  actual: SemanticOutcome | null;
}

export interface BoundedCommandResult {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  outputExceeded: boolean;
  pid: number;
}

export interface PackagedRunOptions {
  applicationRoot: string;
  rscript: string;
  cwd: string;
  environment: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export function generateSemanticPrograms(seed: number, requestedCases = DEFAULT_R_SEMANTIC_CASES): SemanticProgram[] {
  if (!Number.isSafeInteger(requestedCases) || requestedCases < 1 || requestedCases > 256) {
    throw new RangeError("R semantic case count must be between 1 and 256");
  }
  const random = new SeededRandom(seed);
  const left = 2 + random.integer(8);
  const right = 2 + random.integer(8);
  const word = random.pick(["café", "lambda-λ", "genome-🧬", "quoted-\"value\""]);
  const programs: SemanticProgram[] = [
    program(seed, 0, "numeric scalar assignment", [
      cell(`x <- ${left}L; x <- x + ${right}L; x / 2`, ["1L", "x <- 1L; x"], "x / 2"),
    ], ["x"]),
    program(seed, 1, "logical comparison", [
      cell(`values <- c(${left}L, ${right}L, NA_integer_); (values > 3L) & c(TRUE, FALSE, TRUE)`, ["TRUE", "c(TRUE, FALSE)"], "(values > 3L) & c(TRUE, FALSE, TRUE)"),
    ], ["values"]),
    program(seed, 2, "character vector indexing", [
      cell(`labels <- c(${rString(word)}, "beta", NA_character_); labels[c(3L, 1L)]`, [rString(word), "c(\"a\", \"b\")[[1L]]"], "labels[c(3L, 1L)]"),
    ], ["labels"]),
    program(seed, 3, "special numeric vector", [
      cell("c(NA_real_, NaN, Inf, -Inf, -0, 1.25)", ["NA_real_", "c(Inf, -Inf)"], "c(NA_real_, NaN, Inf, -Inf, -0, 1.25)"),
    ]),
    program(seed, 4, "nested list indexing", [
      cell("items <- list(integer=1L, logical=c(TRUE, NA), nested=list(text='ok', value=2.5)); items$nested[[2L]]", ["list(1L)", "list(a=1L)$a"], "items$nested[[2L]]"),
    ], ["items"]),
    program(seed, 5, "matrix attributes and subset", [
      cell("m <- matrix(1:6, nrow=2L, dimnames=list(c('r1','r2'), c('a','b','c'))); m[2L, 'c']", ["m <- matrix(1:4, 2L); m[1L,1L]", "1L"], "m[2L, 'c']"),
    ], ["m"]),
    program(seed, 6, "data frame subset", [
      cell("d <- data.frame(id=1:4, label=c('a','b','c','d'), keep=c(TRUE,FALSE,TRUE,FALSE), stringsAsFactors=FALSE); d$label[d$keep]", ["d <- data.frame(id=1L); d$id", "1L"], "d$label[d$keep]"),
    ], ["d"]),
    program(seed, 7, "option parity and pure calls", [
      cell("sum(c(1L, 2L)) + pi", ["pi", "identity(1L)"], "sum(c(1L, 2L)) + pi"),
    ]),
    program(seed, 8, "deterministic warning", [
      cell("warning('generated warning', call.=FALSE); 7L", ["warning('w', call.=FALSE); 1L", "1L"], "7L"),
    ]),
    program(seed, 9, "deterministic error", [
      cell("partial <- 3L; stop('generated error', call.=FALSE)", ["stop('e', call.=FALSE)", "1L"], "NULL"),
    ], ["partial"]),
    program(seed, 10, "stdout and visible value", [
      cell("cat('first\\n'); print('second'); structure(42L, unit='answer')", ["cat('x\\n'); 1L", "1L"], "structure(42L, unit='answer')"),
    ]),
    program(seed, 11, "multi-cell dependency state", [
      cell(`base_value <- ${left}L; base_value <- base_value + 1L; base_value`, ["base_value <- 1L"], "base_value"),
      cell(`derived <- base_value * ${right}L; derived`, ["derived <- base_value; derived"], "derived"),
      cell("c(base_value=base_value, derived=derived)", ["base_value", "derived"], "c(base_value=base_value, derived=derived)"),
    ], ["base_value", "derived"]),
    program(seed, 12, "case-local definition", [
      cell("case_local <- 99L; case_local", ["case_local <- 1L", "1L"], "case_local"),
    ], ["case_local"]),
    program(seed, 13, "case isolation", [
      cell("exists('case_local', inherits=FALSE)", ["FALSE"], "exists('case_local', inherits=FALSE)"),
    ]),
  ];
  const extraTemplates = [
    () => {
      const sequenceValue = 1 + random.integer(5), repeats = 1 + random.integer(4);
      return cell(`seq_value <- ${sequenceValue}L; rep(seq_value, ${repeats}L)`, ["1L"], `rep(seq_value, ${repeats}L)`);
    },
    () => cell(`c(${random.integer(20)}L, ${random.integer(20)}L)[c(TRUE, FALSE)]`, ["c(1L, 2L)[1L]"]),
    () => cell(`paste(c(${rString(word)}, "tail"), collapse="|")`, ["paste('a')"]),
    () => cell(`round(mean(c(${1 + random.integer(10)}, ${1 + random.integer(10)}, NA_real_), na.rm=TRUE), 3L)`, ["mean(c(1, 2))"]),
  ];
  while (programs.length < requestedCases) {
    const index = programs.length;
    const generated = random.pick(extraTemplates)();
    programs.push(program(seed, index, "seeded extra", [generated], generated.source.includes("seq_value") ? ["seq_value"] : []));
  }
  return programs.slice(0, requestedCases).map(validateProgram);
}

function program(seed: number, caseIndex: number, category: string, cells: readonly SemanticCell[], stateNames: readonly string[] = []): SemanticProgram {
  return { id: `${seedLabel(seed)}:${caseIndex}:${category}`, seed: seed >>> 0, caseIndex, category, stateNames, cells };
}

function cell(source: string, simpler: readonly string[] = [], probe = source): SemanticCell { return { source, probe, simpler }; }

function validateProgram(value: SemanticProgram): SemanticProgram {
  if (value.cells.length < 1 || value.cells.length > MAX_CELLS_PER_PROGRAM) throw new Error(`invalid generated cell count for ${value.id}`);
  for (const item of value.cells) {
    if (Buffer.byteLength(item.source) > MAX_CELL_SOURCE_BYTES) throw new Error(`generated source exceeds ${MAX_CELL_SOURCE_BYTES} bytes for ${value.id}`);
  }
  return value;
}

export function compareSemanticOutcomes(reference: readonly SemanticOutcome[], actual: readonly SemanticOutcome[]): SemanticDifference | null {
  const count = Math.max(reference.length, actual.length);
  for (let index = 0; index < count; index++) {
    const expected = reference[index] ?? null;
    const observed = actual[index] ?? null;
    if (!expected || !observed) return { caseIndex: expected?.caseIndex ?? observed?.caseIndex ?? -1, cellIndex: expected?.cellIndex ?? observed?.cellIndex ?? -1, field: "missing", reference: expected, actual: observed };
    for (const field of ["status", "value", "state", "stdout", "visible", "warnings", "error"] as const) {
      if (expected[field] !== observed[field]) return { caseIndex: expected.caseIndex, cellIndex: expected.cellIndex, field, reference: expected, actual: observed };
    }
  }
  return null;
}

export function sameDifferenceSignature(expected: SemanticDifference, actual: SemanticDifference | null): boolean {
  return actual !== null && actual.cellIndex === expected.cellIndex && actual.field === expected.field
    && actual.reference?.status === expected.reference?.status && actual.actual?.status === expected.actual?.status;
}

export async function minimizeSemanticProgram(
  original: SemanticProgram,
  stillFails: (candidate: SemanticProgram) => Promise<boolean>,
  maxAttempts = 24,
): Promise<{ program: SemanticProgram; attempts: number }> {
  let current = original;
  let attempts = 0;
  for (;;) {
    let reduced = false;
    for (const candidate of shrinkSemanticProgram(current)) {
      if (attempts >= maxAttempts) return { program: current, attempts };
      attempts++;
      if (await stillFails(candidate)) { current = candidate; reduced = true; break; }
    }
    if (!reduced) return { program: current, attempts };
  }
}

export function shrinkSemanticProgram(value: SemanticProgram): SemanticProgram[] {
  const candidates: SemanticProgram[] = [];
  if (value.cells.length > 1) {
    for (let index = 0; index < value.cells.length; index++) {
      candidates.push(validateProgram({ ...value, cells: value.cells.filter((_, cellIndex) => cellIndex !== index) }));
    }
  }
  for (let index = 0; index < value.cells.length; index++) {
    for (const [alternativeIndex, source] of (value.cells[index]!.simpler ?? []).entries()) {
      const remaining = value.cells[index]!.simpler?.slice(alternativeIndex + 1) ?? [];
      const cells = value.cells.map((item, cellIndex) => cellIndex === index ? { source, probe: probeForSimplifiedSource(source), simpler: remaining } : item);
      candidates.push(validateProgram({ ...value, cells }));
    }
  }
  return uniquePrograms(candidates);
}

function probeForSimplifiedSource(source: string): string {
  if (/\bstop\s*\(/.test(source)) return "NULL";
  const last = source.split(";").at(-1)!.trim();
  const assignment = /^([A-Za-z.][A-Za-z0-9._]*)\s*<-/.exec(last);
  return assignment?.[1] ?? last;
}

function uniquePrograms(values: readonly SemanticProgram[]): SemanticProgram[] {
  const seen = new Set<string>();
  return values.filter(value => {
    const key = value.cells.map(cellValue => cellValue.source).join("\0");
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
}

export function renderObservedScript(programs: readonly SemanticProgram[]): string {
  const lines: string[] = [];
  for (const [caseIndex, generated] of programs.entries()) {
    lines.push("rm(list=ls(envir=.GlobalEnv, all.names=TRUE), envir=.GlobalEnv)");
    for (const [cellIndex, semanticCell] of generated.cells.entries()) {
      lines.push(renderObservedCell(caseIndex, cellIndex, semanticCell.source, generated.stateNames ?? []));
    }
  }
  return lines.join("\n") + "\n";
}

export function renderObservedNotebook(programs: readonly SemanticProgram[]): string {
  return programs.flatMap((generated, caseIndex) => generated.cells.map((semanticCell, cellIndex) =>
    `# %%\n${semanticCell.source}\n# %%\n${renderProbeCell(caseIndex, cellIndex, semanticCell.probe ?? semanticCell.source, generated.stateNames ?? [])}\n`)).join("");
}

function renderObservedCell(caseIndex: number, cellIndex: number, source: string, stateNames: readonly string[]): string {
  return `local({
  .warnings <- character(); .error <- NULL; .timed_out <- FALSE; .evaluated <- NULL
  .stdout <- capture.output({
    .evaluated <- withCallingHandlers(
      tryCatch({
        setTimeLimit(elapsed=${R_SEMANTIC_CELL_TIMEOUT_MS / 1_000}, transient=TRUE)
        withVisible(eval(parse(text=${rString(source)}, keep.source=FALSE), envir=.GlobalEnv))
      }, error=function(e) {
        .timed_out <<- inherits(e, "elapsedTimeLimit") || grepl("elapsed time limit", conditionMessage(e), fixed=TRUE)
        .error <<- e
        list(value=NULL, visible=FALSE)
      }, finally=setTimeLimit(cpu=Inf, elapsed=Inf, transient=FALSE)),
      warning=function(w) {
        .warnings <<- c(.warnings, paste0("Warning: ", conditionMessage(w)))
        invokeRestart("muffleWarning")
      })
  }, type="output")
  .value <- if (is.null(.error)) .evaluated$value else NULL
  .visible <- if (is.null(.error) && isTRUE(.evaluated$visible)) capture.output(print(.value), type="output") else character()
  .overflow <- nchar(enc2utf8(paste(c(.stdout, .visible, .warnings), collapse="\\n")), type="bytes") > ${R_SEMANTIC_CASE_OUTPUT_BYTES}
  .state_names <- ${rStringArray(stateNames)}
  .state_names <- .state_names[.state_names %in% ls(.GlobalEnv, all.names=TRUE)]
  .state <- if (length(.state_names)) setNames(mget(.state_names, envir=.GlobalEnv, inherits=FALSE), .state_names) else list()
  .raw_hex <- function(x) paste(sprintf("%02x", as.integer(serialize(x, NULL, version=2))), collapse="")
  .text_hex <- function(x) paste(sprintf("%02x", as.integer(charToRaw(enc2utf8(paste(x, collapse="\\n"))))), collapse="")
  .condition <- if (is.null(.error)) "" else paste(paste(class(.error), collapse="\\n"), conditionMessage(.error), if (is.null(conditionCall(.error))) "" else paste(deparse(conditionCall(.error), width.cutoff=500L), collapse="\\n"), sep="\\x1e")
  .preview <- function(x) paste(capture.output(dput(x, control=c("keepNA","keepInteger","niceNames","showAttributes"))), collapse="\\n")
  cat(${rString(MARKER)}, ${caseIndex}, "|", ${cellIndex}, "|", if (.overflow) "overflow" else if (.timed_out) "timeout" else if (is.null(.error)) "ok" else "error", "|",
      .raw_hex(.value), "|", .raw_hex(.state), "|", .text_hex(.stdout), "|", .text_hex(.visible), "|",
      .text_hex(.warnings), "|", .text_hex(.condition), "|", .text_hex(.preview(.value)), "|", .text_hex(.preview(.state)), "|",
      .text_hex(.warnings), "|", .text_hex(.condition), "\\n", sep="")
})`;
}

function renderProbeCell(caseIndex: number, cellIndex: number, probe: string, stateNames: readonly string[]): string {
  return `(function() {
  .names <- ${rStringArray(stateNames)}
  .names <- .names[.names %in% ls(.GlobalEnv, all.names=TRUE)]
  .state <- if (length(.names)) setNames(mget(.names, envir=.GlobalEnv, inherits=FALSE), .names) else list()
  .raw_hex <- function(x) paste(sprintf("%02x", as.integer(serialize(x, NULL, version=2))), collapse="")
  .text_hex <- function(x) paste(sprintf("%02x", as.integer(charToRaw(enc2utf8(x)))), collapse="")
  .preview <- function(x) paste(capture.output(dput(x, control=c("keepNA","keepInteger","niceNames","showAttributes"))), collapse="\\n")
  .value <- (${probe})
  cat(${rString(PROBE_MARKER)}, ${caseIndex}, "|", ${cellIndex}, "|", .raw_hex(.value), "|", .raw_hex(.state), "|", .text_hex(.preview(.value)), "|", .text_hex(.preview(.state)), "\\n", sep="")
})()`;
}

function rStringArray(values: readonly string[]): string { return values.length === 0 ? "character()" : `c(${values.map(rString).join(",")})`; }

function rString(value: string): string {
  return JSON.stringify(value).replace(/\\u2028/g, "\\u2028").replace(/\\u2029/g, "\\u2029");
}

export function parseSemanticOutcomes(text: string, programs: readonly SemanticProgram[]): SemanticOutcome[] {
  const outcomes: SemanticOutcome[] = [];
  const pattern = new RegExp(`${MARKER}([^\\r\\n]+)`, "g");
  for (const match of text.matchAll(pattern)) {
    const fields = match[1]!.split("|");
    if (fields.length !== 13) throw new Error(`invalid R semantic observation field count: ${fields.length}`);
    const [caseText, cellText, status, value, state, stdout, visible, warnings, error, valuePreview, statePreview, warningsPreview, errorPreview] = fields;
    if (!(["ok", "error", "timeout", "overflow"] as const).includes(status as SemanticOutcome["status"])) throw new Error(`invalid R semantic status: ${status}`);
    outcomes.push({
      caseIndex: Number(caseText), cellIndex: Number(cellText), status: status as SemanticOutcome["status"],
      value: requireHex(value!), state: requireHex(state!), stdout: decodeHex(stdout!), visible: decodeHex(visible!),
      warnings: decodeHex(warnings!), error: decodeHex(error!), valuePreview: decodeHex(valuePreview!), statePreview: decodeHex(statePreview!),
      warningsPreview: decodeHex(warningsPreview!), errorPreview: decodeHex(errorPreview!),
    });
  }
  const expected = programs.reduce((sum, value) => sum + value.cells.length, 0);
  if (outcomes.length !== expected) throw new Error(`R semantic execution returned ${outcomes.length} of ${expected} observations`);
  const expectedCoordinates = programs.flatMap((programValue, caseIndex) =>
    programValue.cells.map((_, cellIndex) => `${caseIndex}:${cellIndex}`));
  for (const [index, outcome] of outcomes.entries()) {
    const coordinate = `${outcome.caseIndex}:${outcome.cellIndex}`;
    if (coordinate !== expectedCoordinates[index]) {
      throw new Error(`R semantic execution returned unexpected observation ${coordinate}; expected ${expectedCoordinates[index]}`);
    }
  }
  return outcomes;
}

function requireHex(value: string): string {
  if (value.length % 2 !== 0 || /[^0-9a-f]/.test(value)) throw new Error("invalid hexadecimal R semantic observation");
  return value;
}

function decodeHex(value: string): string { return Buffer.from(requireHex(value), "hex").toString("utf8"); }

export async function runBoundedCommand(options: {
  executable: string; args?: readonly string[]; cwd: string; environment: NodeJS.ProcessEnv;
  timeoutMs: number; maxOutputBytes: number;
}): Promise<BoundedCommandResult> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(options.executable, [...(options.args ?? [])], {
      cwd: options.cwd, env: options.environment, stdio: ["ignore", "pipe", "pipe"],
    });
    if (!child.pid) { reject(new Error(`failed to start ${options.executable}`)); return; }
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    let outputBytes = 0, timedOut = false, outputExceeded = false, settled = false;
    const stop = () => { if (!child.killed) child.kill("SIGKILL"); };
    const timer = setTimeout(() => { timedOut = true; stop(); }, options.timeoutMs);
    const capture = (target: Buffer[]) => (chunk: Buffer) => {
      const bytes = Buffer.from(chunk); outputBytes += bytes.length;
      if (outputBytes > options.maxOutputBytes) { outputExceeded = true; stop(); return; }
      target.push(bytes);
    };
    child.stdout.on("data", capture(stdout));
    child.stderr.on("data", capture(stderr));
    child.once("error", error => { clearTimeout(timer); if (!settled) { settled = true; reject(error); } });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      resolveResult({ stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8"), code, signal, timedOut, outputExceeded, pid: child.pid! });
    });
  });
}

export async function runRscriptPrograms(programs: readonly SemanticProgram[], options: {
  rscript: string; cwd: string; environment: NodeJS.ProcessEnv; timeoutMs?: number;
}): Promise<SemanticOutcome[]> {
  const script = join(options.cwd, `r-semantics-${randomUUID()}.R`);
  await writeFile(script, renderObservedScript(programs));
  const result = await runBoundedCommand({
    executable: options.rscript, args: ["--vanilla", script], cwd: options.cwd, environment: options.environment,
    timeoutMs: options.timeoutMs ?? Math.max(30_000, programs.length * R_SEMANTIC_CELL_TIMEOUT_MS), maxOutputBytes: R_SEMANTIC_OUTPUT_BYTES,
  });
  if (result.timedOut || result.outputExceeded || result.code !== 0 || result.signal !== null) {
    throw new Error(`Rscript semantic execution failed: ${JSON.stringify({ code: result.code, signal: result.signal, timedOut: result.timedOut, outputExceeded: result.outputExceeded, stderr: result.stderr })}`);
  }
  const outcomes = parseSemanticOutcomes(result.stdout, programs);
  const boundedFailure = outcomes.find(value => value.status === "timeout" || value.status === "overflow");
  if (boundedFailure) throw new Error(`Rscript semantic case ${boundedFailure.caseIndex}:${boundedFailure.cellIndex} ${boundedFailure.status}: ${boundedFailure.errorPreview}`);
  return outcomes;
}

export async function runPackagedPrograms(programs: readonly SemanticProgram[], options: PackagedRunOptions): Promise<SemanticOutcome[]> {
  const outcomes: SemanticOutcome[] = [];
  for (const [caseIndex, programValue] of programs.entries()) {
    outcomes.push(...await runPackagedProgram(programValue, caseIndex, options));
  }
  return outcomes;
}

async function runPackagedProgram(programValue: SemanticProgram, caseIndex: number, options: PackagedRunOptions): Promise<SemanticOutcome[]> {
  const caseDirectory = join(options.cwd, `c-${caseIndex}-${randomUUID().slice(0, 8)}`);
  await mkdir(caseDirectory, { recursive: true });
  const notebook = join(caseDirectory, "notebook.R");
  await writeFile(notebook, renderObservedNotebook([programValue]));
  const configDirectory = join(caseDirectory, "config");
  const runtimeDirectory = join(options.cwd, `r${caseIndex}-${randomUUID().slice(0, 4)}`);
  await mkdir(join(configDirectory, "alder"), { recursive: true });
  await mkdir(runtimeDirectory, { recursive: true });
  await writeFile(join(configDirectory, "alder", "preferences.yaml"), `rscript: ${JSON.stringify(options.rscript)}\n`);
  const manifest = JSON.parse(await readFile(join(options.applicationRoot, "manifest.json"), "utf8")) as { resources: { cliLauncher: string } };
  const launcher = resolve(options.applicationRoot, manifest.resources.cliLauncher);
  const environment = {
    ...options.environment,
    HOME: caseDirectory,
    XDG_CONFIG_HOME: configDirectory,
    XDG_DATA_HOME: join(caseDirectory, "data"),
    XDG_CACHE_HOME: join(caseDirectory, "cache"),
    XDG_STATE_HOME: join(caseDirectory, "state"),
    ALDER_RUNTIME_DIRECTORY: runtimeDirectory,
  };
  const transport = new StdioClientTransport({
    command: launcher, args: ["mcp", notebook], cwd: caseDirectory,
    env: definedEnvironment(environment), stderr: "pipe", maxBufferSize: R_SEMANTIC_OUTPUT_BYTES,
  });
  const client = new Client({ name: "alder-r-semantics", version: "1" }, { capabilities: {} });
  const stderr: Buffer[] = [];
  transport.stderr?.on("data", chunk => stderr.push(Buffer.from(chunk)));
  const timeoutMs = options.timeoutMs ?? R_SEMANTIC_CASE_TIMEOUT_MS;
  let shutdownSnapshot: Record<string, unknown> | undefined;
  let shutdownComplete = false;
  let primaryError: unknown;
  try {
    await bounded(client.connect(transport), timeoutMs, "packaged semantic connection");
    const initial = requireToolResult(await bounded(client.callTool({ name: "notebook_state", arguments: {} }), timeoutMs, "initial packaged semantic state"));
    const snapshot = requireSnapshot(initial);
    shutdownSnapshot = snapshot;
    const run = await bounded(client.callTool({ name: "run_all", arguments: {
      requestId: randomUUID(), sessionEpoch: requireString(snapshot.epoch), expectedDocumentRevision: requireInteger(snapshot.documentRevision),
    } }), timeoutMs, "packaged semantic execution");
    if (run.isError && !isRecord(run.structuredContent)) throw new Error("packaged semantic execution failed without a result");
    const completed = requireToolResult(await bounded(client.callTool({ name: "notebook_state", arguments: {} }), timeoutMs, "completed packaged semantic state"));
    const completedSnapshot = requireSnapshot(completed);
    shutdownSnapshot = completedSnapshot;
    await shutdownPackagedClient(client, completedSnapshot, timeoutMs);
    shutdownComplete = true;
    const cells = completedSnapshot.cells as Array<Record<string, unknown>>;
    if (cells.length !== programValue.cells.length * 2) throw new Error(`packaged semantic case ${caseIndex} returned ${cells.length} cells; expected ${programValue.cells.length * 2}`);
    const outcomes = programValue.cells.map((_, cellIndex) => packagedOutcome(cells[cellIndex * 2]!, cells[cellIndex * 2 + 1]!, caseIndex, cellIndex));
    return outcomes;
  } catch (error) {
    primaryError = error;
    const detail = Buffer.concat(stderr).toString("utf8").trim();
    throw new Error(`${error instanceof Error ? error.message : String(error)}${detail ? `\n${detail}` : ""}`, { cause: error });
  } finally {
    if (!shutdownComplete && shutdownSnapshot !== undefined) {
      try {
        await shutdownPackagedClient(client, shutdownSnapshot, Math.min(timeoutMs, 5_000));
        shutdownComplete = true;
      } catch { /* explicit process cleanup below is authoritative */ }
    }
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
    if (!shutdownComplete) {
      try { await terminateOwnedProcesses([caseDirectory, runtimeDirectory]); }
      catch (cleanupError) { if (primaryError === undefined) throw cleanupError; }
    }
  }
}

async function shutdownPackagedClient(client: Client, snapshot: Record<string, unknown>, timeoutMs: number): Promise<void> {
  const shutdown = await bounded(client.callTool({ name: "shutdown", arguments: {
    requestId: randomUUID(), sessionEpoch: requireString(snapshot.epoch),
    expectedDocumentRevision: requireInteger(snapshot.documentRevision),
    expectedClientIds: Array.isArray(snapshot.activeClientIds) ? snapshot.activeClientIds : [], confirmed: true,
  } }), timeoutMs, "packaged semantic shutdown");
  if (shutdown.isError) throw new Error(`packaged semantic shutdown failed: ${JSON.stringify(shutdown.structuredContent)}`);
}

interface ProcessRow { pid: number; ppid: number; command: string; }

function processRows(): ProcessRow[] {
  return execFileSync("/bin/ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" }).split("\n").flatMap(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), command: match[3]! }] : [];
  });
}

function ownedProcessRows(markers: readonly string[]): ProcessRow[] {
  const rows = processRows();
  const owned = new Set(rows.filter(row => markers.some(marker => row.command.includes(marker))).map(row => row.pid));
  for (;;) {
    const before = owned.size;
    for (const row of rows) if (owned.has(row.ppid)) owned.add(row.pid);
    if (owned.size === before) break;
  }
  return rows.filter(row => owned.has(row.pid));
}

async function terminateOwnedProcesses(markers: readonly string[]): Promise<void> {
  let rows = ownedProcessRows(markers);
  if (rows.length === 0) return;
  const owned = new Set(rows.map(row => row.pid));
  const roots = rows.filter(row => !owned.has(row.ppid));
  for (const row of roots) try { process.kill(row.pid, "SIGTERM"); } catch { /* already gone */ }
  const termDeadline = Date.now() + 5_000;
  while (Date.now() < termDeadline && (rows = ownedProcessRows(markers)).length > 0) await new Promise(resolveWait => setTimeout(resolveWait, 100));
  for (const row of [...rows].reverse()) try { process.kill(row.pid, "SIGKILL"); } catch { /* already gone */ }
  const killDeadline = Date.now() + 2_000;
  while (Date.now() < killDeadline && (rows = ownedProcessRows(markers)).length > 0) await new Promise(resolveWait => setTimeout(resolveWait, 100));
  if (rows.length > 0) throw new Error(`packaged semantic cleanup left owned processes: ${rows.map(row => `${row.pid} ${row.command}`).join("\n")}`);
}

function packagedOutcome(source: Record<string, unknown>, probe: Record<string, unknown>, caseIndex: number, cellIndex: number): SemanticOutcome {
  let status: SemanticOutcome["status"];
  if (source.status === "done") status = "ok";
  else if (source.status === "error") status = "error";
  else if (source.status === "stopped") status = "timeout";
  else throw new Error(`packaged semantic source ${caseIndex}:${cellIndex} ended with status ${String(source.status)}`);
  if (probe.status !== "done") throw new Error(`packaged semantic probe ${caseIndex}:${cellIndex} ended with status ${String(probe.status)}`);
  const log = requireStringArray(source.log, "source log");
  const warnings = log.filter(line => line.startsWith("Warning: "));
  const stdout = log.filter(line => !line.startsWith("Warning: ") && !(status === "error" && line.startsWith("Error: ")));
  const visible = Array.isArray(source.outputs) ? source.outputs.flatMap(outputText).join("\n") : "";
  if (Buffer.byteLength([...stdout, ...warnings, visible].join("\n")) > R_SEMANTIC_CASE_OUTPUT_BYTES || hasTruncatedOutput(source)) {
    throw new Error(`packaged semantic case ${caseIndex}:${cellIndex} overflow`);
  }
  const probeLines = requireStringArray(probe.log, "probe log").filter(line => line.includes(PROBE_MARKER));
  if (probeLines.length !== 1) throw new Error(`packaged semantic probe ${caseIndex}:${cellIndex} returned ${probeLines.length} markers`);
  const fields = probeLines[0]!.slice(probeLines[0]!.indexOf(PROBE_MARKER) + PROBE_MARKER.length).split("|");
  if (fields.length !== 6 || Number(fields[0]) !== 0 || Number(fields[1]) !== cellIndex) throw new Error(`packaged semantic probe ${caseIndex}:${cellIndex} returned unexpected marker ${probeLines[0]}`);
  const value = requireHex(fields[2]!);
  const state = requireHex(fields[3]!);
  const valuePreview = decodeHex(fields[4]!);
  const statePreview = decodeHex(fields[5]!);
  const error = nativeError(source.error);
  return { caseIndex, cellIndex, status, value, state, stdout: stdout.join("\n"), visible, warnings: warnings.join("\n"), error, valuePreview, statePreview, warningsPreview: warnings.join("\n"), errorPreview: error };
}

function requireStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || !value.every(item => typeof item === "string")) throw new Error(`packaged semantic ${label} is invalid`);
  return value;
}

function hasTruncatedOutput(source: Record<string, unknown>): boolean {
  if (requireStringArray(source.log, "source log").includes("[output truncated at 1048576 bytes]")) return true;
  return Array.isArray(source.outputs) && source.outputs.some(value => isRecord(value) && isRecord(value.data) && value.data.truncated === true);
}

function nativeError(value: unknown): string {
  if (value === null) return "";
  if (!isRecord(value)) throw new Error("packaged semantic source returned malformed error");
  const details = isRecord(value.details) ? value.details : {};
  const condition = isRecord(details.condition) ? details.condition : {};
  const classes = Array.isArray(condition.class) ? condition.class.map(String).join("\n") : "";
  const message = typeof value.message === "string" ? value.message : "";
  const call = typeof condition.call === "string" ? condition.call : "";
  return `${classes}\x1e${message}\x1e${call}`;
}

function outputText(value: unknown): string[] {
  if (!isRecord(value) || !isRecord(value.data)) return [];
  return typeof value.data.text === "string" ? [value.data.text] : [];
}

function requireToolResult(value: { isError?: boolean; structuredContent?: unknown }): Record<string, unknown> {
  if (value.isError) throw new Error(`packaged semantic query failed: ${JSON.stringify(value.structuredContent)}`);
  if (!isRecord(value.structuredContent) || !isRecord(value.structuredContent.result)) throw new Error("packaged semantic query omitted its result");
  return value.structuredContent.result;
}

function requireSnapshot(result: Record<string, unknown>): Record<string, unknown> {
  if (!isRecord(result.snapshot) || !Array.isArray(result.snapshot.cells)) throw new Error("packaged semantic query omitted its snapshot");
  return result.snapshot;
}

function requireString(value: unknown): string { if (typeof value !== "string" || !value) throw new TypeError("expected string"); return value; }
function requireInteger(value: unknown): number { if (!Number.isSafeInteger(value) || Number(value) < 0) throw new TypeError("expected integer"); return Number(value); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function definedEnvironment(value: NodeJS.ProcessEnv): Record<string, string> { return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => entry[1] !== undefined)); }

async function bounded<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs} ms`)), timeoutMs); })]);
  } finally { if (timer) clearTimeout(timer); }
}

export async function runDifferentialPrograms(programs: readonly SemanticProgram[], options: PackagedRunOptions): Promise<{
  reference: SemanticOutcome[]; actual: SemanticOutcome[]; difference: SemanticDifference | null;
}> {
  const reference = await runRscriptPrograms(programs, options);
  const actual = await runPackagedPrograms(programs, options);
  return { reference, actual, difference: compareSemanticOutcomes(reference, actual) };
}

export async function temporarySemanticDirectory(): Promise<string> { return mkdtemp(join(tmpdir(), "alder-r-semantics-")); }
export async function removeSemanticDirectory(path: string): Promise<void> { await rm(path, { recursive: true, force: true }); }
export function cleanSemanticEnvironment(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const result = { ...base };
  for (const key of Object.keys(result)) if (key === "R_HOME" || key.startsWith("R_LIBS") || key.startsWith("ALDER_")) delete result[key];
  return result;
}
export function formatSemanticFailure(program: SemanticProgram, difference: SemanticDifference, minimized?: SemanticProgram): string {
  return [
    `R semantic mismatch seed=${seedLabel(program.seed)} case=${program.caseIndex} category=${program.category} cell=${difference.cellIndex} field=${difference.field}`,
    `sources=${JSON.stringify(program.cells.map(value => value.source))}`,
    `Rscript=${JSON.stringify(difference.reference)}`,
    `Alder=${JSON.stringify(difference.actual)}`,
    ...(minimized ? [`minimized=${JSON.stringify(minimized.cells.map(value => value.source))}`] : []),
  ].join("\n");
}

export function parseSemanticSeeds(value: string | undefined): number[] {
  if (!value) return [...DEFAULT_R_SEMANTIC_SEEDS];
  const parts = value.split(",");
  if (parts.length > MAX_SEEDS || parts.some(item => item.trim() === "")) throw new Error(`ALDER_R_SEMANTICS_SEED must contain 1 to ${MAX_SEEDS} uint32 seeds`);
  const seeds = parts.map(item => Number(item.trim()));
  if (seeds.some(seed => !Number.isSafeInteger(seed) || seed < 0 || seed > 0xffff_ffff)) throw new Error(`ALDER_R_SEMANTICS_SEED must contain 1 to ${MAX_SEEDS} uint32 seeds`);
  return seeds;
}

export function parseSemanticCaseCount(value: string | undefined): number {
  if (!value) return DEFAULT_R_SEMANTIC_CASES;
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 1 || count > 256) throw new Error("ALDER_R_SEMANTICS_CASES must be an integer from 1 to 256");
  return count;
}

export function parseSemanticShrinkAttempts(value: string | undefined): number {
  if (value === undefined) return 16;
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 1 || count > 256) throw new Error("ALDER_R_SEMANTICS_SHRINK_ATTEMPTS must be an integer from 1 to 256");
  return count;
}

export function selectReplayCase(programs: readonly SemanticProgram[], value: string | undefined): SemanticProgram[] {
  if (value === undefined) return [...programs];
  const index = Number(value);
  if (!Number.isSafeInteger(index) || index < 0 || index >= programs.length) throw new Error("ALDER_R_SEMANTICS_CASE is outside the generated corpus");
  return [programs[index]!];
}

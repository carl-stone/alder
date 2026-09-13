import { spawnSync } from "node:child_process";
import { readdir, readFile, readlink } from "node:fs/promises";

const OBSERVER_TIMEOUT_MS = 15_000;
const SUPPORTED_PLATFORMS = new Set(["linux", "darwin", "win32"]);

let configuredSupervisorExecutable = null;

export function configureProcessObserver(supervisorExecutable) {
  if (typeof supervisorExecutable !== "string" || supervisorExecutable.length === 0 || supervisorExecutable.includes("\0")) {
    throw new TypeError("process observer supervisor executable must be nonempty");
  }
  configuredSupervisorExecutable = supervisorExecutable;
}

function resolveOptions(options) {
  if (options?.supervisorExecutable !== undefined) return options;
  return configuredSupervisorExecutable === null ? options ?? {} : { supervisorExecutable: configuredSupervisorExecutable };
}

/**
 * @typedef {{pid:number,ppid:number,state:string,startIdentity:string,command:string,executable:string|null,depth?:number}} ProcessRecord
 * @typedef {{supervisorExecutable:string}} ProcessObserverOptions
 */


/**
 * @param {number} pid
 * @param {ProcessObserverOptions} options
 * @returns {Promise<ProcessRecord|null>}
 */
export async function readProcess(pid, options = {}) {
  validatePid(pid);
  const effectiveOptions = resolveOptions(options);
  const candidates = await readCandidateTable();
  const candidate = candidates.get(pid);
  if (candidate === undefined) {
    const native = await inspectNative(pid, effectiveOptions);
    if (native === null) return null;
    throw new Error("process_observer_candidate_missing:" + pid);
  }
  const record = await inspectCandidateNative(candidate, effectiveOptions);
  return record === null ? null : readOwnedDetails(record, effectiveOptions);
}

/**
 * Capture one owned process tree, guarded by the native registry's PID and
 * start identity. An empty/missing/mismatched tree is never a success.
 *
 * The macOS ps snapshot is used only to discover candidate PID/PPID edges.
 * Every owned node is then re-read through the artifact supervisor, so the
 * native birth identity—not ps's rounded lstart—is used for ownership and any
 * later signal.
 *
 * @param {number} rootPid
 * @param {string|undefined} expectedStartIdentity
 * @param {ProcessObserverOptions} options
 * @returns {Promise<ProcessRecord[]>}
 */
export async function captureProcessTree(rootPid, expectedStartIdentity, options = {}) {
  validatePid(rootPid);
  if (expectedStartIdentity !== undefined) validateIdentity(expectedStartIdentity);
  const effectiveOptions = resolveOptions(options);
  const candidates = await readCandidateTable();
  const rootCandidate = candidates.get(rootPid);
  if (rootCandidate === undefined) throw new Error("owned_process_root_missing:" + rootPid);
  const rootNative = await inspectCandidateNative(rootCandidate, effectiveOptions);
  if (rootNative === null) throw new Error("owned_process_root_missing:" + rootPid);
  if (expectedStartIdentity !== undefined && rootNative.startIdentity !== expectedStartIdentity) {
    throw new Error("owned_process_identity_mismatch:" + rootPid);
  }
  const byParent = new Map();
  for (const candidate of candidates.values()) {
    const children = byParent.get(candidate.ppid) ?? [];
    children.push(candidate);
    byParent.set(candidate.ppid, children);
  }
  const owned = [];
  const queue = [{ record: rootNative, depth: 0, parentPid: null, parentStartIdentity: null }];
  const seen = new Set();
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined || seen.has(current.record.pid)) continue;
    seen.add(current.record.pid);
    const currentNative = await inspectNative(current.record.pid, effectiveOptions);
    if (currentNative === null || currentNative.startIdentity !== current.record.startIdentity) {
      if (current.parentPid === null) throw new Error("owned_process_root_missing:" + rootPid);
      continue;
    }
    let edgeLive = current.parentPid === null;
    if (current.parentPid !== null) {
      const parentNative = await inspectNative(current.parentPid, effectiveOptions);
      edgeLive = parentNative !== null && parentNative.startIdentity === current.parentStartIdentity
        && currentNative.ppid === current.parentPid;
    }
    const currentDetails = await readOwnedDetails({ ...current.record, ...currentNative }, effectiveOptions);
    if (currentDetails === null) {
      if (current.parentPid === null) throw new Error("owned_process_root_missing:" + rootPid);
      continue;
    }
    if (edgeLive && current.parentPid !== null) {
      const parentAfterDetails = await inspectNative(current.parentPid, effectiveOptions);
      edgeLive = parentAfterDetails !== null && parentAfterDetails.startIdentity === current.parentStartIdentity
        && currentDetails.ppid === parentAfterDetails.pid;
    }
    owned.push({ ...currentDetails, depth: current.depth });
    if (!edgeLive) continue;
    for (const childCandidate of byParent.get(current.record.pid) ?? []) {
      const childNative = await inspectCandidateNative(childCandidate, effectiveOptions);
      // A child can exit or be reparented between discovery and inspection;
      // neither case is evidence of ownership under the captured parent.
      if (childNative === null || childNative.ppid !== current.record.pid) continue;
      const child = await readOwnedDetails(childNative, effectiveOptions, current.record.pid);
      if (child === null) continue;
      const parentAfterChild = await inspectNative(current.record.pid, effectiveOptions);
      if (parentAfterChild === null || parentAfterChild.startIdentity !== current.record.startIdentity) {
        owned.push({ ...child, depth: current.depth + 1 });
        continue;
      }
      if (child.ppid !== parentAfterChild.pid) continue;
      queue.push({ record: child, depth: current.depth + 1, parentPid: parentAfterChild.pid, parentStartIdentity: parentAfterChild.startIdentity });
    }
  }
  if (owned.length === 0) throw new Error("owned_process_tree_empty:" + rootPid);
  return owned;
}

/**
 * @param {...ProcessRecord[]} trees
 * @returns {ProcessRecord[]}
 */
export function mergeProcessTrees(...trees) {
  const merged = new Map();
  for (const tree of trees) {
    for (const record of tree ?? []) {
      const key = record.pid + ":" + record.startIdentity;
      const prior = merged.get(key);
      if (prior === undefined || (record.depth ?? 0) < (prior.depth ?? 0)) merged.set(key, record);
    }
  }
  return [...merged.values()];
}

/**
 * Wait until every captured PID either exits or changes its native creation
 * identity.
 *
 * @param {ProcessRecord[]} records
 * @param {number} timeout
 * @param {ProcessObserverOptions} options
 */
export async function waitForOwnedProcessesGone(records, timeout, options = {}) {
  validateRecords(records);
  if (!Number.isSafeInteger(timeout) || timeout < 1) throw new RangeError("process cleanup timeout must be a positive integer");
  const deadline = Date.now() + timeout;
  for (;;) {
    const active = [];
    for (const record of records) {
      const observed = await readProcess(record.pid, options);
      if (observed !== null && observed.startIdentity === record.startIdentity && observed.state !== "Z") active.push(record);
    }
    if (active.length === 0) return;
    if (Date.now() >= deadline) throw new Error("owned_process_cleanup_timeout:" + active.map(record => record.pid).join(","));
    await delay(100);
  }
}

/**
 * Terminate only records captured from one owned tree. The native PID/start
 * identity is rechecked before every signal to prevent PID-reuse kills.
 *
 * @param {ProcessRecord[]} records
 * @param {ProcessObserverOptions} options
 * @returns {Promise<{forced:boolean,records:number}>}
 */
export async function cleanupOwnedProcessTree(records, options = {}) {
  validateRecords(records);
  const ordered = [...records].sort((left, right) => (right.depth ?? 0) - (left.depth ?? 0));
  const matches = async record => {
    const current = await readProcess(record.pid, options);
    return current !== null && current.startIdentity === record.startIdentity && current.state !== "Z";
  };
  const signal = async name => {
    for (const record of ordered) {
      if (!await matches(record)) continue;
      try {
        process.kill(record.pid, name);
      } catch (error) {
        if (!isProcessGoneError(error)) throw error;
      }
    }
  };
  const wait = async timeout => {
    const deadline = Date.now() + timeout;
    for (;;) {
      const active = [];
      for (const record of ordered) if (await matches(record)) active.push(record);
      if (active.length === 0 || Date.now() >= deadline) return active;
      await delay(100);
    }
  };
  await signal("SIGTERM");
  let active = await wait(5_000);
  let forced = false;
  if (active.length > 0) {
    forced = true;
    for (const record of active) {
      if (!await matches(record)) continue;
      try {
        process.kill(record.pid, "SIGKILL");
      } catch (error) {
        if (!isProcessGoneError(error)) throw error;
      }
    }
    active = await wait(5_000);
  }
  if (active.length > 0) throw new Error("owned_process_cleanup_timeout:" + active.map(record => record.pid).join(","));
  return { forced, records: records.length };
}

/**
 * @param {number} pid
 * @param {ProcessObserverOptions} options
 * @returns {Promise<string|null>}
 */
export async function processStartIdentity(pid, options = {}) {
  const record = await readProcess(pid, options);
  return record?.startIdentity ?? null;
}

/** Compare native start identities without parsing or truncating them. */
export function startIdentityMatches(actual, expected) {
  return typeof actual === "string" && typeof expected === "string" && actual === expected;
}

/**
 * @param {number} pid
 * @param {string} identity
 * @param {ProcessObserverOptions} options
 * @returns {Promise<boolean>}
 */
export async function ownerMatches(pid, identity, options = {}) {
  validatePid(pid);
  validateIdentity(identity);
  const record = await readProcess(pid, options);
  return record !== null && record.startIdentity === identity && record.state !== "Z";
}

/**
 * @param {number} pid
 * @param {string} identity
 * @param {number} timeout
 * @param {ProcessObserverOptions} options
 */
export async function waitForOwnerExit(pid, identity, timeout, options = {}) {
  validatePid(pid);
  validateIdentity(identity);
  if (!Number.isSafeInteger(timeout) || timeout < 1) throw new RangeError("owner exit timeout must be a positive integer");
  const deadline = Date.now() + timeout;
  for (;;) {
    if (!await ownerMatches(pid, identity, options)) return true;
    if (Date.now() >= deadline) return false;
    await delay(100);
  }
}

async function inspectCandidateNative(candidate, options) {
  const native = await inspectNative(candidate.pid, options);
  if (native === null) return null;
  if (native.pid !== candidate.pid) throw new Error("process_observer_pid_mismatch:" + candidate.pid);
  return { ...candidate, ...native };
}

async function readOwnedDetails(record, options, expectedParentPid = null) {
  const details = await readOwnedProcessDetails(record, options);
  if (details === null) return null;
  const native = await inspectNative(record.pid, options);
  if (native === null) return null;
  if (native.startIdentity !== record.startIdentity) throw new Error("owned_process_identity_changed:" + record.pid);
  if (expectedParentPid !== null && native.ppid !== expectedParentPid) return null;
  return { ...record, ...native, ...details };
}
async function linuxStateAfterMissingMetadata(record, options, originalError) {
  const native = await inspectNative(record.pid, options);
  if (native === null) return null;
  if (native.startIdentity !== record.startIdentity) throw new Error("owned_process_identity_changed:" + record.pid);
  const statText = await readFile("/proc/" + record.pid + "/stat", "utf8").catch(error => {
    if (isProcessGoneError(error)) return null;
    throw new Error("process_observer_proc_read_failed:" + error.message);
  });
  if (statText === null) {
    const after = await inspectNative(record.pid, options);
    if (after === null) return null;
    if (after.startIdentity !== record.startIdentity) throw new Error("owned_process_identity_changed:" + record.pid);
    throw new Error("process_observer_metadata_failed:" + originalError.message);
  }
  const close = statText.lastIndexOf(")");
  if (close < 0) throw new Error("process_observer_malformed_proc_stat:" + record.pid);
  const state = statText.slice(close + 2).trim().split(/\s+/)[0];
  if (state !== "Z") throw new Error("process_observer_metadata_failed:" + originalError.message);
  return state;
}
async function readOwnedProcessDetails(record, options) {
  const pid = record.pid;
  if (process.platform === "linux") {
    const command = await readFile("/proc/" + pid + "/cmdline", "utf8").then(value => value.replaceAll("\0", " ").trim()).catch(async error => {
      if (isProcessGoneError(error)) {
        const state = await linuxStateAfterMissingMetadata(record, options, error);
        if (state === null) return null;
        return "";
      }
      throw new Error("process_observer_metadata_failed:" + error.message);
    });
    if (command === null) return null;
    let executable;
    try {
      executable = await readlink("/proc/" + pid + "/exe", "utf8");
    } catch (error) {
      if (!isProcessGoneError(error)) throw new Error("process_observer_metadata_failed:" + error.message);
      const state = await linuxStateAfterMissingMetadata(record, options, error);
      if (state === null) return null;
      return { command, executable: null, state };
    }
    return { command, executable };
  }
  if (process.platform === "darwin") {
    const result = spawnSync("/bin/ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf8", timeout: OBSERVER_TIMEOUT_MS, windowsHide: true, env: { ...process.env },
    });
    const stderr = String(result.stderr ?? "").trim();
    const stdout = String(result.stdout ?? "");
    if (result.error) throw new Error("process_observer_metadata_failed:" + result.error.message);
    if (result.status !== 0) {
      if (result.status === 1 && !stderr && !stdout.trim()) {
        const native = await inspectNative(pid, options);
        if (native === null) return null;
        throw new Error("process_observer_metadata_failed:mac process remained present");
      }
      throw new Error("process_observer_metadata_failed:" + (stderr || "exit_" + result.status));
    }
    if (stderr) throw new Error("process_observer_metadata_diagnostics:" + stderr);
    const command = stdout.split(/\r?\n/).map(line => line.trim()).find(Boolean) ?? "";
    return { command, executable: command ? command.split(/\s+/, 1)[0] : null };
  }
  const script = "$ErrorActionPreference='Stop'; $p=Get-CimInstance Win32_Process -Filter 'ProcessId = " + String(pid) + "' -Property CommandLine,ExecutablePath; if ($null -eq $p) { 'null' } else { [pscustomobject]@{ command=([string]$p.CommandLine); executable=([string]$p.ExecutablePath) } | ConvertTo-Json -Compress }";
  const result = spawnPowerShell(script);
  const output = result.stdout.trim();
  if (output === "null") {
    const native = await inspectNative(pid, options);
    if (native === null) return null;
    throw new Error("process_observer_metadata_failed:windows process remained present");
  }
  let value;
  try {
    value = JSON.parse(output);
  } catch (error) {
    throw new Error("process_observer_invalid_owned_metadata:" + error.message);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).sort().join(",") !== "command,executable") {
    throw new Error("process_observer_invalid_owned_metadata");
  }
  const command = String(value.command ?? "").trim();
  const executable = String(value.executable ?? "").trim() || (command ? command.split(/\s+/, 1)[0] : null);
  return { command, executable };
}

async function inspectNative(pid, options) {
  const supervisor = options?.supervisorExecutable;
  if (typeof supervisor !== "string" || supervisor.length === 0 || supervisor.includes("\0")) {
    throw new Error("process_observer_native_inspector_required");
  }
  const result = spawnSync(supervisor, ["--inspect-process", String(pid)], {
    encoding: "utf8", timeout: OBSERVER_TIMEOUT_MS, windowsHide: true, env: { ...process.env },
  });
  if (result.error) throw new Error("process_observer_inspector_failed:" + formatInspectorFailure(result));
  if (result.status !== 0) throw new Error("process_observer_inspector_failed:" + formatInspectorFailure(result));
  if (String(result.stderr ?? "").trim()) throw new Error("process_observer_inspector_diagnostics:" + String(result.stderr).trim());
  const output = String(result.stdout ?? "").trim();
  if (output === "null") return null;
  let value;
  try {
    value = JSON.parse(output);
  } catch (error) {
    throw new Error("process_observer_invalid_inspector_json:" + error.message);
  }
  if (value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).sort().join(",") !== "pid,ppid,startIdentity") {
    throw new Error("process_observer_invalid_inspector_record");
  }
  const observedPid = value.pid;
  const observedPpid = value.ppid;
  const identity = value.startIdentity;
  if (!Number.isSafeInteger(observedPid) || observedPid <= 0 || observedPid !== pid
      || !Number.isSafeInteger(observedPpid) || observedPpid < 0
      || typeof identity !== "string" || identity.length === 0
      || !nativeIdentityShape(identity)) {
    throw new Error("process_observer_invalid_inspector_record");
  }
  return { pid: observedPid, ppid: observedPpid, startIdentity: identity };
}

function formatInspectorFailure(result) {
  const error = result.error;
  return JSON.stringify({
    status: result.status ?? null,
    signal: result.signal ?? null,
    error: error == null ? null : {
      name: error.name ?? null,
      code: error.code ?? null,
      message: error.message ?? String(error),
    },
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
  });
}

function nativeIdentityShape(identity) {
  if (process.platform === "linux") return /^linux:\d+$/.test(identity);
  if (process.platform === "darwin") return /^macos:\d+:\d+$/.test(identity);
  if (process.platform === "win32") return /^windows:\d+$/.test(identity);
  return false;
}

async function readCandidateTable() {
  if (!SUPPORTED_PLATFORMS.has(process.platform)) {
    throw new Error("process_observer_unsupported_platform:" + process.platform);
  }
  if (process.platform === "linux") return readLinuxCandidates();
  if (process.platform === "darwin") return readMacCandidates();
  return readWindowsCandidates();
}

async function readLinuxCandidates() {
  const names = await readdir("/proc").catch(error => { throw new Error("process_observer_proc_unavailable:" + error.message); });
  const result = new Map();
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("process_observer_invalid_proc_pid:" + name);
    const statText = await readFile("/proc/" + name + "/stat", "utf8").catch(error => {
      if (isProcessGoneError(error)) return null;
      throw new Error("process_observer_proc_read_failed:" + error.message);
    });
    if (statText === null) continue;
    const close = statText.lastIndexOf(")");
    if (close < 0) throw new Error("process_observer_malformed_proc_stat:" + name);
    const fields = statText.slice(close + 2).trim().split(/\s+/);
    const state = fields[0];
    const ppid = Number(fields[1]);
    if (typeof state !== "string" || state.length === 0 || !Number.isSafeInteger(ppid) || ppid < 0) throw new Error("process_observer_invalid_proc_stat:" + name);
    result.set(pid, { pid, ppid, state });
  }
  if (result.size === 0) throw new Error("process_observer_empty_proc");
  return result;
}

async function readMacCandidates() {
  const result = spawnObserver("/bin/ps", ["-axo", "pid=,ppid=,lstart=,state="]);
  const table = new Map();
  for (const line of result.stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = /^\s*(\d+)\s+(\d+)\s+([A-Za-z]{3}\s+[A-Za-z]{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+([^\s]+)\s*$/.exec(line);
    if (!match) throw new Error("process_observer_malformed_ps:" + line);
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(ppid) || ppid < 0) {
      throw new Error("process_observer_invalid_ps_record:" + line);
    }
    table.set(pid, { pid, ppid, state: match[4] });
  }
  if (table.size === 0) throw new Error("process_observer_empty_ps");
  return table;
}

async function readWindowsCandidates() {
  const script = "$ErrorActionPreference='Stop'; Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,ExecutionState | ForEach-Object { [pscustomobject]@{ pid=[int]$_.ProcessId; ppid=[int]$_.ParentProcessId; state=([string]$_.ExecutionState) } } | ConvertTo-Json -Compress";
  const result = spawnPowerShell(script);
  let values;
  try {
    values = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error("process_observer_invalid_cim_json:" + error.message);
  }
  const rows = Array.isArray(values) ? values : [values];
  const table = new Map();
  for (const row of rows) {
    if (!row || typeof row !== "object") throw new Error("process_observer_invalid_cim_record");
    const pid = Number(row.pid);
    const ppid = Number(row.ppid);
    if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(ppid) || ppid < 0) {
      throw new Error("process_observer_invalid_cim_record");
    }
    table.set(pid, { pid, ppid, state: String(row.state ?? "") });
  }
  if (table.size === 0) throw new Error("process_observer_empty_cim");
  return table;
}


function spawnObserver(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: OBSERVER_TIMEOUT_MS, windowsHide: true, env: { ...process.env } });
  if (result.error) throw new Error("process_observer_command_failed:" + result.error.message);
  if (result.status !== 0) throw new Error("process_observer_command_failed:" + String(result.stderr ?? "").trim());
  if (String(result.stderr ?? "").trim()) throw new Error("process_observer_command_diagnostics:" + String(result.stderr).trim());
  return { stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") };
}

function spawnPowerShell(script) {
  const candidates = process.env.PWSH ? [process.env.PWSH] : ["pwsh", "powershell.exe"];
  let lastError = "unavailable";
  for (const command of candidates) {
    const result = spawnSync(command, ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8", timeout: OBSERVER_TIMEOUT_MS, windowsHide: true, env: { ...process.env },
    });
    if (!result.error && result.status === 0 && !String(result.stderr ?? "").trim()) {
      return { stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") };
    }
    lastError = result.error?.message ?? (String(result.stderr ?? "").trim() || "exit_" + result.status);
  }
  throw new Error("process_observer_powershell_failed:" + lastError);
}

function validatePid(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new RangeError("process PID must be a positive integer");
}
function validateIdentity(identity) {
  if (typeof identity !== "string" || identity.length === 0 || identity.includes("\0")) throw new TypeError("process start identity must be nonempty");
}
function validateRecords(records) {
  if (!Array.isArray(records) || records.length === 0) throw new Error("owned_process_tree_empty");
  for (const record of records) {
    validatePid(record?.pid);
    validateIdentity(record?.startIdentity);
  }
}
function isProcessGoneError(error) {
  return error?.code === "ESRCH" || error?.code === "ENOENT";
}
function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

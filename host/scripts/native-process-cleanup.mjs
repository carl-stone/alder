import { execFileSync } from 'node:child_process';

function processRows() {
  return execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' }).split('\n').map(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    return match ? { pid: Number(match[1]), ppid: Number(match[2]), command: match[3] } : null;
  }).filter(Boolean);
}

export function ownedProcessRows(ownedPids, temporaryRoot) {
  const rows = processRows();
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const row of rows) if (ownedPids.has(row.ppid) && !ownedPids.has(row.pid)) {
      ownedPids.add(row.pid);
      expanded = true;
    }
  }
  return rows.filter(row => ownedPids.has(row.pid) || (temporaryRoot && row.command.includes(temporaryRoot)));
}

export class OwnedProcessSurvivorError extends Error {
  constructor(survivors) {
    super(`owned packaged processes survived native cleanup:\n${survivors.map(row => `${row.pid} ${row.command}`).join('\n')}`);
    this.name = 'OwnedProcessSurvivorError';
    this.survivors = survivors;
  }
}

export async function waitForOwnedExit(ownedPids, temporaryRoot, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  let survivors = [];
  do {
    survivors = ownedProcessRows(ownedPids, temporaryRoot);
    if (!survivors.length) return;
    await new Promise(resolveWait => setTimeout(resolveWait, 25));
  } while (Date.now() < deadline);
  throw new OwnedProcessSurvivorError(survivors);
}

export async function cleanupOwnedProcesses(ownedPids, temporaryRoot) {
  const initial = ownedProcessRows(ownedPids, temporaryRoot);
  if (!initial.length) return { fallbackRequired: false, terminatedPids: [], killedPids: [] };
  const terminatedPids = initial.map(row => row.pid);
  for (const row of [...initial].reverse()) {
    try { process.kill(row.pid, 'SIGTERM'); } catch {}
  }
  try {
    await waitForOwnedExit(ownedPids, temporaryRoot, 1_000);
    return { fallbackRequired: true, terminatedPids, killedPids: [] };
  } catch {}
  const remaining = ownedProcessRows(ownedPids, temporaryRoot);
  const killedPids = remaining.map(row => row.pid);
  for (const row of [...remaining].reverse()) {
    try { process.kill(row.pid, 'SIGKILL'); } catch {}
  }
  await waitForOwnedExit(ownedPids, temporaryRoot, 1_000);
  return { fallbackRequired: true, terminatedPids, killedPids };
}

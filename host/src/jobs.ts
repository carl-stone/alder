import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { TextDecoder } from 'node:util';

import { parseStrictJson } from './framing.js';

export interface JobOptions {
  rscript: string;
  packagePath: string;
  environment?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

const MAX_JOB_INPUT_BYTES = 64 * 1024 * 1024;
const MAX_JOB_OUTPUT_BYTES = 8 * 1024 * 1024;

interface RunningJob {
  child: ChildProcess;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  spawnError?: Error;
  termination: 'timeout' | 'close' | null;
}

class RJobError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

export class RJobs {
  private readonly children = new Map<ChildProcess, RunningJob>();
  private closed = false;
  private closing?: Promise<void>;
  constructor(private readonly options: JobOptions) {
    if (!options.rscript || !options.packagePath) throw new Error('R job paths must be nonempty');
    if (options.timeoutMs !== undefined
      && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0 || options.timeoutMs > 3_600_000)) {
      throw new Error('R job timeout must be an integer between 1 and 3600000 milliseconds');
    }
  }

  async run(command: string, payload: Record<string, unknown>): Promise<unknown> {
    if (this.closed) throw jobError('job_closed', 'R job manager closed');
    const directory = await mkdtemp(join(tmpdir(), 'alder-job-'));
    try {
      const input = join(directory, 'input.json'), output = join(directory, 'result.json');
      const serialized = JSON.stringify({ command, payload });
      if (Buffer.byteLength(serialized) > MAX_JOB_INPUT_BYTES) {
        throw jobError('invalid_request', 'R job input exceeds 64 MiB');
      }
      await writeFile(input, serialized, { mode: 0o600 });
      if (this.closed) throw jobError('job_closed', 'R job manager closed');
      const env = { ...process.env, ...this.options.environment };
      // Rscript selects its own installation. A parent R_HOME can redirect an
      // explicitly selected executable to an incompatible installation.
      delete env.R_HOME;
      env.R_LIBS = [dirname(this.options.packagePath), env.R_LIBS].filter(Boolean).join(process.platform === 'win32' ? ';' : ':');
      const child = spawn(this.options.rscript, ['--vanilla', join(this.options.packagePath, 'worker', 'host-job.R'), input, output], {
        env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
        detached: process.platform !== 'win32',
      });
      let settle!: (exit: { code: number | null; signal: NodeJS.Signals | null }) => void;
      let settled = false;
      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => { settle = resolve; });
      const record: RunningJob = { child, exited, termination: null };
      child.once('error', error => {
        record.spawnError = error;
        if (child.pid === undefined && !settled) {
          settled = true;
          settle({ code: null, signal: null });
        }
      });
      // A successful R exit need not close inherited pipes: publishing tools
      // can leave descendants alive. The detached POSIX group belongs to this
      // job until it is retired, even after its original leader exits.
      if (process.platform !== 'win32') child.once('exit', () => terminateTree(child));
      child.once('close', (code, signal) => {
        if (!settled) {
          settled = true;
          settle({ code, signal });
        }
      });
      this.children.set(child, record);
      let diagnostics = '';
      for (const stream of [child.stdout, child.stderr]) stream?.on('data', data => {
        diagnostics = (diagnostics + String(data)).slice(-65536);
      });
      try {
        const timer = setTimeout(() => {
          if (!settled) {
            if (record.termination === null) record.termination = 'timeout';
            terminateTree(child);
          }
        }, this.options.timeoutMs ?? 300_000);
        timer.unref();
        const exit = await exited.finally(() => clearTimeout(timer));
        if (record.termination === 'timeout') throw jobError('job_timeout', 'R job timed out');
        if (record.termination === 'close') throw jobError('job_closed', 'R job manager closed');
        if (record.spawnError) throw jobError('job_failed', record.spawnError.message);
        if (exit.code !== 0) throw jobError('job_failed', `R job exited ${exit.code}: ${diagnostics}`);
      } finally {
        terminateTree(child);
        this.children.delete(child);
      }
      let response: unknown;
      try {
        const bytes = await readBounded(output, MAX_JOB_OUTPUT_BYTES);
        response = parseStrictJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      }
      catch (error) {
        if (isJobError(error)) throw error;
        throw jobError('job_protocol_error', `R job returned an invalid response: ${messageOf(error)}`);
      }
      if (!isRecord(response) || typeof response.ok !== 'boolean') {
        throw jobError('job_protocol_error', 'R job returned an invalid response');
      }
      if (!response.ok) {
        const detail = isRecord(response.error) ? response.error : {};
        throw jobError(typeof detail.code === 'string' ? detail.code : 'job_failed',
          typeof detail.message === 'string' ? detail.message : 'R job failed');
      }
      return response.result;
    } finally { await rm(directory, { recursive: true, force: true }); }
  }

  close(): Promise<void> {
    this.closed = true;
    if (this.closing) return this.closing;
    this.closing = (async () => {
      const jobs = [...this.children.values()];
      for (const job of jobs) {
        if (job.termination === null) job.termination = 'close';
        terminateTree(job.child);
      }
      await Promise.all(jobs.map(job => job.exited));
    })();
    return this.closing;
  }
}

function terminateTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  if (process.platform === 'win32') {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    killer.on('error', () => { try { child.kill('SIGKILL'); } catch { /* already exited */ } });
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
        try { child.kill('SIGKILL'); } catch { /* already exited or unavailable */ }
      }
    }
  }
}

async function readBounded(path: string, maximum: number): Promise<Buffer> {
  const file = await open(path, 'r');
  try {
    const chunks: Buffer[] = [];
    let length = 0;
    while (length <= maximum) {
      const chunk = Buffer.allocUnsafe(Math.min(65_536, maximum + 1 - length));
      const result = await file.read(chunk, 0, chunk.length, null);
      if (result.bytesRead === 0) break;
      chunks.push(chunk.subarray(0, result.bytesRead));
      length += result.bytesRead;
    }
    if (length > maximum) throw jobError('job_protocol_error', 'R job response exceeds 8 MiB');
    return Buffer.concat(chunks, length);
  } finally { await file.close(); }
}

function jobError(code: string, message: string): RJobError {
  return new RJobError(code, message);
}

function isJobError(error: unknown): error is RJobError {
  return error instanceof RJobError;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

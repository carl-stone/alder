import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { RJobs } from '../src/jobs.js';

const worker = String.raw`
local({
  args <- commandArgs(trailingOnly = TRUE)
  request <- jsonlite::read_json(args[[1L]], simplifyVector = FALSE)
  command <- request$command
  if (identical(command, "hang")) {
    writeLines(as.character(Sys.getpid()), request$payload$marker)
    repeat Sys.sleep(1)
  }
  if (identical(command, "descendant")) {
    system2("sh", c("-c", shQuote(paste0(
      "sleep 30 & echo $! > ", shQuote(request$payload$marker)))))
  }
  if (identical(command, "malformed")) {
    writeLines("{not json", args[[2L]], useBytes = TRUE)
    quit(save = "no", status = 0L)
  }
  if (identical(command, "invalid-utf8")) {
    writeBin(as.raw(c(0x7b, 0xc3, 0x28, 0x7d)), args[[2L]])
    quit(save = "no", status = 0L)
  }
  if (identical(command, "duplicate-key")) {
    writeLines('{"ok":true,"ok":false,"result":null}', args[[2L]], useBytes = TRUE)
    quit(save = "no", status = 0L)
  }
  if (identical(command, "failure")) {
    jsonlite::write_json(list(ok = FALSE, error = list(
      code = "fixture_failure", message = "fixture failed")),
      args[[2L]], auto_unbox = TRUE)
    quit(save = "no", status = 0L)
  }
  jsonlite::write_json(list(ok = TRUE, result = list(
    value = request$payload$value,
    selected = Sys.getenv("ALDER_JOB_TEST", unset = ""),
    r_home = R.home(),
    inherited_r_home = Sys.getenv("R_HOME", unset = ""))),
    args[[2L]], auto_unbox = TRUE, null = "null")
})
`;

test('R jobs use the selected process environment and validate worker responses', async () => {
  const fixture = await jobFixture();
  const wrongRHome = join(fixture.directory, 'wrong-r-home');
  const jobs = new RJobs({ ...fixture.options, environment: {
    ALDER_JOB_TEST: 'selected-r', R_HOME: wrongRHome,
  } });
  try {
    const success = await jobs.run('success', { value: 42 }) as Record<string, unknown>;
    assert.equal(success.value, 42);
    assert.equal(success.selected, 'selected-r');
    assert.ok(typeof success.r_home === 'string' && success.r_home.length > 0);
    assert.notEqual(success.inherited_r_home, wrongRHome);
    await assert.rejects(jobs.run('failure', {}), { code: 'fixture_failure', message: 'fixture failed' });
    await assert.rejects(jobs.run('malformed', {}), { code: 'job_protocol_error' });
    await assert.rejects(jobs.run('invalid-utf8', {}), { code: 'job_protocol_error' });
    await assert.rejects(jobs.run('duplicate-key', {}), { code: 'job_protocol_error' });
  } finally {
    await jobs.close();
    await fixture.remove();
  }
});

test('job timeout kills the process and reports a stable terminal error', { timeout: 15_000 }, async () => {
  const fixture = await jobFixture();
  const marker = join(fixture.directory, 'timeout.pid');
  // Include a cold, contended R startup in the deadline so the worker can
  // publish the PID whose termination this test verifies.
  const jobs = new RJobs({ ...fixture.options, timeoutMs: 5_000 });
  try {
    const running = jobs.run('hang', { marker });
    const rejected = assert.rejects(running, { code: 'job_timeout' });
    const pid = Number(await waitForFile(marker, 10_000));
    await rejected;
    assertProcessExited(pid);
  } finally {
    await jobs.close();
    await fixture.remove();
  }
});

test('close is idempotent, waits for active process exit, and rejects later jobs', async () => {
  const fixture = await jobFixture();
  const marker = join(fixture.directory, 'close.pid');
  const jobs = new RJobs(fixture.options);
  try {
    const running = jobs.run('hang', { marker });
    const rejected = assert.rejects(running, { code: 'job_closed' });
    const pid = Number(await waitForFile(marker));
    await Promise.all([jobs.close(), jobs.close()]);
    await rejected;
    assertProcessExited(pid);
    await assert.rejects(jobs.run('success', {}), { code: 'job_closed' });
  } finally {
    await jobs.close();
    await fixture.remove();
  }
});

test('invalid timeout options fail before starting a process', () => {
  assert.throws(() => new RJobs({ rscript: 'Rscript', packagePath: '/tmp', timeoutMs: 0 }),
    /timeout must be an integer/);
  assert.throws(() => new RJobs({ rscript: 'Rscript', packagePath: '/tmp', timeoutMs: Number.NaN }),
    /timeout must be an integer/);
});

test('successful R exit retires descendants that inherited job pipes', {
  skip: process.platform === 'win32', timeout: 15_000,
}, async () => {
  const fixture = await jobFixture();
  const marker = join(fixture.directory, 'descendant.pid');
  const jobs = new RJobs({ ...fixture.options, timeoutMs: 5_000 });
  try {
    const result = await jobs.run('descendant', { marker, value: 42 }) as Record<string, unknown>;
    assert.equal(result.value, 42);
    const pid = Number(await readFile(marker, 'utf8'));
    // The subreaper may receive the descendant immediately after R closes.
    const deadline = Date.now() + 2_000;
    while (true) {
      try { assertProcessExited(pid); break; }
      catch (error) { if (Date.now() >= deadline) throw error; }
      await delay(10);
    }
  } finally {
    await jobs.close();
    await fixture.remove();
  }
});

async function jobFixture(): Promise<{
  directory: string;
  options: { rscript: string; packagePath: string };
  remove: () => Promise<void>;
}> {
  const directory = await mkdtemp(join(tmpdir(), 'alder-jobs-'));
  await mkdir(join(directory, 'worker'));
  await writeFile(join(directory, 'worker', 'host-job.R'), worker);
  return {
    directory,
    options: { rscript: process.env.ALDER_RSCRIPT ?? 'Rscript', packagePath: directory },
    remove: () => rm(directory, { recursive: true, force: true }),
  };
}

async function waitForFile(path: string, timeoutMs = 2_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { return await readFile(path, 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await delay(10);
    }
  }
  throw new Error('fixture process did not start');
}

function assertProcessExited(pid: number): void {
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  assert.throws(() => process.kill(pid, 0), (error: unknown) =>
    (error as NodeJS.ErrnoException).code === 'ESRCH');
}

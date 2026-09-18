import { execFileSync, spawn } from 'node:child_process';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function run(command, args, options) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { ...options, stdio: 'inherit' });
    child.once('error', rejectRun);
    child.once('exit', (code, signal) => {
      if (code === 0) resolveRun();
      else rejectRun(new Error(`${command} failed (${code ?? signal})`));
    });
  });
}

// Retired publisher integration remains isolated here until the execution slice
// replaces it. The document application never invokes this build.
export async function buildArk({
  target = `${process.platform}-${process.arch}`,
  output = join(root, 'host/.runtime/ark-build', target),
  sourceArchive,
  archiveOutput,
} = {}) {
  const lock = JSON.parse(await readFile(join(root, 'host/ark-lock.json'), 'utf8'));
  const targetLock = lock.targets[target];
  if (!targetLock) throw new Error(`No Ark build target ${target}`);
  const outputDir = resolve(output);
  const sourcePath = join(outputDir, 'source.tar.gz');
  const sourceDir = join(outputDir, 'source');
  const packageDir = join(outputDir, 'package');
  const artifactPath = resolve(archiveOutput ?? join(outputDir, `ark-${lock.version}-${target}.tar.gz`));
  await mkdir(outputDir, { recursive: true });
  if (sourceArchive) await cp(resolve(sourceArchive), sourcePath);
  else {
    const response = await fetch(lock.sourceArchive.url, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`Ark source download failed (${response.status})`);
    await writeFile(sourcePath, Buffer.from(await response.arrayBuffer()));
  }
  await rm(sourceDir, { recursive: true, force: true });
  await rm(packageDir, { recursive: true, force: true });
  await mkdir(sourceDir);
  await run('tar', ['-xzf', sourcePath, '-C', sourceDir, '--strip-components=1']);
  await run('patch', ['--batch', '--forward', '--strip=1', '--input', resolve(root, lock.patch.path)], { cwd: sourceDir });
  const environment = {
    ...process.env,
    ALDER_ARK_GIT_HASH: lock.baseCommit.slice(0, 7),
    ARK_BUILD_VERSION: lock.version,
    CARGO_TARGET_DIR: join(outputDir, 'target'),
    R_HOME: process.env.R_HOME ?? execFileSync('R', ['RHOME'], { encoding: 'utf8' }).trim(),
  };
  await run('cargo', [`+${lock.rustToolchain}`, 'build', '--locked', '--release', '--package', 'ark', '--target', targetLock.rustTarget], {
    cwd: sourceDir, env: environment,
  });
  await mkdir(packageDir);
  await cp(join(environment.CARGO_TARGET_DIR, targetLock.rustTarget, 'release/ark'), join(packageDir, 'ark'));
  await cp(join(sourceDir, 'LICENSE'), join(packageDir, 'LICENSE'));
  await writeFile(join(packageDir, 'NOTICE'), `Ark ${lock.upstreamVersion}, built for Alder as ${lock.version}.\nIncludes Alder's MIME publisher modifications.\n`);
  await mkdir(dirname(artifactPath), { recursive: true });
  await run('tar', ['-czf', artifactPath, '-C', packageDir, 'ark', 'LICENSE', 'NOTICE']);
  return { artifactPath, version: lock.version, target };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: {
    target: { type: 'string' }, output: { type: 'string' },
    'source-archive': { type: 'string' }, 'archive-output': { type: 'string' },
  } });
  process.stdout.write(JSON.stringify(await buildArk({
    target: values.target, output: values.output,
    sourceArchive: values['source-archive'], archiveOutput: values['archive-output'],
  })) + '\n');
}

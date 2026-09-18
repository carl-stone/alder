import { execFileSync } from 'node:child_process';
import { chmod, cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { buildArk } from './build-ark.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export async function stageArk({ output = join(root, 'host/.runtime'), archive, archiveOutput, arch = process.arch } = {}) {
  if (process.platform !== 'darwin') throw new Error('Ark staging requires macOS');
  const artifactPath = archive ? resolve(archive) : (await buildArk({ target: `darwin-${arch}` })).artifactPath;
  if (archiveOutput) {
    await mkdir(dirname(resolve(archiveOutput)), { recursive: true });
    await cp(artifactPath, resolve(archiveOutput));
  }
  const staging = await mkdtemp(join(tmpdir(), 'alder-ark-stage-'));
  try {
    execFileSync('tar', ['-xzf', artifactPath, '-C', staging]);
    const destination = resolve(output);
    await mkdir(destination, { recursive: true });
    for (const [source, target] of [['ark', 'ark'], ['LICENSE', 'ARK_LICENSE'], ['NOTICE', 'ARK_NOTICE']]) {
      await cp(join(staging, source), join(destination, target));
    }
    await chmod(join(destination, 'ark'), 0o755);
    return { executable: join(destination, 'ark') };
  } finally { await rm(staging, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: {
    output: { type: 'string' }, archive: { type: 'string' },
    'archive-output': { type: 'string' }, arch: { type: 'string' },
  } });
  process.stdout.write(JSON.stringify(await stageArk({
    output: values.output, archive: values.archive,
    archiveOutput: values['archive-output'], arch: values.arch,
  })) + '\n');
}

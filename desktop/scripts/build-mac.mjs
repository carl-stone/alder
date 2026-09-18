import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin') throw new Error('Build Alder on macOS.');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const env = { ...process.env, PATH: `${root}/host/node_modules/node/bin:${process.env.PATH}` };
for (const project of ['js', 'host', 'desktop']) {
  execFileSync('npm', ['run', 'build', '--prefix', project], { cwd: root, env, stdio: 'inherit' });
}
execFileSync(process.execPath, ['host/scripts/stage-application.mjs'], { cwd: root, env, stdio: 'inherit' });

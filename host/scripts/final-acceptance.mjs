import { execFileSync } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin') throw new Error('Final acceptance requires macOS.');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const node = join(root, 'host/node_modules/node/bin/node');
const app = join(root, 'host/.application-desktop/Alder.app');
const applicationRoot = join(app, 'Contents/Resources/alder');
const timings = {};
const environment = { ...process.env, PATH: `${dirname(node)}:${process.env.PATH ?? ''}` };

function run(name, executable, args, options = {}) {
  process.stdout.write(`\n== ${name} ==\n`);
  const started = performance.now();
  execFileSync(executable, args, {
    cwd: root, env: environment, stdio: 'inherit', timeout: 15 * 60_000, ...options,
  });
  timings[name] = Math.round(performance.now() - started);
}

await rm(join(root, 'host/.application-desktop'), { recursive: true, force: true });
await rm(join(root, 'desktop/out'), { recursive: true, force: true });
await rm(join(root, 'desktop/.vite'), { recursive: true, force: true });

run('R helper tests', 'Rscript', ['-e', 'testthat::test_local(stop_on_failure = TRUE)']);
run('fresh signed Mac build', 'npm', ['run', 'build:mac', '--prefix', 'desktop']);
run('signed resources and Ark differential', node, ['host/scripts/accept-mac.mjs', app]);
run('fast host and generative tests', 'npm', ['test', '--prefix', 'host']);

const manifest = JSON.parse(await readFile(join(applicationRoot, 'manifest.json'), 'utf8'));
const quarto = join(applicationRoot, manifest.resources.quartoExecutable);
const rscript = execFileSync('which', ['Rscript'], { encoding: 'utf8', env: environment }).trim();
const installedEnvironment = {
  ...environment,
  ALDER_APPLICATION_ROOT: applicationRoot,
  ALDER_STAGED_ROOT: applicationRoot,
  ALDER_RSCRIPT: rscript,
  ALDER_TEST_RSCRIPT: rscript,
  PATH: `${dirname(quarto)}:${environment.PATH}`,
};
for (const file of ['engine.test.ts', 'jupyter.test.ts', 'host.test.ts', 'mcp-installed.test.ts']) {
  run(`installed ${file}`, node, ['--import', 'tsx', '--test', '--test-concurrency=1', `test/${file}`], {
    cwd: join(root, 'host'), env: installedEnvironment,
  });
}
run('production browser journeys', node, ['--import', 'tsx', '--test', '--test-concurrency=1', 'test/browser.test.ts'], {
  cwd: join(root, 'host'), env: { ...installedEnvironment, ALDER_BROWSER_TEST: '1' }, timeout: 20 * 60_000,
});
run('hidden packaged app journey', node, ['host/scripts/accept-native-app.mjs', app], { timeout: 3 * 60_000 });

let survivors = [];
const auditDeadline = Date.now() + 10_000;
do {
  survivors = execFileSync('/bin/ps', ['-axo', 'pid=,command='], { encoding: 'utf8' })
    .split('\n').map(line => line.trim())
    .filter(line => line && line.includes(applicationRoot) && !line.includes('final-acceptance.mjs'));
  if (survivors.length === 0) break;
  await new Promise(resolveWait => setTimeout(resolveWait, 100));
} while (Date.now() < auditDeadline);
if (survivors.length > 0) throw new Error(`packaged child processes survived acceptance:\n${survivors.join('\n')}`);

process.stdout.write(`\n${JSON.stringify({ app, signing: 'codesign --deep --strict verified', processAudit: 'clean', timings })}\n`);

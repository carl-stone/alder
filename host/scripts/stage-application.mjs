import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createRequire } from 'node:module';
import { stageArk } from './fetch-ark.mjs';
import { stageAir } from './fetch-air.mjs';
import { tmpdir } from 'node:os';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { values } = parseArgs({ options: {
  output: { type: 'string', default: join(root, 'host/.application-desktop') },
  kind: { type: 'string', default: 'desktop' },
  'forge-output': { type: 'string', default: join(root, `desktop/out/Alder-darwin-${process.arch}/Alder.app`) },
  node: { type: 'string', default: join(root, 'host/node_modules/node/bin/node') },
  'no-sign': { type: 'boolean', default: false },
} });
if (process.platform !== 'darwin') throw new Error('The local application build requires macOS.');
if (!['desktop', 'headless'].includes(values.kind)) throw new Error('--kind must be desktop or headless');
const output = resolve(values.output);
if (await stat(output).catch(() => null)) {
  const previous = values.kind === 'desktop' ? join(output, 'Alder.app/Contents/Info.plist') : join(output, 'manifest.json');
  if (!await stat(previous).catch(() => null)) throw new Error(`Output is not a staged Alder application: ${output}`);
}
const temporary = output + `.building-${process.pid}`;
await mkdir(dirname(output), { recursive: true });
await rm(temporary, { recursive: true, force: true });
await mkdir(temporary);
try {
  let applicationRoot = temporary;
  if (values.kind === 'desktop') {
    const forge = resolve(values['forge-output']);
    const source = basename(forge) === 'Contents' ? dirname(forge) : forge;
    await cp(source, join(temporary, 'Alder.app'), { recursive: true, verbatimSymlinks: true });
    const infoPlist = join(temporary, 'Alder.app/Contents/Info.plist');
    for (const key of ['NSAppTransportSecurity', 'NSAudioCaptureUsageDescription', 'NSBluetoothAlwaysUsageDescription', 'NSBluetoothPeripheralUsageDescription', 'NSCameraUsageDescription', 'NSMicrophoneUsageDescription']) {
      try { execFileSync('/usr/bin/plutil', ['-remove', key, infoPlist]); } catch {}
    }
    applicationRoot = join(temporary, 'Alder.app/Contents/Resources/alder');
    await rm(applicationRoot, { recursive: true, force: true });
  }
  await mkdir(join(applicationRoot, 'bin'), { recursive: true });
  await cp(join(root, 'inst/host'), join(applicationRoot, 'host'), { recursive: true });
  await cp(join(root, 'inst/app/static'), join(applicationRoot, 'app'), { recursive: true });
  await cp(join(root, 'inst/app/index.html'), join(applicationRoot, 'app/index.html'));
  await cp(join(root, 'inst/worker'), join(applicationRoot, 'worker'), { recursive: true });
  await cp(resolve(values.node), join(applicationRoot, 'bin/node'));
  await chmod(join(applicationRoot, 'bin/node'), 0o755);
  await cp(join(root, 'host/licenses/Node.txt'), join(applicationRoot, 'host/licenses/Node.txt'));
  await stageArk({ output: join(applicationRoot, 'runtime') });
  await stageAir({ output: join(applicationRoot, 'runtime') });
  const packageMetadata = JSON.parse(await readFile(join(root, 'host/package.json'), 'utf8'));
  const quartoLauncher = await realpath(process.env.ALDER_QUARTO ?? execFileSync('which', ['quarto'], { encoding: 'utf8' }).trim());
  const quartoRoot = dirname(dirname(quartoLauncher));
  const quartoVersion = (await readFile(join(quartoRoot, 'share/version'), 'utf8')).trim();
  if (quartoVersion !== packageMetadata.config.quarto.version) throw new Error(`Quarto ${packageMetadata.config.quarto.version} is required; found ${quartoVersion}`);
  const quartoArch = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
  const quartoTarget = `darwin-${process.arch}`;
  const quartoHash = await hashDistribution(quartoRoot, ['bin/quarto', 'bin/quarto.js', `bin/tools/${quartoArch}`, 'share']);
  if (quartoHash !== packageMetadata.config.quarto.sha256[quartoTarget]) throw new Error(`Quarto distribution checksum mismatch for ${quartoTarget}`);
  for (const notice of ['share/COPYING.md', 'share/COPYRIGHT']) {
    if (!(await stat(join(quartoRoot, notice)).catch(() => null))?.isFile()) throw new Error(`Quarto distribution is missing ${notice}`);
  }
  const stagedQuarto = join(applicationRoot, 'runtime/quarto');
  await mkdir(join(stagedQuarto, 'bin/tools'), { recursive: true });
  await cp(join(quartoRoot, 'bin/quarto'), join(stagedQuarto, 'bin/quarto'));
  await cp(join(quartoRoot, 'bin/quarto.js'), join(stagedQuarto, 'bin/quarto.js'));
  await cp(join(quartoRoot, 'bin/tools', quartoArch), join(stagedQuarto, 'bin/tools', quartoArch), { recursive: true });
  await symlink(`${quartoArch}/pandoc`, join(stagedQuarto, 'bin/tools/pandoc'));
  await cp(join(quartoRoot, 'share'), join(stagedQuarto, 'share'), { recursive: true });
  await chmod(join(stagedQuarto, 'bin/quarto'), 0o755);
  const rPackageBuild = await mkdtemp(join(tmpdir(), 'alder-r-package-'));
  try {
    execFileSync('R', ['--slave', '--vanilla', '-e',
      'if (getRversion() < "4.6.0" || getRversion() >= "4.7.0") stop("Alder requires R 4.6.x for its bundled helper")'],
    { stdio: 'inherit' });
    // The app ships only the R helper package. Building from the repository
    // would copy generated app bundles and node_modules into R's temporary tree.
    const packageSource = join(rPackageBuild, 'alder');
    await mkdir(packageSource);
    for (const entry of ['DESCRIPTION', 'NAMESPACE', 'LICENSE', 'README.md', 'R', 'man', 'inst/examples']) {
      await cp(join(root, entry), join(packageSource, entry), { recursive: true });
    }
    execFileSync('R', ['CMD', 'build', packageSource, '--no-build-vignettes', '--no-manual'], {
      cwd: rPackageBuild, stdio: 'inherit',
    });
    const archives = (await readdir(rPackageBuild)).filter(name => /^alder_[^/]+[.]tar[.]gz$/.test(name));
    if (archives.length !== 1) throw new Error('R package build did not produce one Alder archive');
    const library = join(applicationRoot, 'r-library');
    await mkdir(library);
    execFileSync('Rscript', ['--vanilla', '-e', [
      'library <- commandArgs(TRUE)[[1L]]',
      'packages <- c("codetools", "jsonlite", "mime", "rlang")',
      'install.packages(packages, lib=library, repos="https://cloud.r-project.org", dependencies=c("Depends", "Imports", "LinkingTo"))',
      'missing <- packages[!vapply(packages, requireNamespace, logical(1), quietly=TRUE, lib.loc=library)]',
      'if (length(missing)) stop("private R dependencies are missing: ", paste(missing, collapse=", "))',
    ].join('; '), library], { stdio: 'inherit' });
    execFileSync('R', ['CMD', 'INSTALL', `--library=${library}`, join(rPackageBuild, archives[0])], {
      stdio: 'inherit',
    });
  } finally {
    await rm(rPackageBuild, { recursive: true, force: true });
  }
  // Preserve the package loaders but ship only the native Mac runtime.
  for (const name of ['zeromq', 'cmake-ts']) {
    const source = join(root, 'host/node_modules', name);
    const destination = join(applicationRoot, 'host/node_modules', name);
    await cp(source, destination, { recursive: true, filter: path => !/\/(?:test|tests|vendor|src|script)(?:\/|$)/.test(path) });
    const hasNotice = (await readdir(destination)).some(name => /^(licen[cs]e|copying|notice)([.\-_]|$)/i.test(name));
    if (!hasNotice) {
      const pkg = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
      await cp(join(root, 'host/licenses', `${name}@${pkg.version}`, 'LICENSE'), join(destination, 'LICENSE'));
    }
    if (name === 'zeromq') {
      for (const platform of ['linux', 'win32']) await rm(join(destination, 'build', platform), { recursive: true, force: true });
      const nativeManifestPath = join(destination, 'build/manifest.json');
      const nativeManifest = JSON.parse(await readFile(nativeManifestPath, 'utf8'));
      await writeFile(nativeManifestPath, JSON.stringify(Object.fromEntries(Object.entries(nativeManifest).filter(([key]) => {
        const target = JSON.parse(key);
        return target.os === 'darwin' && target.arch === process.arch;
      }))));
      await rm(join(destination, 'build/darwin', process.arch === 'arm64' ? 'x64' : 'arm64'), { recursive: true, force: true });
    }
  }
  const require = createRequire(join(applicationRoot, 'host/package.json'));
  const socket = new (require('zeromq').Dealer)();
  socket.close();
  const pkg = packageMetadata;
  const manifest = {
    schemaVersion: 1, kind: values.kind, applicationVersion: pkg.version,
    resources: {
      cliLauncher: 'bin/alder', hostEntry: 'host/alder-host.mjs', rendererDirectory: 'app',
      workerDirectory: 'worker', rLibraryDirectory: 'r-library', arkExecutable: 'runtime/ark',
      airExecutable: 'runtime/air', quartoExecutable: 'runtime/quarto/bin/quarto', nodeExecutable: 'bin/node',
      electronEntry: values.kind === 'desktop' ? 'desktop' : null,
    },
  };
  // Optional services can be added independently of the execution kernel.
  await writeFile(join(applicationRoot, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  const launcher = '#!/bin/sh\nroot=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)\nexec "$root/bin/node" "$root/host/alder-host.mjs" "$@"\n';
  await writeFile(join(applicationRoot, 'bin/alder'), launcher, { mode: 0o755 });
  if (values.kind === 'desktop') {
    await writeFile(join(applicationRoot, 'desktop'), '#!/bin/sh\nroot=$(CDPATH= cd -- "$(dirname -- "$0")/../../MacOS" && pwd)\nexec "$root/Alder" "$@"\n', { mode: 0o755 });
    if (!values['no-sign']) execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', join(temporary, 'Alder.app')], { stdio: 'inherit' });
  }
  await rm(output, { recursive: true, force: true });
  await rename(temporary, output);
  process.stdout.write((values.kind === 'desktop' ? join(output, 'Alder.app') : join(output, 'bin/alder')) + '\n');
} catch (error) {
  await rm(temporary, { recursive: true, force: true });
  throw error;
}

async function hashDistribution(directory, entries) {
  const files = [];
  const walk = async path => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) await walk(child);
      else if (entry.isFile()) files.push(child);
    }
  };
  for (const entry of entries) {
    const path = join(directory, entry);
    if ((await stat(path)).isDirectory()) await walk(path);
    else files.push(path);
  }
  files.sort((left, right) => relative(directory, left).localeCompare(relative(directory, right)));
  const digest = createHash('sha256');
  for (const file of files) {
    digest.update(relative(directory, file));
    digest.update('\0');
    for await (const chunk of createReadStream(file)) digest.update(chunk);
    digest.update('\0');
  }
  return digest.digest('hex');
}

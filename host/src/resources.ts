import { createHash } from "node:crypto";
import { execFile } from 'node:child_process';
import { createReadStream } from "node:fs";
import { lstat, readFile, readdir, readlink, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { platform as hostPlatform } from "node:os";

import { parseStrictJson } from "./strict-json.js";
import { promisify } from 'node:util';
import { ENGINE_PROTOCOL, HOST_PROTOCOL } from "./protocol.js";

export type ManifestPlatform = "linux" | "darwin" | "win32";
export type ManifestKind = "desktop" | "headless";

export interface ManifestResourcePaths {
  cliLauncher: string;
  hostEntry: string;
  rendererDirectory: string;
  workerDirectory: string;
  rLibraryDirectory: string;
  arkExecutable: string;
  airExecutable: string;
  nodeExecutable: string;
  processSupervisorExecutable: string;
  electronEntry: string | null;
}

export interface ManifestFile {
  path: string;
  bytes: number;
  sha256: string;
}

export interface ManifestSymlink {
  path: string;
  target: string;
}

export interface ManifestRPackage {
  name: string;
  version: string;
  builtR: string;
  platform: string;
  license: string;
}

export interface ManifestArkRuntime {
  upstreamVersion: string;
  buildVersion: string;
  baseCommit: string;
  patchSha256: string;
  mimePublisher: "alder-json-v1";
}

interface ProcessSupervisorProducer {
  toolchain: "rust-1.95.0";
  rustc: string;
  cargo: string;
  command: "cargo +1.95.0 build --locked --release --manifest-path host/native/process-supervisor/Cargo.toml";
}

export interface ApplicationManifest {
  schemaVersion: 1;
  kind: ManifestKind;
  applicationVersion: string;
  sourceCommit: string;
  sourceTreeSha256: string;
  hostProtocol: "alder-host-v2";
  engineProtocol: "alder-engine-v2";
  target: { platform: ManifestPlatform; arch: string };
  rVersionRange: ">=4.6.0 <4.7.0";
  qualifiedRPatchVersions: string[];
  rBuildVersion: string;
  resources: ManifestResourcePaths;
  runtimes: {
    node: string;
    ark: ManifestArkRuntime;
    air: string;
    electron: string | null;
    chromium: string | null;
    electronNode: string | null;
  };
  files: ManifestFile[];
  symlinks: ManifestSymlink[];
  rPackages: ManifestRPackage[];
}

export interface ApplicationResources {
  readonly manifest?: ApplicationManifest;
  root: string;
  cliLauncher: string;
  hostEntry: string;
  rendererDirectory: string;
  workerDirectory: string;
  rLibraryDirectory: string;
  arkExecutable: string;
  airExecutable: string;
  nodeExecutable: string;
  processSupervisorExecutable: string;
  electronEntry: string | null;
}

export class ResourceValidationError extends Error {
  readonly code = "resource_invalid" as const;

  constructor(message: string) {
    super(message);
    this.name = "ResourceValidationError";
  }
}

const MANIFEST_SCHEMA_VERSION = 1;
const R_VERSION_RANGE = ">=4.6.0 <4.7.0";
const HELPER_BUILD_VERSION = "4.6.1";
const SOURCE_COMMIT = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const WINDOWS_EXECUTABLE = /\.(?:exe|cmd)$/i;
const POSIX_EXECUTABLE = /(?:^|\/)bin\/(?:alder|node|ark|air|alder-process-supervisor)$/;

const SUPERVISOR_TOOLCHAIN = "rust-1.95.0";
const SUPERVISOR_COMMAND = "cargo +1.95.0 build --locked --release --manifest-path host/native/process-supervisor/Cargo.toml";
const SUPERVISOR_PROVENANCE_RELATIVE_PATH = "host/locks/process-supervisor-provenance.json";
type ManifestRecord = Record<string, unknown>;
type FileIdentity = { dev: number; ino: number };
const verifiedResources = new WeakSet<ApplicationResources>();
const executeFile = promisify(execFile);

export async function resolveApplicationResources(root: string): Promise<ApplicationResources> {
  const physicalRoot = await existingDirectory(root, "application root");
  const { manifest, baseDirectory, rootIdentity } = await readManifest(physicalRoot);
  if (manifest.target.platform !== hostPlatform() || manifest.target.arch !== process.arch) {
    throw new ResourceValidationError(
      `manifest target ${manifest.target.platform}/${manifest.target.arch} does not match ${hostPlatform()}/${process.arch}`,
    );
  }

  const resolved = {
    manifest,
    root: physicalRoot,
    cliLauncher: await resolveManifestFile(physicalRoot, manifest.resources.cliLauncher, "CLI launcher"),
    hostEntry: await resolveManifestFile(physicalRoot, manifest.resources.hostEntry, "host entry"),
    rendererDirectory: await resolveManifestDirectory(physicalRoot, manifest.resources.rendererDirectory, "renderer directory"),
    workerDirectory: await resolveManifestDirectory(physicalRoot, manifest.resources.workerDirectory, "worker directory"),
    rLibraryDirectory: await resolveManifestDirectory(physicalRoot, manifest.resources.rLibraryDirectory, "R library directory"),
    arkExecutable: await resolveManifestFile(physicalRoot, manifest.resources.arkExecutable, "Ark executable"),
    airExecutable: await resolveManifestFile(physicalRoot, manifest.resources.airExecutable, "Air executable"),
    nodeExecutable: await resolveManifestFile(physicalRoot, manifest.resources.nodeExecutable, "Node executable"),
    processSupervisorExecutable: await resolveManifestFile(
      physicalRoot,
      manifest.resources.processSupervisorExecutable,
      "process supervisor executable",
    ),
    electronEntry: manifest.resources.electronEntry === null
      ? null
      : await resolveManifestFile(physicalRoot, manifest.resources.electronEntry, "Electron executable"),
  } satisfies ApplicationResources;

  if (manifest.kind === "headless" && resolved.electronEntry !== null) {
    throw new ResourceValidationError("headless manifest must not declare an Electron executable");
  }
  if (manifest.kind === "desktop" && resolved.electronEntry === null) {
    throw new ResourceValidationError("desktop manifest requires an Electron executable");
  }
  await validateExecutablePath(resolved.cliLauncher, "CLI launcher");
  for (const [label, path] of [
    ["Ark executable", resolved.arkExecutable],
    ["Air executable", resolved.airExecutable],
    ["Node executable", resolved.nodeExecutable],
    ["process supervisor executable", resolved.processSupervisorExecutable],
  ] as const) await validateExecutablePath(path, label);
  if (resolved.electronEntry !== null) await validateExecutablePath(resolved.electronEntry, "Electron executable");

  await verifyInventory(physicalRoot, baseDirectory, manifest, rootIdentity);
  await verifyProcessSupervisor(physicalRoot, baseDirectory, manifest);
  await assertRootIdentity(physicalRoot, rootIdentity);
  verifiedResources.add(resolved);
  return resolved;
}

export async function verifiedApplicationManifest(resources: ApplicationResources): Promise<ApplicationManifest> {
  if (verifiedResources.has(resources) && resources.manifest !== undefined) return resources.manifest;
  return readApplicationManifest(resources.root);
}

export async function readApplicationManifest(root: string): Promise<ApplicationManifest> {
  const physicalRoot = await existingDirectory(root, "application root");
  const { manifest, baseDirectory, rootIdentity } = await readManifest(physicalRoot);
  await verifyInventory(physicalRoot, baseDirectory, manifest, rootIdentity);
  await verifyProcessSupervisor(physicalRoot, baseDirectory, manifest);
  await assertRootIdentity(physicalRoot, rootIdentity);
  if (manifest.target.platform !== hostPlatform() || manifest.target.arch !== process.arch) {
    throw invalid(`manifest target ${manifest.target.platform}/${manifest.target.arch} does not match ${hostPlatform()}/${process.arch}`);
  }
  return manifest;
}

export function validateApplicationManifest(value: unknown): ApplicationManifest {
  const record = object(value, "manifest");
  exactKeys(record, [
    "schemaVersion", "kind", "applicationVersion", "sourceCommit", "sourceTreeSha256",
    "hostProtocol", "engineProtocol", "target", "rVersionRange", "qualifiedRPatchVersions",
    "rBuildVersion", "resources", "runtimes", "files", "symlinks", "rPackages",
  ], "manifest");
  if (record.schemaVersion !== MANIFEST_SCHEMA_VERSION) throw invalid("manifest.schemaVersion must be 1");
  const kind = oneOf(record.kind, ["desktop", "headless"], "manifest.kind") as ManifestKind;
  const applicationVersion = nonempty(record.applicationVersion, "manifest.applicationVersion");
  const sourceCommit = commit(record.sourceCommit, "manifest.sourceCommit");
  const sourceTreeSha256 = hash(record.sourceTreeSha256, "manifest.sourceTreeSha256");
  if (record.hostProtocol !== HOST_PROTOCOL) throw invalid(`manifest.hostProtocol must be ${HOST_PROTOCOL}`);
  if (record.engineProtocol !== ENGINE_PROTOCOL) throw invalid(`manifest.engineProtocol must be ${ENGINE_PROTOCOL}`);
  const target = object(record.target, "manifest.target");
  exactKeys(target, ["platform", "arch"], "manifest.target");
  const platform = oneOf(target.platform, ["linux", "darwin", "win32"], "manifest.target.platform") as ManifestPlatform;
  const arch = nonempty(target.arch, "manifest.target.arch");
  if (record.rVersionRange !== R_VERSION_RANGE) throw invalid(`manifest.rVersionRange must be ${R_VERSION_RANGE}`);
  const qualifiedRPatchVersions = stringArray(record.qualifiedRPatchVersions, "manifest.qualifiedRPatchVersions");
  if (new Set(qualifiedRPatchVersions).size !== qualifiedRPatchVersions.length) {
    throw invalid("manifest.qualifiedRPatchVersions must not contain duplicates");
  }
  if (!qualifiedRPatchVersions.includes("4.6.0") || !qualifiedRPatchVersions.includes("4.6.1")) {
    throw invalid("manifest.qualifiedRPatchVersions must include both 4.6.0 and 4.6.1");
  }
  const rBuildVersion = nonempty(record.rBuildVersion, "manifest.rBuildVersion");
  if (rBuildVersion !== HELPER_BUILD_VERSION) {
    throw invalid(`manifest.rBuildVersion must be ${HELPER_BUILD_VERSION}`);
  }
  const resources = resourcePaths(record.resources);
  const runtimes = runtimePaths(record.runtimes);
  if (kind === "desktop") {
    if (resources.electronEntry === null) throw invalid("desktop manifest.resources.electronEntry must be present");
    for (const [name, value] of [["electron", runtimes.electron], ["chromium", runtimes.chromium], ["electronNode", runtimes.electronNode]] as const) {
      if (value === null) throw invalid(`desktop manifest.runtimes.${name} must be present`);
    }
  } else {
    if (resources.electronEntry !== null) throw invalid("headless manifest.resources.electronEntry must be null");
    if (runtimes.electron !== null || runtimes.chromium !== null || runtimes.electronNode !== null) {
      throw invalid("headless manifest Electron runtime identities must be null");
    }
  }
  const files = manifestFiles(record.files);
  const symlinks = manifestSymlinks(record.symlinks);
  const rPackages = manifestPackages(record.rPackages);
  return {
    schemaVersion: 1,
    kind,
    applicationVersion,
    sourceCommit,
    sourceTreeSha256,
    hostProtocol: HOST_PROTOCOL,
    engineProtocol: ENGINE_PROTOCOL,
    target: { platform, arch },
    rVersionRange: R_VERSION_RANGE,
    qualifiedRPatchVersions,
    rBuildVersion,
    resources,
    runtimes,
    files,
    symlinks,
    rPackages,
  };
}


async function readManifest(root: string): Promise<{ manifest: ApplicationManifest; baseDirectory: string; rootIdentity: FileIdentity }> {
  const rootInfo = await lstat(root).catch((error) => {
    throw invalid("application root is unavailable: " + messageOf(error));
  });
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw invalid("application root must be a real directory");
  const rootIdentity = fileIdentity(rootInfo);
  const baseDirectory = await resolveWithinRoot(
    root,
    process.platform === "darwin" && basename(root) === "Contents" ? "Resources" : "resources",
    "application resources",
  );
  const manifestPath = join(baseDirectory, "manifest.json");
  const manifestInfo = await lstat(manifestPath).catch((error) => {
    throw invalid("application manifest is unavailable: " + manifestPath + ": " + messageOf(error));
  });
  if (manifestInfo.isSymbolicLink()) throw invalid("application manifest must not be a symbolic link");
  if (!manifestInfo.isFile()) throw invalid("application manifest is not a regular file: " + manifestPath);
  if (manifestInfo.nlink > 1) throw invalid("application manifest must not be hard linked");
  let bytes: Buffer;
  try {
    bytes = await readFile(manifestPath);
  } catch (error) {
    throw invalid("application manifest is unavailable: " + manifestPath + ": " + messageOf(error));
  }
  let value: unknown;
  try {
    value = parseStrictJson(bytes, { maxBytes: 8 * 1024 * 1024, maxDepth: 64 });
  } catch (error) {
    throw invalid("application manifest is invalid: " + messageOf(error));
  }
  return { manifest: validateApplicationManifest(value), baseDirectory, rootIdentity };
}

async function verifyInventory(root: string, baseDirectory: string, manifest: ApplicationManifest, expectedRoot: FileIdentity): Promise<void> {
  await assertRootIdentity(root, expectedRoot);
  const signatureDirectory = manifest.kind === 'desktop' && manifest.target.platform === 'darwin'
    ? await lstat(join(root, '_CodeSignature')).catch(() => null)
    : null;
  if (signatureDirectory && (!signatureDirectory.isDirectory() || signatureDirectory.isSymbolicLink())) throw invalid('macOS outer signature envelope is not a real directory');
  const outerSignature = signatureDirectory
    ? await lstat(join(root, '_CodeSignature', 'CodeResources')).catch(() => null)
    : null;
  const allowOuterSignature = outerSignature?.isFile() === true && !outerSignature.isSymbolicLink() && outerSignature.nlink === 1;
  if (signatureDirectory && !allowOuterSignature) throw invalid('macOS outer signature resource is not a regular, singly-linked file');
  if (allowOuterSignature) await verifyMacOSBundleSignature(root);
  const declared = new Map<string, ManifestFile>();
  for (const file of manifest.files) {
    if (declared.has(file.path)) throw invalid("manifest.files contains duplicate path " + file.path);
    declared.set(file.path, file);
  }
  const declaredSymlinks = new Map<string, ManifestSymlink>();
  for (const symlink of manifest.symlinks) {
    if (declared.has(symlink.path)) throw invalid("manifest symlink path overlaps a file " + symlink.path);
    if (declaredSymlinks.has(symlink.path)) throw invalid("manifest.symlinks contains duplicate path " + symlink.path);
    declaredSymlinks.set(symlink.path, symlink);
  }
  const manifestRelative = relativePath(root, join(baseDirectory, "manifest.json"));
  if (declared.has(manifestRelative) || declaredSymlinks.has(manifestRelative)) throw invalid("manifest.json must not be included in its own file inventory");
  const outerExecutable = allowOuterSignature ? manifest.resources.electronEntry ?? undefined : undefined;
  if (outerExecutable) {
    if (declared.has(outerExecutable) || declaredSymlinks.has(outerExecutable)) throw invalid('verified macOS outer executable must not be included in the application manifest');
    const outerExecutablePath = join(root, outerExecutable);
    const outerExecutableInfo = await lstat(outerExecutablePath).catch(() => null);
    if (!outerExecutableInfo?.isFile() || outerExecutableInfo.isSymbolicLink() || outerExecutableInfo.nlink !== 1) throw invalid('verified macOS outer executable is not a regular, singly-linked file');
    await resolvePhysicalWithinRoot(root, outerExecutablePath, 'verified macOS outer executable');
  }
  const discovered = new Set<string>();
  const discoveredSymlinks = new Map<string, string>();
  await collectFiles(root, root, discovered, discoveredSymlinks, new Set<string>(), manifestRelative, allowOuterSignature, outerExecutable);
  if (discovered.size !== declared.size || [...discovered].some((path) => !declared.has(path))) {
    const missing = [...discovered].filter((path) => !declared.has(path));
    const extra = [...declared.keys()].filter((path) => !discovered.has(path));
    throw invalid("manifest file inventory mismatch (missing declarations: " + (missing.join(", ") || "none") + "; extra declarations: " + (extra.join(", ") || "none") + ")");
  }
  if (discoveredSymlinks.size !== declaredSymlinks.size || [...discoveredSymlinks].some(([path, target]) => declaredSymlinks.get(path)?.target !== target)) {
    const missing = [...discoveredSymlinks].filter(([path, target]) => declaredSymlinks.get(path)?.target !== target).map(([path]) => path);
    const extra = [...declaredSymlinks.keys()].filter((path) => discoveredSymlinks.get(path) !== declaredSymlinks.get(path)?.target);
    throw invalid("manifest symlink inventory mismatch (missing declarations: " + (missing.join(", ") || "none") + "; extra declarations: " + (extra.join(", ") || "none") + ")");
  }
  for (const [path, expected] of declared) {
    await resolveWithinRoot(root, path, "manifest file");
    await verifyFile(root, join(root, path), expected);
  }
  for (const [path, expected] of declaredSymlinks) {
    await resolveWithinRoot(root, path, "manifest symlink");
    await verifySymlink(root, join(root, path), expected);
  }
  await assertRootIdentity(root, expectedRoot);
}

async function verifyProcessSupervisor(root: string, baseDirectory: string, manifest: ApplicationManifest): Promise<void> {
  const binary = manifest.files.find(file => file.path === manifest.resources.processSupervisorExecutable);
  if (binary === undefined) throw invalid("manifest is missing the process supervisor inventory entry");
  const descriptorPath = join(baseDirectory, SUPERVISOR_PROVENANCE_RELATIVE_PATH);
  const descriptorRelativePath = relativePath(root, descriptorPath);
  const descriptor = manifest.files.find(file => file.path === descriptorRelativePath);
  if (descriptor === undefined) throw invalid("manifest is missing the process supervisor provenance inventory entry");
  const binaryPath = await resolveManifestFile(root, manifest.resources.processSupervisorExecutable, "process supervisor executable");
  const descriptorInfo = await lstat(descriptorPath).catch((error) => { throw invalid("process supervisor provenance is unavailable: " + messageOf(error)); });
  if (!descriptorInfo.isFile() || descriptorInfo.isSymbolicLink() || descriptorInfo.nlink !== 1) {
    throw invalid("process supervisor provenance must be a regular, singly-linked file");
  }
  await verifyFile(root, binaryPath, binary);
  await verifyFile(root, descriptorPath, descriptor);
  let value: unknown;
  try {
    value = parseStrictJson(await readFile(descriptorPath), { maxBytes: 1024 * 1024, maxDepth: 32 });
  } catch (error) {
    throw invalid("process supervisor provenance is invalid: " + messageOf(error));
  }
  const provenance = supervisorProvenance(value);
  if (provenance.artifact.sha256 !== binary.sha256) {
    throw invalid("process supervisor provenance hash does not match its inventory entry");
  }
}
async function verifyMacOSBundleSignature(root: string): Promise<void> {
  if (hostPlatform() !== 'darwin' || basename(root) !== 'Contents') throw invalid('signed resources require a macOS application bundle');
  try {
    await executeFile('/usr/bin/codesign', ['--verify', '--deep', '--strict', dirname(root)], { maxBuffer: 256 * 1024 });
  } catch (error) {
    throw invalid('macOS application signature verification failed: ' + messageOf(error));
  }
}

async function collectFiles(root: string, directory: string, result: Set<string>, symlinks: Map<string, string>, visited: Set<string>, excludedPath?: string, allowOuterSignature = false, outerExecutable?: string): Promise<void> {
  const physical = await resolvePhysicalWithinRoot(root, directory, 'manifest inventory directory');
  const directoryInfo = await lstat(directory).catch((error) => { throw invalid('manifest inventory directory is unavailable: ' + directory + ': ' + messageOf(error)); });
  if (directoryInfo.isSymbolicLink()) throw invalid('manifest inventory directory is a symbolic link: ' + relativePath(root, directory));
  if (!directoryInfo.isDirectory()) throw invalid('manifest inventory root is not a directory: ' + relativePath(root, directory));
  if (visited.has(physical)) return;
  visited.add(physical);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const relativeEntry = relativePath(root, path);
    if (allowOuterSignature && (relativeEntry === '_CodeSignature' || relativeEntry === outerExecutable)) continue;
    const info = await lstat(path).catch((error) => { throw invalid('manifest inventory entry is unavailable: ' + relativeEntry + ': ' + messageOf(error)); });
    if (info.isSymbolicLink()) {
      await resolvePhysicalWithinRoot(root, path, 'manifest inventory symlink');
      const targetInfo = await stat(path).catch((error) => { throw invalid('manifest inventory symlink target is unavailable: ' + relativeEntry + ': ' + messageOf(error)); });
      if (targetInfo.isDirectory()) {
        if (relativeEntry !== excludedPath) symlinks.set(relativeEntry, await readlink(path));
      } else if (relativeEntry !== excludedPath) result.add(relativeEntry);
    } else if (info.isDirectory()) await collectFiles(root, path, result, symlinks, visited, excludedPath, allowOuterSignature, outerExecutable);
    else if (info.isFile()) {
      if (relativeEntry === excludedPath) continue;
      if (info.nlink > 1) throw invalid('manifest inventory entry is hard linked: ' + relativeEntry);
      result.add(relativeEntry);
    } else throw invalid('manifest inventory entry is not a regular file or symbolic link: ' + relativeEntry);
  }
}

async function verifyFile(root: string, path: string, expected: ManifestFile): Promise<void> {
  let info;
  try { info = await lstat(path); } catch (error) { throw invalid('manifest file is unavailable: ' + expected.path + ': ' + messageOf(error)); }
  if (info.isSymbolicLink()) {
    const physical = await resolvePhysicalWithinRoot(root, path, 'manifest file symlink', expected.path);
    info = await lstat(physical).catch((error) => { throw invalid('manifest file is unavailable: ' + expected.path + ': ' + messageOf(error)); });
  }
  if (!info.isFile()) throw invalid('manifest file is not regular: ' + expected.path);
  if (info.nlink > 1) throw invalid('manifest file is hard linked: ' + expected.path);
  if (!Number.isSafeInteger(expected.bytes) || expected.bytes < 0 || info.size !== expected.bytes) throw invalid('manifest file byte count mismatch: ' + expected.path);
  const digest = createHash('sha256');
  let bytes = 0;
  try { for await (const chunk of createReadStream(path)) { bytes += chunk.length; digest.update(chunk); } } catch (error) { throw invalid('manifest file cannot be read: ' + expected.path + ': ' + messageOf(error)); }
  if (bytes !== expected.bytes || digest.digest('hex') !== expected.sha256) throw invalid('manifest file SHA-256 mismatch: ' + expected.path);
}

async function verifySymlink(root: string, path: string, expected: ManifestSymlink): Promise<void> {
  const info = await lstat(path).catch((error) => { throw invalid('manifest symlink is unavailable: ' + expected.path + ': ' + messageOf(error)); });
  if (!info.isSymbolicLink()) throw invalid('manifest symlink is not symbolic: ' + expected.path);
  await resolvePhysicalWithinRoot(root, path, 'manifest symlink', expected.path);
  const target = await readlink(path).catch((error) => { throw invalid('manifest symlink target is unavailable: ' + expected.path + ': ' + messageOf(error)); });
  if (target !== expected.target) throw invalid('manifest symlink target mismatch: ' + expected.path);
  const targetInfo = await stat(path).catch((error) => { throw invalid('manifest symlink target is unavailable: ' + expected.path + ': ' + messageOf(error)); });
  if (!targetInfo.isDirectory()) throw invalid('manifest symlink target is not a directory: ' + expected.path);
}

async function resolveManifestFile(root: string, path: string, label: string): Promise<string> {
  const resolved = await resolveWithinRoot(root, path, label);
  const info = await stat(resolved);
  if (!info.isFile()) throw invalid(`${label} is not a regular file: ${path}`);
  return resolved;
}

async function resolveManifestDirectory(root: string, path: string, label: string): Promise<string> {
  const resolved = await resolveWithinRoot(root, path, label);
  const info = await stat(resolved);
  if (!info.isDirectory()) throw invalid(`${label} is not a directory: ${path}`);
  return resolved;
}

async function resolveWithinRoot(root: string, path: string, label: string): Promise<string> {
  validateRelativePath(path, label);
  const candidate = resolve(root, path);
  return resolvePhysicalWithinRoot(root, candidate, label, path);
}

async function resolvePhysicalWithinRoot(root: string, path: string, label: string, displayPath = path): Promise<string> {
  const physical = await realpath(path).catch((error) => {
    throw invalid(`${label} is unavailable: ${displayPath}: ${messageOf(error)}`);
  });
  const relativeTarget = relative(root, physical);
  if (relativeTarget === ".." || relativeTarget.startsWith(`..${sep}`) || isAbsolute(relativeTarget)) {
    throw invalid(`${label} escapes application root: ${displayPath}`);
  }
  return physical;
}

async function existingDirectory(path: string, label: string): Promise<string> {
  if (typeof path !== "string" || !path) throw invalid(label + " must be a nonempty path");
  const candidate = resolve(path);
  const info = await lstat(candidate).catch((error) => {
    throw invalid(label + " is unavailable: " + messageOf(error));
  });
  if (info.isSymbolicLink()) throw invalid(label + " must not be a symbolic link: " + path);
  if (!info.isDirectory()) throw invalid(label + " is not a directory: " + path);
  return await realpath(candidate).catch((error) => {
    throw invalid(label + " is unavailable: " + messageOf(error));
  });
}

function validateRelativePath(value: string, label: string): void {
  if (typeof value !== "string" || !value || value.includes("\\") || value.includes("\0") || value.startsWith("/")) {
    throw invalid(`${label} must be a slash-separated relative path`);
  }
  const parts = value.split("/");
  if (parts.some((part) => part.length === 0 || part === "." || part === "..")) {
    throw invalid(`${label} contains an unsafe path segment`);
  }
}

async function validateExecutablePath(path: string, label: string): Promise<void> {
  if (process.platform === "win32") {
    if (!WINDOWS_EXECUTABLE.test(path) && !POSIX_EXECUTABLE.test(path)) {
      throw invalid(label + " has an invalid Windows executable suffix: " + path);
    }
    return;
  }
  const info = await stat(path);
  if ((info.mode & 0o111) === 0) throw invalid(label + " is not executable: " + path);
}

function relativePath(root: string, path: string): string {
  const value = relative(root, path).split(sep).join("/");
  validateRelativePath(value, "inventory path");
  return value;
}

function fileIdentity(info: { dev: number; ino: number }): FileIdentity {
  return { dev: info.dev, ino: info.ino };
}

async function assertRootIdentity(root: string, expected: FileIdentity): Promise<void> {
  const info = await lstat(root).catch((error) => {
    throw invalid("application root is unavailable: " + messageOf(error));
  });
  if (info.isSymbolicLink() || !info.isDirectory()) throw invalid("application root was replaced");
  const actual = fileIdentity(info);
  if (actual.dev !== expected.dev || actual.ino !== expected.ino) throw invalid("application root was replaced");
}

function resourcePaths(value: unknown): ManifestResourcePaths {

  const record = object(value, "manifest.resources");
  exactKeys(record, [
    "cliLauncher", "hostEntry", "rendererDirectory", "workerDirectory", "rLibraryDirectory",
    "arkExecutable", "airExecutable", "nodeExecutable", "processSupervisorExecutable", "electronEntry",
  ], "manifest.resources");
  const paths = {
    cliLauncher: relativeManifestPath(record.cliLauncher, "manifest.resources.cliLauncher"),
    hostEntry: relativeManifestPath(record.hostEntry, "manifest.resources.hostEntry"),
    rendererDirectory: relativeManifestPath(record.rendererDirectory, "manifest.resources.rendererDirectory"),
    workerDirectory: relativeManifestPath(record.workerDirectory, "manifest.resources.workerDirectory"),
    rLibraryDirectory: relativeManifestPath(record.rLibraryDirectory, "manifest.resources.rLibraryDirectory"),
    arkExecutable: relativeManifestPath(record.arkExecutable, "manifest.resources.arkExecutable"),
    airExecutable: relativeManifestPath(record.airExecutable, "manifest.resources.airExecutable"),
    nodeExecutable: relativeManifestPath(record.nodeExecutable, "manifest.resources.nodeExecutable"),
    processSupervisorExecutable: relativeManifestPath(record.processSupervisorExecutable, "manifest.resources.processSupervisorExecutable"),
    electronEntry: record.electronEntry === null ? null : relativeManifestPath(record.electronEntry, "manifest.resources.electronEntry"),
  };
  return paths;
}

function supervisorProducer(value: unknown, label: string): ProcessSupervisorProducer {
  const record = object(value, label);
  exactKeys(record, ["toolchain", "rustc", "cargo", "command"], label);
  if (record.toolchain !== SUPERVISOR_TOOLCHAIN) throw invalid(label + ".toolchain must be " + SUPERVISOR_TOOLCHAIN);
  const rustc = nonempty(record.rustc, label + ".rustc");
  if (!/^rustc 1\.95\.0(?:\s|$)/.test(rustc)) throw invalid(label + ".rustc must identify Rust 1.95.0");
  const cargo = nonempty(record.cargo, label + ".cargo");
  if (!/^cargo 1\.95\.0(?:\s|$)/.test(cargo)) throw invalid(label + ".cargo must identify Cargo 1.95.0");
  if (record.command !== SUPERVISOR_COMMAND) throw invalid(label + ".command is not the pinned build command");
  return { toolchain: SUPERVISOR_TOOLCHAIN, rustc, cargo, command: SUPERVISOR_COMMAND };
}

type ProcessSupervisorProvenance = {
  schemaVersion: 1;
  artifact: { sha256: string };
  producer: ProcessSupervisorProducer;
};

function supervisorProvenance(value: unknown): ProcessSupervisorProvenance {
  const record = object(value, "process supervisor provenance");
  exactKeys(record, ["schemaVersion", "artifact", "producer"], "process supervisor provenance");
  if (record.schemaVersion !== 1) throw invalid("process supervisor provenance.schemaVersion must be 1");
  const artifact = object(record.artifact, "process supervisor provenance.artifact");
  exactKeys(artifact, ["sha256"], "process supervisor provenance.artifact");
  return {
    schemaVersion: 1,
    artifact: { sha256: hash(artifact.sha256, "process supervisor provenance.artifact.sha256") },
    producer: supervisorProducer(record.producer, "process supervisor provenance.producer"),
  };
}

function runtimePaths(value: unknown): ApplicationManifest["runtimes"] {
  const record = object(value, "manifest.runtimes");
  exactKeys(record, ["node", "ark", "air", "electron", "chromium", "electronNode"], "manifest.runtimes");
  const ark = object(record.ark, "manifest.runtimes.ark");
  exactKeys(ark, ["upstreamVersion", "buildVersion", "baseCommit", "patchSha256", "mimePublisher"], "manifest.runtimes.ark");
  if (ark.mimePublisher !== "alder-json-v1") throw invalid("manifest.runtimes.ark.mimePublisher must be alder-json-v1");
  return {
    node: nonempty(record.node, "manifest.runtimes.node"),
    ark: {
      upstreamVersion: nonempty(ark.upstreamVersion, "manifest.runtimes.ark.upstreamVersion"),
      buildVersion: nonempty(ark.buildVersion, "manifest.runtimes.ark.buildVersion"),
      baseCommit: nonempty(ark.baseCommit, "manifest.runtimes.ark.baseCommit"),
      patchSha256: hash(ark.patchSha256, "manifest.runtimes.ark.patchSha256"),
      mimePublisher: "alder-json-v1",
    },
    air: nonempty(record.air, "manifest.runtimes.air"),
    electron: nullableString(record.electron, "manifest.runtimes.electron"),
    chromium: nullableString(record.chromium, "manifest.runtimes.chromium"),
    electronNode: nullableString(record.electronNode, "manifest.runtimes.electronNode"),
  };
}

function manifestFiles(value: unknown): ManifestFile[] {
  if (!Array.isArray(value)) throw invalid("manifest.files must be an array");
  return value.map((item, index) => {
    const record = object(item, `manifest.files[${index}]`);
    exactKeys(record, ["path", "bytes", "sha256"], `manifest.files[${index}]`);
    return {
      path: relativeManifestPath(record.path, `manifest.files[${index}].path`),
      bytes: safeBytes(record.bytes, `manifest.files[${index}].bytes`),
      sha256: hash(record.sha256, `manifest.files[${index}].sha256`),
    };
  });
}

function manifestSymlinks(value: unknown): ManifestSymlink[] {
  if (!Array.isArray(value)) throw invalid("manifest.symlinks must be an array");
  return value.map((item, index) => {
    const record = object(item, `manifest.symlinks[${index}]`);
    exactKeys(record, ["path", "target"], `manifest.symlinks[${index}]`);
    return {
      path: relativeManifestPath(record.path, `manifest.symlinks[${index}].path`),
      target: nonempty(record.target, `manifest.symlinks[${index}].target`),
    };
  });
}

function manifestPackages(value: unknown): ManifestRPackage[] {
  if (!Array.isArray(value)) throw invalid("manifest.rPackages must be an array");
  return value.map((item, index) => {
    const record = object(item, `manifest.rPackages[${index}]`);
    exactKeys(record, ["name", "version", "builtR", "platform", "license"], `manifest.rPackages[${index}]`);
    return {
      name: nonempty(record.name, `manifest.rPackages[${index}].name`),
      version: nonempty(record.version, `manifest.rPackages[${index}].version`),
      builtR: nonempty(record.builtR, `manifest.rPackages[${index}].builtR`),
      platform: nonempty(record.platform, `manifest.rPackages[${index}].platform`),
      license: nonempty(record.license, `manifest.rPackages[${index}].license`),
    };
  });
}

function object(value: unknown, label: string): ManifestRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalid(`${label} must be an object`);
  return value as ManifestRecord;
}

function exactKeys(value: ManifestRecord, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw invalid(`${label} has unexpected or missing fields`);
  }
}

function oneOf(value: unknown, values: readonly string[], label: string): string {
  if (typeof value !== "string" || !values.includes(value)) throw invalid(`${label} is invalid`);
  return value;
}

function nonempty(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) throw invalid(`${label} must be a nonempty string`);
  return value;
}
function nullableString(value: unknown, label: string): string | null {
  if (value === null) return null;
  return nonempty(value, label);
}

function commit(value: unknown, label: string): string {
  if (typeof value !== "string" || !SOURCE_COMMIT.test(value)) {
    throw invalid(`${label} must be a full lowercase 40-hex commit ID`);
  }
  return value;
}

function relativeManifestPath(value: unknown, label: string): string {
  const path = nonempty(value, label);
  validateRelativePath(path, label);
  return path;
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw invalid(`${label} must be an array`);
  return value.map((entry, index) => nonempty(entry, `${label}[${index}]`));
}

function safeBytes(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw invalid(`${label} must be a safe nonnegative integer`);
  return value;
}

function hash(value: unknown, label: string): string {
  const result = nonempty(value, label);
  if (!SHA256.test(result)) throw invalid(`${label} must be a lowercase SHA-256`);
  return result;
}

function invalid(message: string): ResourceValidationError {
  return new ResourceValidationError(message);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { lstatSync } from 'node:fs';
import { access, chmod, cp, lstat, mkdir, open, readFile, readdir, readlink, realpath, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { tsImport } from 'tsx/esm/api';
import { SignatureTrustUnavailableError, normalizeFingerprint, verifyDetachedSignature } from './release-signature.mjs';
const { readApplicationManifest } = await tsImport('../src/resources.ts', { parentURL: import.meta.url });
const { values, positionals } = parseArgs({ options: {
  evidence: { type: 'string' },
  rscript: { type: 'string' },
  'peer-rscript': { type: 'string' },
  'signature-record': { type: 'string' },
  'trusted-keyring': { type: 'string' },
  'trusted-fingerprint': { type: 'string' },
  'expected-artifact-sha256': { type: 'string', multiple: true },
  'expected-distributable-sha256': { type: 'string', multiple: true },
  'signature-file': { type: 'string', multiple: true },
  'expected-team-identifier': { type: 'string', multiple: true },
  'expected-certificate-thumbprint': { type: 'string', multiple: true },
  'qualification-manifest-sha256': { type: 'string' },
  'qualification-driver': { type: 'string' },
  'artifact-root': { type: 'string' },
  'installed-application': { type: 'string', multiple: true },
  'installation-receipt': { type: 'string', multiple: true },
  'expected-installation-receipt-sha256': { type: 'string', multiple: true },
  'qualification-source': { type: 'string' },
  scenario: { type: 'string' },
}, allowPositionals: true });

if (typeof values.rscript !== 'string' || !isAbsolute(values.rscript)) throw new Error('--rscript must be supplied as an absolute executable path');
if (values['peer-rscript'] !== undefined && (typeof values['peer-rscript'] !== 'string' || !isAbsolute(values['peer-rscript']))) throw new Error('--peer-rscript must be an absolute executable path');
if (typeof values['qualification-driver'] !== 'string' || !isAbsolute(values['qualification-driver'])) throw new Error('--qualification-driver must be supplied as an absolute frozen helper path');
if (typeof values['qualification-source'] !== 'string' || !isAbsolute(values['qualification-source'])) throw new Error('--qualification-source must be supplied as an absolute frozen source path');
if (values.scenario && values.scenario !== 'all') throw new Error('release smoke requires --scenario all');
const input = resolve(positionals[0] ?? 'host/.release');
const evidence = resolve(values.evidence ?? positionals[1] ?? join('/tmp', 'alder-release-smoke-' + process.pid));
if (typeof values['artifact-root'] !== 'string' || !isAbsolute(values['artifact-root'])) throw new Error('--artifact-root must be supplied as an absolute qualification root');
const qualificationDriver = resolve(values['qualification-driver']);
const qualificationSource = resolve(values['qualification-source']);
if (!await exists(qualificationDriver)) throw new Error('release_qualification_missing: frozen helper does not exist: ' + qualificationDriver);
const artifactRoot = resolve(values['artifact-root']);
if (!await exists(qualificationSource)) throw new Error('release_qualification_missing: frozen source does not exist: ' + qualificationSource);
const aggregatePath = join(input, 'release-record.json');
const aggregate = await readJsonRequired(aggregatePath, 'dual-variant release record');
const qualificationManifestSha256 = values['qualification-manifest-sha256'];
const target = { platform: process.platform, arch: process.arch };
validateAggregate(aggregate, target);
await mkdir(evidence, { recursive: true });

const variants = normalizeVariants(aggregate.variants);
const signatureInputs = normalizeSignatureInputs(variants, input);
const installedApplications = mapInstalledApplications(variants, input);
const installationReceipts = mapInstallationReceipts(variants, input);
const results = [];
for (const variant of variants) {
  const variantEvidence = join(evidence, variant.kind);
  await mkdir(variantEvidence, { recursive: true });
  try {
    const result = await smokeVariant({ input, aggregatePath, aggregate, variant, target, evidence: variantEvidence, qualificationDriver, qualificationSource, qualificationManifestSha256, signatureInputs, installedApplications, installationReceipts });
    results.push({ kind: variant.kind, status: 'PASSED', ...result });
  } catch (error) {
    const blocked = isBlockedError(error);
    const result = {
      kind: variant.kind,
      status: blocked ? 'BLOCKED' : 'FAILED',
      error: describeError(error),
    };
    await writeFile(join(variantEvidence, 'release-status.json'), JSON.stringify(result, null, 2) + '\n');
    results.push(result);
  }
}

const summary = {
  total: results.length,
  passed: results.filter(result => result.status === 'PASSED').length,
  blocked: results.filter(result => result.status === 'BLOCKED').length,
  failed: results.filter(result => result.status === 'FAILED').length,
};
const report = {
  input,
  evidence,
  target,
  status: summary.blocked || summary.failed ? 'FAILED' : 'PASSED',
  summary,
  variants: results,
};
await writeFile(join(evidence, 'release-smoke-report.json'), JSON.stringify(report, null, 2) + '\n');
process.stdout.write(JSON.stringify(report) + '\n');
if (summary.blocked || summary.failed) process.exitCode = 1;

async function smokeVariant({ input, aggregatePath, aggregate, variant, target, evidence: variantEvidence, qualificationDriver, qualificationSource, qualificationManifestSha256, signatureInputs, installedApplications, installationReceipts }) { if (variant.kind !== variant.expectedKind) throw new Error(`variant kind mismatch: ${variant.kind}`);
const recordPath = variant.artifactRecord
  ? resolveSafePath(input, variant.artifactRecord, 'artifact record')
  : aggregatePath;
const externalRecord = variant.artifactRecord ? await readJsonRequired(recordPath, `${variant.kind} artifact record`) : null;
if (externalRecord && variant.record && JSON.stringify(externalRecord) !== JSON.stringify(variant.record)) {
  throw new Error(`${variant.kind} aggregate and external artifact records differ`);
}
const record = externalRecord ?? variant.record;
validateExternalRecord(record, variant.kind, target);
const releaseRoot = resolveSafePath(dirname(recordPath), record.release.root, `${variant.kind} release root`);
const applicationManifestPath = resolveSafePath(dirname(recordPath), record.release.applicationManifest, 'application manifest');
if (!isWithin(input, releaseRoot) || !isWithin(releaseRoot, applicationManifestPath)) {
  throw new Error(`${variant.kind} release identity escapes its qualification root`);
}
if (variant.root) {
  assertSafeRelative(variant.root);
  assert.equal(resolve(input, variant.root), releaseRoot, `${variant.kind} aggregate root`);
}
const releaseRootPhysical = await realpath(releaseRoot).catch(() => null);
const applicationManifestPhysical = await realpath(applicationManifestPath).catch(() => null);
if (!releaseRootPhysical || !applicationManifestPhysical || !isWithin(releaseRootPhysical, applicationManifestPhysical)) {
  throw new Error(`${variant.kind} application manifest escapes its release root`);
}
const applicationRoot = dirname(dirname(applicationManifestPath));
const app = await readApplicationManifest(applicationRoot);
const applicationRootPhysical = await realpath(applicationRoot).catch(() => null);
const releaseManifest = record.releaseManifest;
const releaseManifestSha256 = sha256Text(JSON.stringify(releaseManifest, null, 2) + '\n');
assert.equal(record.releaseManifestSha256, releaseManifestSha256, `${variant.kind} release descriptor digest`);
assert.equal(record.release.manifestSha256, await sha256(applicationManifestPath), `${variant.kind} application manifest digest`);
assert.equal(releaseManifest.applicationManifest, relative(releaseRoot, applicationManifestPath).split(sep).join('/'));
if (app.kind !== variant.kind) throw new Error(variant.kind + ' application manifest kind does not match release variant');
validateReleaseManifest(releaseManifest, app, variant.kind, target);
await assertImmutableQualificationBoundary(dirname(qualificationSource), input);
const qualification = await verifyQualificationSource(qualificationSource, releaseManifest, qualificationDriver, qualificationManifestSha256);
const actual = {};
await collectHashes(releaseRoot, '', actual);
assert.deepEqual(Object.keys(actual).sort(), Object.keys(releaseManifest.files).sort(), variant.kind + ' release inventory');
for (const [path, digest] of Object.entries(releaseManifest.files)) assert.equal(actual[path], digest, variant.kind + ':' + path);
await verifyApplicationFiles(applicationRoot, app);

if (values['signature-record']) {
  const signatureRecord = await readJsonRequired(resolve(values['signature-record']), 'signature record');
  const externalSignature = signatureRecord.signature ?? signatureRecord;
  assert.equal(externalSignature?.status, releaseManifest.signature?.status, 'external signature status');
}
const artifactPath = await verifyArtifacts(record, recordPath, releaseManifest, variant.kind, artifactRoot, signatureInputs[variant.kind]);
let signature = await validateSignature(releaseManifest.signature, record, recordPath, artifactPath, signatureInputs[variant.kind], input, releaseRoot);
const extracted = join(variantEvidence, 'extracted-artifact');
await rm(extracted, { recursive: true, force: true });
validateArchiveEntries(artifactPath, record.artifact.format, variant.kind, releaseManifest.archive?.prefix);
await extractArchive(artifactPath, extracted, record.artifact.format);
const extractedRawFiles = {};
await collectHashes(extracted, '', extractedRawFiles);
const extractedFiles = stripArchivePrefix(extractedRawFiles, variant.kind === 'desktop' ? releaseManifest.archive.prefix : '');
assert.deepEqual(Object.keys(extractedFiles).sort(), Object.keys(releaseManifest.files).sort(), variant.kind + ' extracted archive inventory');
for (const [path, digest] of Object.entries(releaseManifest.files)) assert.equal(extractedFiles[path], digest, variant.kind + ' extracted:' + path);
const archivePrefix = variant.kind === 'desktop' ? releaseManifest.archive.prefix : '';
const extractedManifestPath = resolveSafePath(extracted, archivePrefix + releaseManifest.applicationManifest, 'extracted application manifest');
assert.equal(await sha256(extractedManifestPath), releaseManifest.manifestSha256, variant.kind + ' extracted application manifest digest');
const extractedApplicationRoot = dirname(dirname(extractedManifestPath));
const extractedApp = await readApplicationManifest(extractedApplicationRoot);
assert.deepEqual(extractedApp, app, variant.kind + ' extracted application manifest identity');
const nativeVerification = await verifyNativePayload(record, recordPath, variant.kind, extractedApplicationRoot, extractedApp, artifactRoot, signatureInputs[variant.kind]);
if (nativeVerification !== null) signature = { ...signature, nativeVerification };

await writeFile(join(variantEvidence, 'release-identity.json'), JSON.stringify({
  kind: variant.kind,
  target,
  releaseRoot,
  artifactPath,
  extractedRoot: extracted,
  applicationManifest: extractedManifestPath,
  artifactRecord: recordPath,
  qualification,
  releaseManifestSha256: record.releaseManifestSha256,
  signature,
}, null, 2) + '\n');

const relocated = join(variantEvidence, 'relocated Space ü');
await rm(relocated, { recursive: true, force: true });
await cp(extracted, relocated, { recursive: true, verbatimSymlinks: true });
const applicationRootRelative = relative(extracted, extractedApplicationRoot).split(sep).join('/');
const relocatedApplicationRoot = resolve(relocated, applicationRootRelative || '.');
await chmodTree(relocatedApplicationRoot);
const canonicalReport = await runQualifiedApplication({ applicationRoot: relocatedApplicationRoot, app, evidence: join(variantEvidence, 'application'), qualificationDriver, qualificationSource, label: variant.kind });
const installedReports = await verifyInstalledApplications({ record, kind: variant.kind, app, roots: installedApplications[variant.kind], receipts: installationReceipts[variant.kind], candidateRoot: input, evidence: join(variantEvidence, 'installed'), qualificationDriver, qualificationSource, trusted: signatureInputs[variant.kind] });
await writeFile(join(variantEvidence, 'release-status.json'), JSON.stringify({ kind: variant.kind, status: 'PASSED', scenarioReport: canonicalReport, installedApplications: installedReports }, null, 2) + '\n');
return { scenarioReport: canonicalReport, installedApplications: installedReports, releaseManifestSha256: record.releaseManifestSha256 }; }

async function verifyInstalledApplications({ record, kind, app, roots, receipts, candidateRoot, evidence, qualificationDriver, qualificationSource, trusted }) {
  const installableFormats = process.platform === 'linux' ? new Set(['deb', 'rpm']) : process.platform === 'darwin' ? new Set(['dmg']) : new Set(['exe', 'msi']);
  const installables = (record.artifacts ?? [record.artifact]).filter(artifact => installableFormats.has(artifact.format));
  if (kind !== 'desktop' || installables.length === 0) {
    if (Object.keys(roots).length > 0 || Object.keys(receipts).length > 0) throw new Error(kind + ' has unexpected installed application evidence');
    return [];
  }
  const expectedNames = new Set(installables.map(artifact => artifact.name));
  for (const supplied of [...Object.keys(roots), ...Object.keys(receipts)]) if (!expectedNames.has(supplied)) throw new Error(kind + ' installed application evidence names do not match installable artifacts');
  const physicalRoots = new Set(), isolationIds = new Set(), reports = [];
  for (const artifact of installables) {
    const applicationRoot = roots[artifact.name];
    const receiptInput = receipts[artifact.name];
    if (!applicationRoot || !receiptInput?.path || !receiptInput.expectedSha256) throw new SignatureTrustUnavailableError('Release qualification is blocked: trusted native installation evidence missing for ' + kind + '/' + artifact.name);
    const receiptBytes = await readFile(receiptInput.path).catch(() => null);
    if (!receiptBytes || createHash('sha256').update(receiptBytes).digest('hex') !== receiptInput.expectedSha256) throw new Error(kind + '/' + artifact.name + ' installation receipt does not match its external trust anchor');
    let receipt;
    try { receipt = JSON.parse(receiptBytes.toString('utf8')); } catch { throw new Error(kind + '/' + artifact.name + ' installation receipt is invalid JSON'); }
    const physicalRoot = await realpath(applicationRoot).catch(() => null);
    if (!physicalRoot || isWithin(candidateRoot, physicalRoot) || physicalRoots.has(physicalRoot)) throw new Error(kind + '/' + artifact.name + ' installed root is missing, inside the candidate, or reused');
    physicalRoots.add(physicalRoot);
    if (receipt?.schemaVersion !== 1 || receipt.artifact?.name !== artifact.name || receipt.artifact?.sha256 !== artifact.sha256
        || receipt.applicationRoot !== applicationRoot || receipt.installer?.exitStatus !== 0 || typeof receipt.installer?.command !== 'string' || !receipt.installer.command
        || !Array.isArray(receipt.installer.actions) || receipt.installer.actions.some(action => typeof action !== 'string')
        || receipt.isolated !== true || typeof receipt.runner !== 'string' || !receipt.runner || typeof receipt.isolationId !== 'string' || !receipt.isolationId
        || isolationIds.has(receipt.isolationId)) throw new Error(kind + '/' + artifact.name + ' installation receipt is not bound to a unique successful isolated native install');
    isolationIds.add(receipt.isolationId);
    const manifestPath = await firstExisting([join(physicalRoot, 'resources', 'manifest.json'), join(physicalRoot, 'Resources', 'manifest.json')]);
    if (!manifestPath) throw new Error(kind + '/' + artifact.name + ' installed application manifest is missing');
    const installedApp = await readApplicationManifest(physicalRoot);
    assert.deepEqual(installedApp, app, kind + '/' + artifact.name + ' installed application identity');
    await verifyApplicationFiles(physicalRoot, installedApp);
    const installedSignature = process.platform === 'darwin' ? verifyInstalledMacSignature(physicalRoot, trusted) : null;
    const report = await runQualifiedApplication({ applicationRoot: physicalRoot, app: installedApp, evidence: join(evidence, artifact.name.replace(/[^A-Za-z0-9._-]/g, '_')), qualificationDriver, qualificationSource, label: kind + '/' + artifact.name });
    reports.push({ artifact: artifact.name, artifactSha256: artifact.sha256, applicationRoot: physicalRoot, installationReceiptSha256: receiptInput.expectedSha256, isolationId: receipt.isolationId, installedSignature, scenarioReport: report });
  }
  return reports;
}

function verifyInstalledMacSignature(applicationRoot, trusted) {
  if (process.platform !== 'darwin' || !trusted?.expectedTeamIdentifier) throw new SignatureTrustUnavailableError('macOS installed application signature qualification requires an externally trusted TeamIdentifier');
  const appBundle = basename(applicationRoot) === 'Contents' ? dirname(applicationRoot) : applicationRoot;
  if (!appBundle.endsWith('.app')) throw new Error('installed macOS application root is not inside an application bundle');
  const contents = basename(applicationRoot) === 'Contents' ? applicationRoot : join(applicationRoot, 'Contents');
  const signatureDirectory = lstatSync(join(contents, '_CodeSignature'), { throwIfNoEntry: false });
  const codeResources = signatureDirectory?.isDirectory() && !signatureDirectory.isSymbolicLink()
    ? lstatSync(join(contents, '_CodeSignature', 'CodeResources'), { throwIfNoEntry: false })
    : null;
  if (!codeResources?.isFile() || codeResources.isSymbolicLink() || codeResources.nlink !== 1) throw new Error('installed macOS outer signature envelope is invalid');
  runVerifier('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', appBundle]);
  const detail = captureVerifier('/usr/bin/codesign', ['-dv', '--verbose=4', appBundle]);
  const teamIdentifier = /(?:^|\n)TeamIdentifier=([^\r\n]+)/.exec(detail)?.[1];
  assert.equal(teamIdentifier, trusted.expectedTeamIdentifier, 'installed macOS signer TeamIdentifier');
  return { method: 'codesign', application: basename(appBundle), teamIdentifier };
}

async function runQualifiedApplication({ applicationRoot, app, evidence, qualificationDriver, qualificationSource, label }) {
  const bundledNode = await findBundledNode(applicationRoot, app);
  if (!bundledNode) throw new Error('release_missing: bundled Node runtime under ' + applicationRoot);
  const smokeEnvironment = cleanEnvironment();
  smokeEnvironment.ALDER_RELEASE_QUALIFICATION = '1';
  const smokeArgs = [qualificationDriver, applicationRoot, '--scenario', 'all', '--evidence', evidence, '--rscript', resolve(values.rscript), '--qualification-source', qualificationSource];
  if (values['peer-rscript']) smokeArgs.push('--peer-rscript', resolve(values['peer-rscript']));
  await mkdir(evidence, { recursive: true });
  const cwd = join(dirname(evidence), 'unrelated-' + basename(evidence));
  await mkdir(cwd, { recursive: true });
  const smoke = spawnSync(bundledNode, smokeArgs, { cwd, env: smokeEnvironment, stdio: 'inherit', timeout: 10_800_000, windowsHide: true });
  if (smoke.error) throw smoke.error;
  const scenarioReport = await readJsonRequired(join(evidence, 'scenario-report.json'), label + ' scenario report');
  if (!scenarioReport.summary || scenarioReport.summary.total !== 39 || scenarioReport.summary.passed + scenarioReport.summary.notApplicable !== 39 || scenarioReport.summary.failed !== 0 || scenarioReport.summary.blocked !== 0) {
    const error = new Error(label + ' S(all) cardinality or status is invalid');
    error.code = scenarioReport.summary?.blocked ? 'scenario_blocked' : 'scenario_failed';
    error.report = scenarioReport;
    throw error;
  }
  if (smoke.status !== 0) throw new Error(label + ' application smoke failed with status ' + smoke.status);
  return scenarioReport.summary;
}

async function firstExisting(paths) {
  for (const path of paths) if (await exists(path)) return path;
  return null;
}
async function verifyApplicationFiles(applicationRoot, app) {
  const physicalRoot = await realpath(applicationRoot);
  for (const file of app.files) {
    assertSafeRelative(file.path);
    const path = resolveSafePath(applicationRoot, file.path, 'installed application file');
    const info = await lstat(path).catch(() => null);
    if (!info) throw new Error('installed application file is missing: ' + path);
    const physicalFile = await realpath(path).catch(() => null);
    if (!physicalFile || !isWithin(physicalRoot, physicalFile)) throw new Error('installed application file escapes its root: ' + file.path);
    if (!info.isFile() && !info.isSymbolicLink()) throw new Error('installed application entry is not a regular file or symlink: ' + file.path);
    const targetInfo = await stat(path).catch(() => null);
    if (!targetInfo?.isFile() || targetInfo.nlink !== 1) throw new Error('installed application file target is not a regular, singly-linked file: ' + file.path);
    assert.equal(targetInfo.size, file.bytes, 'installed application file bytes: ' + file.path);
    assert.equal(await sha256(path), file.sha256, 'installed application file digest: ' + file.path);
  }
}

function validateAggregate(aggregate, target) {
  if (!aggregate || aggregate.schemaVersion !== 1 || aggregate.target?.platform !== target.platform || aggregate.target?.arch !== target.arch) {
    throw new Error('dual-variant release record target or schema is invalid');
  }
  const variants = normalizeVariants(aggregate.variants);
  if (variants.length !== 2 || new Set(variants.map(variant => variant.kind)).size !== 2
      || !variants.some(variant => variant.kind === 'headless') || !variants.some(variant => variant.kind === 'desktop')) {
    throw new Error('dual-variant release record must enumerate headless and desktop variants');
  }
}

function normalizeVariants(raw) {
  const normalize = (variant, expectedKind) => {
    if (!variant || typeof variant !== 'object') throw new Error(`dual-variant release record is missing ${expectedKind}`);
    if (variant.releaseManifest && variant.release) {
      return { kind: variant.kind ?? expectedKind, expectedKind, record: variant, artifactRecord: null };
    }
    return { ...variant, expectedKind, kind: variant.kind ?? expectedKind };
  };
  if (Array.isArray(raw)) {
    return raw.map(variant => normalize(variant, variant?.kind));
  }
  if (!raw || typeof raw !== 'object') throw new Error('dual-variant release record variants are missing');
  return ['headless', 'desktop'].map(kind => normalize(raw[kind], kind));
}
function normalizeSignatureInputs(variants, candidateRoot) {
  const keyringValue = values['trusted-keyring'];
  const fingerprintValue = values['trusted-fingerprint'];
  const keyring = keyringValue === undefined ? null : resolveExternalPath(keyringValue, 'trusted keyring', candidateRoot);
  const expectedTeams = mapSignatureOption('expected-team-identifier', variants, value => normalizeIdentity(value, 'team identifier'));
  const expectedThumbprints = mapSignatureOption('expected-certificate-thumbprint', variants, value => normalizeThumbprint(value));
  const fingerprint = fingerprintValue === undefined ? null : normalizeFingerprint(fingerprintValue);
  const expectedDigests = mapSignatureOption('expected-artifact-sha256', variants, value => normalizeSha256Value(value));
  const distributableDigests = mapDistributableDigests(variants);
  const signatureFiles = mapSignatureOption('signature-file', variants, value => resolveExternalPath(value, 'detached signature', candidateRoot));
  return Object.fromEntries(variants.map(variant => [variant.kind, {
    keyring,
    fingerprint,
    expectedArtifactSha256: expectedDigests[variant.kind] ?? null,
    expectedDistributableSha256: distributableDigests[variant.kind],
    signatureFile: signatureFiles[variant.kind] ?? null,
    expectedTeamIdentifier: expectedTeams[variant.kind] ?? null,
    expectedCertificateThumbprint: expectedThumbprints[variant.kind] ?? null,
  }]));
}

function mapSignatureOption(option, variants, transform) {
  const entries = values[option] ?? [];
  if (entries.length === 0) return {};
  const kinds = variants.map(variant => variant.kind);
  const mapped = new Map();
  const unkeyed = [];
  for (const entry of entries) {
    if (typeof entry !== 'string' || entry.length === 0) throw new Error(`--${option} cannot be empty`);
    const separator = entry.indexOf('=');
    if (separator > 0) {
      const kind = entry.slice(0, separator);
      if (!kinds.includes(kind)) throw new Error(`--${option} has an unknown variant key: ${kind}`);
      if (mapped.has(kind)) throw new Error(`--${option} has duplicate value for ${kind}`);
      mapped.set(kind, transform(entry.slice(separator + 1)));
    } else {
      unkeyed.push(entry);
    }
  }
  if (unkeyed.length > 0) {
    if (mapped.size > 0 || (unkeyed.length !== 1 && unkeyed.length !== kinds.length)) {
      throw new Error(`--${option} must use one value for every variant or variant=value mappings`);
    }
    const targets = unkeyed.length === 1 ? kinds : kinds;
    for (let index = 0; index < unkeyed.length; index++) {
      const kind = unkeyed.length === 1 ? targets[0] : targets[index];
      if (mapped.has(kind)) throw new Error(`--${option} has duplicate value for ${kind}`);
      const value = transform(unkeyed[index]);
      if (unkeyed.length === 1) {
        for (const target of kinds) mapped.set(target, value);
        break;
      }
      mapped.set(kind, value);
    }
  }
  return Object.fromEntries(mapped);
}

function resolveExternalPath(value, label, candidateRoot) {
  if (typeof value !== 'string' || !isAbsolute(value)) throw new Error(`${label} path must be absolute`);
  const path = resolve(value);
  if (isWithin(candidateRoot, path)) throw new Error(`${label} path must be outside the candidate release`);
  return path;
}
function mapDistributableDigests(variants) {
  const kinds = new Set(variants.map(variant => variant.kind));
  const result = Object.fromEntries([...kinds].map(kind => [kind, {}]));
  for (const entry of values['expected-distributable-sha256'] ?? []) {
    const separator = entry.lastIndexOf('=');
    const identity = separator < 0 ? '' : entry.slice(0, separator);
    const slash = identity.indexOf('/');
    const kind = slash < 0 ? '' : identity.slice(0, slash);
    const name = slash < 0 ? '' : identity.slice(slash + 1);
    if (!kinds.has(kind) || !name || basename(name) !== name || Object.hasOwn(result[kind], name)) {
      throw new Error('--expected-distributable-sha256 must use unique variant/filename=sha256 values');
    }
    result[kind][name] = normalizeSha256Value(entry.slice(separator + 1));
  }
  return result;
}


function mapInstalledApplications(variants, candidateRoot) {
  const kinds = new Set(variants.map(variant => variant.kind));
  const result = Object.fromEntries([...kinds].map(kind => [kind, {}]));
  for (const entry of values['installed-application'] ?? []) {
    const equals = entry.indexOf('=');
    const slash = entry.indexOf('/');
    if (equals < 0 || slash < 1 || slash > equals) throw new Error('--installed-application requires variant/artifact=absolute-application-root');
    const kind = entry.slice(0, slash);
    const artifact = entry.slice(slash + 1, equals);
    const root = entry.slice(equals + 1);
    if (!kinds.has(kind) || !artifact || !isAbsolute(root)) throw new Error('--installed-application has an unknown variant, artifact, or non-absolute root');
    if (result[kind][artifact]) throw new Error('--installed-application repeats ' + kind + '/' + artifact);
    const resolvedRoot = resolve(root);
    if (isWithin(candidateRoot, resolvedRoot)) throw new Error('--installed-application must identify an independently installed tree outside the candidate');
    result[kind][artifact] = resolvedRoot;
  }
  return result;
}
function mapInstallationReceipts(variants, candidateRoot) {
  const kinds = new Set(variants.map(variant => variant.kind));
  const result = Object.fromEntries([...kinds].map(kind => [kind, {}]));
  const parseKeyed = (entry, label) => {
    const equals = entry.indexOf('=');
    const slash = entry.indexOf('/');
    if (equals < 0 || slash < 1 || slash > equals) throw new Error(label + ' requires variant/artifact=value');
    const kind = entry.slice(0, slash), artifact = entry.slice(slash + 1, equals);
    if (!kinds.has(kind) || !artifact) throw new Error(label + ' has an unknown variant or artifact');
    return { kind, artifact, value: entry.slice(equals + 1) };
  };
  for (const entry of values['installation-receipt'] ?? []) {
    const parsed = parseKeyed(entry, '--installation-receipt');
    if (!isAbsolute(parsed.value)) throw new Error('--installation-receipt path must be absolute');
    const path = resolve(parsed.value);
    if (isWithin(candidateRoot, path)) throw new Error('--installation-receipt must be externally supplied outside the candidate');
    if (result[parsed.kind][parsed.artifact]?.path) throw new Error('--installation-receipt repeats ' + parsed.kind + '/' + parsed.artifact);
    result[parsed.kind][parsed.artifact] = { ...result[parsed.kind][parsed.artifact], path };
  }
  for (const entry of values['expected-installation-receipt-sha256'] ?? []) {
    const parsed = parseKeyed(entry, '--expected-installation-receipt-sha256');
    if (result[parsed.kind][parsed.artifact]?.expectedSha256) throw new Error('--expected-installation-receipt-sha256 repeats ' + parsed.kind + '/' + parsed.artifact);
    result[parsed.kind][parsed.artifact] = { ...result[parsed.kind][parsed.artifact], expectedSha256: normalizeSha256Value(parsed.value) };
  }
  return result;
}

function normalizeSha256Value(value) {
  if (typeof value !== 'string' || !/^[0-9a-fA-F]{64}$/.test(value)) throw new Error('--expected-artifact-sha256 must be a 64-hex SHA-256 digest');
  return value.toLowerCase();
}
function normalizeIdentity(value, label) {
  if (typeof value !== 'string' || value.length === 0 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error(`expected ${label} is invalid`);
  return value;
}

function normalizeThumbprint(value) {
  if (typeof value !== 'string' || !/^[0-9a-fA-F]{40,128}$/.test(value)) throw new Error('expected certificate thumbprint is invalid');
  return value.toUpperCase();
}


function validateExternalRecord(record, kind, target) {
  if (!record || record.schemaVersion !== 1 || record.kind !== kind
      || record.target?.platform !== target.platform || record.target?.arch !== target.arch) {
    throw new Error(`${kind} artifact record identity does not match target`);
  }
  if (!record.release || typeof record.release.root !== 'string' || typeof record.release.applicationManifest !== 'string'
      || !/^[0-9a-f]{64}$/.test(record.release.manifestSha256)
      || !record.releaseManifest || !/^[0-9a-f]{64}$/.test(record.releaseManifestSha256)) {
    throw new Error(`${kind} artifact record has an invalid release identity`);
  }
  assertSafeRelative(record.release.root);
  assertSafeRelative(record.release.applicationManifest);
  validateReleaseManifest(record.releaseManifest, null, kind, target);
}

function validateReleaseManifest(manifest, app, kind, target) {
  if (!manifest || manifest.schemaVersion !== 1 || manifest.kind !== kind
      || manifest.platform !== target.platform || manifest.arch !== target.arch
      || manifest.target?.platform !== target.platform || manifest.target?.arch !== target.arch
      || manifest.nodeVersion !== process.version || typeof manifest.applicationManifest !== 'string'
      || !/^[0-9a-f]{64}$/.test(manifest.manifestSha256) || !manifest.files || typeof manifest.files !== 'object') {
    throw new Error(`${kind} release descriptor identity is invalid`);
  }
  if (kind === 'desktop' && (!manifest.archive || manifest.archive.format !== 'zip'
      || typeof manifest.archive.name !== 'string' || typeof manifest.archive.record !== 'string'
      || !isSafeArchivePrefix(manifest.archive.prefix))) {
    throw new Error('desktop release descriptor has no exact archive prefix');
  }
  if (app) {
    assert.equal(manifest.applicationVersion, app.applicationVersion);
    assert.equal(manifest.sourceCommit, app.sourceCommit);
    assert.equal(manifest.sourceTreeSha256, app.sourceTreeSha256);
    assert.equal(manifest.hostProtocol, app.hostProtocol);
    assert.equal(manifest.engineProtocol, app.engineProtocol);
  }
}

async function assertImmutableQualificationBoundary(boundary, candidateRoot) {
  const physicalBoundary = await realpath(boundary);
  const physicalCandidate = await realpath(candidateRoot);
  if (isWithin(physicalBoundary, physicalCandidate) || isWithin(physicalCandidate, physicalBoundary)) {
    throw new Error('release_qualification_invalid: qualification sidecar and candidate must be disjoint');
  }
  if (process.platform === 'win32') {
    verifyWindowsReadOnlyAcl(physicalBoundary);
    const assertDenied = async (path, directory) => {
      const target = await realpath(path);
      if (!isWithin(physicalBoundary, target)) throw new Error('release_qualification_invalid: qualification reparse point escapes its immutable boundary');
      let writable = false;
      if (directory) {
        const probe = join(path, '.alder-write-probe-' + randomUUID());
        try {
          const handle = await open(probe, 'wx');
          writable = true;
          await handle.close();
          await unlink(probe).catch(() => undefined);
        } catch {}
      } else {
        try {
          const handle = await open(path, 'r+');
          writable = true;
          await handle.close();
        } catch {}
      }
      if (writable) throw new SignatureTrustUnavailableError('Release qualification is blocked: candidate identity has effective write access to ' + path);
      if (directory) for (const entry of await readdir(path, { withFileTypes: true })) await assertDenied(join(path, entry.name), entry.isDirectory());
    };
    await assertDenied(physicalBoundary, true);
    return;
  }
  const uid = process.geteuid?.();
  if (uid === undefined || uid === 0) throw new SignatureTrustUnavailableError('Release qualification is blocked: qualification must run as an unprivileged identity against a separately owned sidecar');
  const groups = new Set(process.getgroups?.() ?? []);
  const assertProtected = async (path, directory, recurse = directory) => {
    const info = await lstat(path);
    if (info.uid === uid) throw new SignatureTrustUnavailableError('Release qualification is blocked: candidate identity owns qualification path ' + path);
    const modeWritable = !info.isSymbolicLink() && ((groups.has(info.gid) && (info.mode & 0o020) !== 0) || (info.mode & 0o002) !== 0);
    let effectivelyWritable = false;
    if (!info.isSymbolicLink() && directory) {
      const probe = join(path, '.alder-write-probe-' + randomUUID());
      try { const handle = await open(probe, 'wx'); effectivelyWritable = true; await handle.close(); await unlink(probe).catch(() => undefined); } catch {}
    } else if (info.isFile()) {
      try { const handle = await open(path, 'r+'); effectivelyWritable = true; await handle.close(); } catch {}
    }
    if (modeWritable || effectivelyWritable) throw new SignatureTrustUnavailableError('Release qualification is blocked: candidate identity can modify qualification path ' + path);
    if (directory && recurse) for (const entry of await readdir(path, { withFileTypes: true })) await assertProtected(join(path, entry.name), entry.isDirectory());
  };
  await assertProtected(physicalBoundary, true);
  for (let parent = dirname(physicalBoundary); parent !== dirname(parent); parent = dirname(parent)) await assertProtected(parent, true, false);
}

function verifyWindowsReadOnlyAcl(root) {
  const script = [
    '$ErrorActionPreference = "Stop"',
    '$identity = [Security.Principal.WindowsIdentity]::GetCurrent()',
    '$sids = @($identity.User.Value) + @($identity.Groups | ForEach-Object { $_.Value })',
    '$danger = [Security.AccessControl.FileSystemRights]::Write -bor [Security.AccessControl.FileSystemRights]::Modify -bor [Security.AccessControl.FileSystemRights]::FullControl -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership -bor [Security.AccessControl.FileSystemRights]::Delete -bor [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor [Security.AccessControl.FileSystemRights]::CreateFiles -bor [Security.AccessControl.FileSystemRights]::AppendData -bor [Security.AccessControl.FileSystemRights]::WriteAttributes -bor [Security.AccessControl.FileSystemRights]::WriteExtendedAttributes',
    '$items = @((Get-Item -LiteralPath $args[0] -Force)) + @(Get-ChildItem -LiteralPath $args[0] -Force -Recurse)',
    'foreach ($item in $items) {',
    '  $acl = Get-Acl -LiteralPath $item.FullName',
    '  try { $owner = ([Security.Principal.NTAccount]$acl.Owner).Translate([Security.Principal.SecurityIdentifier]).Value } catch { $owner = $acl.Owner }',
    '  if ($sids -contains $owner) { throw "current token owns qualification path: $($item.FullName)" }',
    '  foreach ($rule in $acl.Access) {',
    '    try { $sid = $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value } catch { continue }',
    '    if (($sids -contains $sid) -and $rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and (($rule.FileSystemRights -band $danger) -ne 0)) { throw "current token has dangerous ACL rights on qualification path: $($item.FullName)" }',
    '  }',
    '}',
    '"OK"',
  ].join('; ');
  try {
    const result = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script, root], { encoding: 'utf8', windowsHide: true }).trim();
    if (result !== 'OK') throw new Error('unexpected ACL verifier output');
  } catch (error) {
    throw new SignatureTrustUnavailableError('Release qualification is blocked: sidecar owner/ACL is not immutable to the candidate identity: ' + (error instanceof Error ? error.message : String(error)));
  }
}

async function verifyQualificationSource(root, releaseManifest, qualificationDriver, expectedManifestSha256) {
  if (expectedManifestSha256 === undefined) throw new SignatureTrustUnavailableError('Release qualification is blocked: an externally trusted qualification manifest SHA-256 is required');
  if (!/^[0-9a-f]{64}$/.test(expectedManifestSha256)) throw new Error('release_qualification_invalid: expected qualification manifest SHA-256 is invalid');
  const descriptorPath = join(root, 'qualification-manifest.json');
  if (await sha256(descriptorPath) !== expectedManifestSha256) throw new Error('release_qualification_invalid: qualification manifest does not match its external trust anchor');
  const descriptor = await readJsonRequired(descriptorPath, 'qualification source manifest');
  if (descriptor.schemaVersion !== 1 || descriptor.sourceCommit !== releaseManifest.sourceCommit || descriptor.sourceTreeSha256 !== releaseManifest.sourceTreeSha256
      || !descriptor.files || descriptor.filesSha256 !== sha256Text(JSON.stringify(descriptor.files, null, 2) + '\n')
      || descriptor.driver?.entry !== 'scripts/smoke-application.mjs' || !descriptor.driver.files
      || descriptor.driver.filesSha256 !== sha256Text(JSON.stringify(descriptor.driver.files, null, 2) + '\n')
      || descriptor.dependencies?.packageLockSha256 !== descriptor.files['host/package-lock.json']
      || descriptor.dependencies.tsx?.path !== 'node_modules/.bin/' + (process.platform === 'win32' ? 'tsx.cmd' : 'tsx')
      || !/^[0-9a-f]{64}$/.test(descriptor.dependencies.tsx?.sha256 ?? '') || descriptor.dependencies.nodeModules?.path !== 'node_modules'
      || !descriptor.dependencies.nodeModules.files || descriptor.dependencies.nodeModules.filesSha256 !== sha256Text(JSON.stringify(descriptor.dependencies.nodeModules.files, null, 2) + '\n')) {
    throw new Error('release_qualification_invalid: frozen source/driver identity does not match the release manifest');
  }
  const sidecarRoot = await realpath(dirname(root));
  if (await realpath(root) !== join(sidecarRoot, 'source')) throw new Error('release_qualification_invalid: qualification source is not the immutable sidecar source');
  const driverRoot = dirname(dirname(resolve(qualificationDriver)));
  assert.equal(resolve(qualificationDriver), join(driverRoot, descriptor.driver.entry), 'qualification driver path');
  if (await realpath(driverRoot) !== join(sidecarRoot, 'driver')) throw new Error('release_qualification_invalid: qualification driver is not the immutable sidecar driver');
  const dependencyRoot = join(dirname(root), descriptor.dependencies.nodeModules.path);
  if (await realpath(dependencyRoot) !== join(sidecarRoot, 'node_modules')) throw new Error('release_qualification_invalid: qualification dependencies are not the immutable sidecar dependencies');
  const actual = {};
  await collectHashes(root, '', actual);
  delete actual['qualification-manifest.json'];
  assert.deepEqual(Object.keys(actual).sort(), Object.keys(descriptor.files).sort(), 'qualification source inventory');
  for (const [path, digest] of Object.entries(descriptor.files)) assert.equal(actual[path], digest, 'qualification source:' + path);
  const actualDriver = {};
  await collectHashes(driverRoot, '', actualDriver);
  assert.deepEqual(actualDriver, descriptor.driver.files, 'qualification driver inventory');
  assert.equal(await sha256(join(sidecarRoot, descriptor.dependencies.tsx.path)), descriptor.dependencies.tsx.sha256, 'qualification tsx dependency digest');
  const actualDependencies = {};
  await collectDependencyHashes(dependencyRoot, '', actualDependencies);
  assert.deepEqual(actualDependencies, descriptor.dependencies.nodeModules.files, 'qualification dependency inventory');
  return { manifestSha256: expectedManifestSha256, sourceFilesSha256: descriptor.filesSha256, driverFilesSha256: descriptor.driver.filesSha256, dependencyFilesSha256: descriptor.dependencies.nodeModules.filesSha256 };
}


async function verifyArtifacts(record, recordPath, releaseManifest, kind, artifactRoot, trusted) {
  if (!record.artifact) throw new Error(kind + ' release artifact record must contain its exact archive artifact');
  const artifact = record.artifact;
  if (!releaseManifest.archive || releaseManifest.archive.name !== artifact.name || releaseManifest.archive.format !== artifact.format
      || (kind === 'desktop' && (artifact.format !== 'zip' || artifact.prefix !== releaseManifest.archive.prefix))) {
    throw new Error(kind + ' archive descriptor does not match its artifact record');
  }
  const artifacts = record.artifacts ?? [artifact];
  if (kind === 'desktop') {
    const zipArtifacts = artifacts.filter(candidate => candidate?.format === 'zip');
    if (zipArtifacts.length !== 1 || zipArtifacts[0].path !== artifact.path || zipArtifacts[0].sha256 !== artifact.sha256) {
      throw new Error('desktop artifact record has an ambiguous canonical archive');
    }
  }
  const identities = new Set();
  let artifactPath;
  const expectedExtras = new Set(Object.keys(trusted?.expectedDistributableSha256 ?? {}));
  for (const candidate of artifacts) {
    if (!candidate?.name || identities.has(candidate.name)) throw new Error(kind + ' artifact record has duplicate or unnamed distributables');
    identities.add(candidate.name);
    const canonical = candidate.path === artifact.path && candidate.sha256 === artifact.sha256;
    const path = await verifyArtifactFile(candidate, recordPath, kind, artifactRoot, canonical);
    const expectedDigest = canonical ? trusted?.expectedArtifactSha256 : trusted?.expectedDistributableSha256?.[candidate.name];
    if (!expectedDigest) throw new SignatureTrustUnavailableError(`Release qualification is blocked: externally trusted digest missing for ${kind}/${candidate.name}`);
    assert.equal(await sha256(path), expectedDigest, `${kind}/${candidate.name} externally trusted digest`);
    if (canonical) artifactPath = path; else expectedExtras.delete(candidate.name);
  }
  if (expectedExtras.size > 0) throw new Error(kind + ' externally trusted distributable digest names do not match the release record');
  if (!artifactPath) throw new Error(kind + ' canonical archive is missing from its distributable inventory');
  if (record.signature) assert.deepEqual(record.signature, releaseManifest.signature, kind + ' artifact signature identity');
  return artifactPath;
}

async function verifyArtifactFile(artifact, recordPath, kind, artifactRoot, canonical = true) {
  if (!artifact || typeof artifact.path !== 'string' || !Number.isSafeInteger(artifact.bytes) || artifact.bytes < 0
      || !/^[0-9a-f]{64}$/.test(artifact.sha256) || typeof artifact.format !== 'string' || !artifact.format) {
    throw new Error(kind + ' artifact record contains an invalid artifact');
  }
  const path = await resolveArtifactPath(artifact.path, recordPath, artifactRoot);
  const info = await stat(path).catch(() => null);
  if (!info || !info.isFile()) throw new Error(kind + ' artifact is missing: ' + path);
  assert.equal(info.size, artifact.bytes, kind + ' artifact bytes');
  assert.equal(await sha256(path), artifact.sha256, kind + ' artifact digest');
  if (!artifact.name || artifact.name !== basename(path)) throw new Error(kind + ' archive name does not match its record');
  const namedFormat = inferArtifactFormat(artifact.name);
  if (artifact.format !== namedFormat) throw new Error(kind + ' artifact format does not match its filename');
  if (canonical) {
    const expected = kind === 'desktop' ? 'zip' : process.platform === 'win32' ? 'zip' : 'tar.gz';
    if (namedFormat !== expected) throw new Error(kind + ' archive format ' + namedFormat + ' is not valid for ' + process.platform);
  } else if (kind === 'desktop') {
    const allowed = process.platform === 'linux' ? new Set(['deb', 'rpm'])
      : process.platform === 'darwin' ? new Set(['dmg'])
        : new Set(['exe', 'msi', 'nupkg', 'file']);
    if (!allowed.has(namedFormat) || (namedFormat === 'file' && artifact.name !== 'RELEASES')) throw new Error(kind + ' release record contains an unsupported distributable type: ' + artifact.name);
  }
  return path;
}

function inferArtifactFormat(name) {
  const lower = name.toLowerCase();
  if (lower.endsWith('.tar.gz')) return 'tar.gz';
  if (lower.endsWith('.zip')) return 'zip';
  const extension = lower.slice(lower.lastIndexOf('.') + 1);
  return extension === lower ? 'file' : extension;
}

async function validateSignature(signature, record, recordPath, artifactPath, trusted, input, releaseRoot) {
  if (!signature || !['unsigned-development', 'signed'].includes(signature.status)) throw new Error(`release signature status is invalid: ${recordPath}`);
  if (!trusted?.expectedArtifactSha256) {
    throw new SignatureTrustUnavailableError('Release qualification is blocked: an externally trusted artifact SHA-256 is required for every release variant');
  }
  assert.equal(await sha256(artifactPath), trusted.expectedArtifactSha256, `${record.kind} externally trusted artifact digest`);
  if (process.platform === 'linux') return verifyPlatformSignature(trusted, artifactPath, input, releaseRoot, record.kind);
  if (signature.status === 'signed') {
    assert.equal(signature.label, 'SIGNED RELEASE ARTIFACT');
    assert.equal(signature.authenticated, true);
    assert.equal(signature.verified, true);
    assert.ok(typeof signature.algorithm === 'string' && signature.algorithm.length > 0);
  }
  return {
    status: 'signed',
    label: 'EXTERNALLY AUTHENTICATED RELEASE ARTIFACT',
    authenticated: true,
    verified: true,
    algorithm: 'sha256-trust-anchor',
    expectedArtifactSha256: trusted.expectedArtifactSha256,
    candidateSignatureStatus: signature.status,
  };
}

async function verifyPlatformSignature(trusted, artifactPath, input, releaseRoot, kind) {
  if (!trusted?.keyring || !trusted.fingerprint || !trusted.expectedArtifactSha256 || !trusted.signatureFile) {
    throw new SignatureTrustUnavailableError('Linux release qualification is blocked: trusted keyring, signer fingerprint, expected artifact SHA-256, and detached signature file are required outside the candidate');
  }
  if (isWithin(input, trusted.keyring) || isWithin(input, trusted.signatureFile)) {
    throw new Error('Linux signature trust inputs must be outside the candidate release');
  }
  const proof = await verifyDetachedSignature({
    artifactPath,
    signatureFile: trusted.signatureFile,
    trustedKeyring: trusted.keyring,
    trustedFingerprint: trusted.fingerprint,
    expectedArtifactSha256: trusted.expectedArtifactSha256,
  });
  return { status: 'signed', label: 'SIGNED RELEASE ARTIFACT', authenticated: true, verified: true, algorithm: 'gpgv', verification: proof };
}
async function verifyNativePayload(record, recordPath, kind, applicationRoot, manifest, artifactRoot, trusted) {
  if (kind !== 'desktop' || process.platform === 'linux') return null;
  const entry = manifest?.resources?.electronEntry;
  if (typeof entry !== 'string') throw new Error('desktop manifest has no canonical native entry');
  const executable = resolveSafePath(applicationRoot, entry, 'canonical native entry');
  const [rootPhysical, executablePhysical] = await Promise.all([realpath(applicationRoot), realpath(executable)]);
  if (!isWithin(rootPhysical, executablePhysical)) throw new Error('canonical native entry escapes authenticated application root');
  const distributables = [];
  if (process.platform === 'darwin') {
    if (!trusted?.expectedTeamIdentifier) throw new SignatureTrustUnavailableError('macOS release qualification is blocked: an externally trusted TeamIdentifier is required');
    const appBundle = dirname(applicationRoot);
    if (!appBundle.endsWith('.app')) throw new Error('authenticated macOS archive has no canonical application bundle');
    runVerifier('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appBundle]);
    const gatekeeper = captureVerifier('spctl', ['--assess', '--type', 'execute', '--verbose=4', appBundle]);
    const stapler = captureVerifier('xcrun', ['stapler', 'validate', appBundle]);
    const detail = captureVerifier('codesign', ['-dv', '--verbose=4', appBundle]);
    const team = /(?:^|\n)TeamIdentifier=([^\r\n]+)/.exec(detail)?.[1];
    assert.equal(team, trusted.expectedTeamIdentifier, 'macOS signer TeamIdentifier');
    if (!/notarized|ticket/i.test(gatekeeper + stapler)) throw new Error('macOS application has no notarization evidence');
    for (const artifact of record.artifacts ?? []) {
      const format = inferArtifactFormat(artifact.name);
      if (format !== 'dmg' && format !== 'pkg') continue;
      const path = await resolveArtifactPath(artifact.path, recordPath, artifactRoot);
      const assessment = format === 'dmg'
        ? captureVerifier('spctl', ['--assess', '--type', 'open', '--context', 'context:primary-signature', '--verbose=4', path])
        : captureVerifier('spctl', ['--assess', '--type', 'install', '--verbose=4', path]);
      const ticket = captureVerifier('xcrun', ['stapler', 'validate', path]);
      if (!assessment.includes(trusted.expectedTeamIdentifier) || !/notarized|ticket/i.test(assessment + ticket)) throw new Error('macOS distributable signer/notarization identity mismatch: ' + artifact.name);
      distributables.push({ name: artifact.name, method: 'spctl+stapler', assessment, ticket });
    }
    return { method: 'codesign', application: basename(appBundle), entry, teamIdentifier: team, gatekeeper, stapler, distributables };
  }
  if (process.platform === 'win32') {
    if (!trusted?.expectedCertificateThumbprint) throw new SignatureTrustUnavailableError('Windows release qualification is blocked: an externally trusted certificate thumbprint is required');
    const signedPaths = [{ name: entry, path: executablePhysical }];
    for (const artifact of record.artifacts ?? []) if (['exe', 'msi', 'appx', 'msix'].includes(inferArtifactFormat(artifact.name))) {
      signedPaths.push({ name: artifact.name, path: await resolveArtifactPath(artifact.path, recordPath, artifactRoot) });
    }
    for (const signed of signedPaths) {
      runVerifier('signtool', ['verify', '/pa', '/all', signed.path]);
      const thumbprint = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '(Get-AuthenticodeSignature -LiteralPath $args[0]).SignerCertificate.Thumbprint', signed.path], { encoding: 'utf8', windowsHide: true }).trim().toUpperCase();
      assert.equal(thumbprint, trusted.expectedCertificateThumbprint, 'Windows signer certificate thumbprint: ' + signed.name);
      distributables.push({ name: signed.name, method: 'signtool', certificateThumbprint: thumbprint });
    }
    return { method: 'signtool', application: entry, certificateThumbprint: trusted.expectedCertificateThumbprint, distributables };
  }
  throw new Error('unsupported platform signature verifier: ' + process.platform);
}

function captureVerifier(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true });
  if (result.error || result.status !== 0) throw new Error(`signature verification failed (${command}): ${result.error?.message ?? String(result.stderr)}`);
  return String(result.stdout) + String(result.stderr);
}

function runVerifier(command, args) {
  captureVerifier(command, args);
}


function validateArchiveEntries(archive, format, kind, expectedPrefix) {
  let output;
  if (format === 'zip') output = execFileSync('unzip', ['-Z1', archive], { encoding: 'utf8', windowsHide: true });
  else if (format === 'tar.gz') output = execFileSync('tar', ['--list', '--gzip', '--file', archive], { encoding: 'utf8', windowsHide: true });
  else throw new Error('unsupported archive format: ' + format);
  const names = String(output).split(/\r?\n/u).filter(Boolean);
  if (names.length === 0) throw new Error('archive contains no entries');
  const roots = new Set();
  let hasRootDirectory = false;
  for (const rawName of names) {
    const name = rawName.replace(/^(?:\.\/)+/u, '');
    const directory = name.endsWith('/');
    const trimmed = name.replace(/\/+$/u, '');
    if (!trimmed || !isSafeRelative(trimmed)) throw new Error('archive contains an unsafe entry path: ' + rawName);
    roots.add(trimmed.split('/')[0]);
    if (directory && trimmed.split('/').length === 1) hasRootDirectory = true;
  }
  if (kind === 'desktop') {
    if (!isSafeArchivePrefix(expectedPrefix) || roots.size !== 1 || [...roots][0] + '/' !== expectedPrefix || !hasRootDirectory) {
      throw new Error('desktop archive must contain exactly its recorded top-level root');
    }
  }
}

function stripArchivePrefix(files, prefix) {
  if (!prefix) return files;
  if (!isSafeArchivePrefix(prefix)) throw new Error('archive prefix is unsafe');
  const stripped = {};
  for (const [path, digest] of Object.entries(files)) {
    if (!path.startsWith(prefix) || path.length === prefix.length) throw new Error('archive contains an extra top-level root');
    const relativePath = path.slice(prefix.length);
    if (!isSafeRelative(relativePath)) throw new Error('archive contains an unsafe prefixed path: ' + path);
    stripped[relativePath] = digest;
  }
  return stripped;
}

function isSafeArchivePrefix(prefix) {
  if (typeof prefix !== 'string' || !prefix.endsWith('/') || prefix.startsWith('/') || prefix.includes('\\')) return false;
  const value = prefix.slice(0, -1);
  return value.length > 0 && isSafeRelative(value);
}

 async function extractArchive(archive, destination, format) {
  await mkdir(destination, { recursive: true });
  if (format === 'tar.gz') {
    execFileSync('tar', ['--extract', '--gzip', '--file', archive, '--directory', destination, '--no-same-owner'], { stdio: 'inherit', windowsHide: true });
  } else if (format === 'zip' && process.platform === 'win32') {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '$ErrorActionPreference = "Stop"; Expand-Archive -LiteralPath $env:ALDER_ARCHIVE_INPUT -DestinationPath $env:ALDER_ARCHIVE_DESTINATION -Force'], {
      env: { ...process.env, ALDER_ARCHIVE_INPUT: archive, ALDER_ARCHIVE_DESTINATION: destination },
      stdio: 'inherit',
      windowsHide: true,
    });
  } else if (format === 'zip') {
    execFileSync('unzip', ['-q', archive, '-d', destination], { stdio: 'inherit', windowsHide: true });
  } else {
    throw new Error('unsupported release artifact format: ' + format);
  }
}
async function findBundledNode(base, manifest) {
  const declared = manifest?.resources?.nodeExecutable;
  if (typeof declared !== 'string' || !isSafeRelative(declared)) return null;
  const candidate = join(base, declared);
  if (!await exists(candidate)) return null;
  const basePhysical = await realpath(base).catch(() => null);
  const candidatePhysical = await realpath(candidate).catch(() => null);
  if (!basePhysical || !candidatePhysical || !isWithin(basePhysical, candidatePhysical)) {
    throw new Error('release_invalid: bundled Node runtime escapes the release root');
  }
  return candidate;
}

async function resolveArtifactPath(value, recordPath, artifactRoot) {
  if (!isSafeArtifactRelative(value)) throw new Error(`release_invalid: unsafe artifact path ${value}`);
  const candidate = resolve(dirname(recordPath), value);
  const [rootPhysical, candidatePhysical] = await Promise.all([realpath(artifactRoot), realpath(candidate)]);
  if (!isWithin(rootPhysical, candidatePhysical)) {
    throw new Error(`release_invalid: artifact path escapes explicit qualification root: ${value}`);
  }
  return candidatePhysical;
}

function isSafeArtifactRelative(value) {
  return typeof value === 'string' && value.length > 0 && !value.includes('\\') && !value.includes('\0') && !value.startsWith('/')
    && !/^[A-Za-z]:/.test(value) && value.split('/').every(part => part && part !== '.');
}

function resolveSafePath(base, value, label) {
  assertSafeRelative(value);
  const path = resolve(base, value);
  if (!isWithin(base, path)) throw new Error(`${label} escapes its parent`);
  return path;
}

function assertSafeRelative(value) {
  if (!isSafeRelative(value)) throw new Error(`release_invalid: unsafe path ${value}`);
}

function isSafeRelative(value) {
  return typeof value === 'string' && value.length > 0 && !value.includes('\\') && !value.includes('\0') && !value.startsWith('/')
    && !/^[A-Za-z]:/.test(value) && value.split('/').every(part => part && part !== '.' && part !== '..');
}

function isWithin(parent, child) {
  const resolvedParent = resolve(parent);
  const resolvedChild = resolve(child);
  return resolvedChild === resolvedParent || resolvedChild.startsWith(resolvedParent + sep);
}

async function collectDependencyHashes(directory, prefix, result, root = directory) {
  const physicalRoot = await realpath(root);
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(directory, entry.name);
    const child = `${prefix}${entry.name}`;
    if (entry.isDirectory()) await collectDependencyHashes(path, `${child}/`, result, root);
    else if (entry.isFile()) result[child.split(sep).join('/')] = await sha256(path);
    else if (entry.isSymbolicLink()) {
      const target = await realpath(path).catch(() => null);
      if (target === null || !isWithin(physicalRoot, target)) throw new Error('qualification dependency symlink escapes node_modules: ' + child);
      result[child.split(sep).join('/')] = sha256Text('link\0' + await readlink(path));
    } else throw new Error('qualification dependency contains unsupported entry: ' + path);
  }
}

async function collectHashes(directory, prefix, result, root = directory) {
  const physicalRoot = await realpath(root);
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(directory, entry.name);
    const child = `${prefix}${entry.name}`;
    if (entry.isDirectory()) await collectHashes(path, `${child}/`, result, root);
    else if (entry.isFile()) result[child.split(sep).join('/')] = await sha256(path);
    else if (entry.isSymbolicLink()) {
      const physical = await realpath(path).catch(() => null);
      if (!physical || !isWithin(physicalRoot, physical)) throw new Error('release inventory symlink escapes root: ' + child);
      result[child.split(sep).join('/')] = sha256Text(await readlink(path));
    } else throw new Error('release inventory contains unsupported entry: ' + path);
  }
}

async function chmodTree(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await chmodTree(path);
    else if (entry.isFile()) {
      const mode = (await stat(path)).mode & 0o111;
      await chmod(path, 0o444 | mode);
    }
  }
}

function cleanEnvironment() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('ALDER_') || key === 'R_HOME' || key.startsWith('R_LIBS')) delete env[key];
  return env;
}

function isBlockedError(error) {
  const message = String(error?.message ?? error);
  return error?.code === 'scenario_blocked' || error?.code === 'scenario_unavailable' || error?.code === 'signature_trust_unavailable'
    || /(?:scenario_unavailable|signature_trust_unavailable|desktop_unavailable|desktop_cdp_unavailable|desktop_cdp_timeout|desktop_launch_failed|desktop_single_instance_failed|browser_unavailable|host_ready_timeout|session_registry_timeout|r_invalid|r_not_found)/.test(message);
}

function describeError(error) {
  const result = { name: error?.name ?? 'Error', message: String(error?.message ?? error) };
  if (error?.code) result.code = error.code;
  if (error?.report) result.scenarioReport = error.report;
  if (error?.stack) result.stack = error.stack;
  return result;
}

async function readJsonRequired(path, label) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    throw new Error(`${label} is missing or invalid: ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function exists(path) {
  try { await stat(path); return true; } catch { return false; }
}

async function sha256(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

function sha256Text(text) {
  return createHash('sha256').update(text).digest('hex');
}

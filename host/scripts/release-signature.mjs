import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { tmpdir } from 'node:os';

export class SignatureTrustUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SignatureTrustUnavailableError';
    this.code = 'signature_trust_unavailable';
  }
}

export function normalizeFingerprint(value, label = 'signer fingerprint') {
  if (typeof value !== 'string') throw new Error(`${label} must be a 40-hex primary fingerprint`);
  const normalized = value.replace(/\s+/g, '').toUpperCase();
  if (!/^[0-9A-F]{40}$/.test(normalized)) throw new Error(`${label} must be a 40-hex primary fingerprint`);
  return normalized;
}

export function normalizeSha256(value, label = 'expected artifact SHA-256') {
  if (typeof value !== 'string' || !/^[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`${label} must be a 64-hex SHA-256 digest`);
  }
  return value.toLowerCase();
}

export async function verifyDetachedSignature({
  artifactPath,
  signatureFile,
  trustedKeyring,
  trustedFingerprint,
  expectedArtifactSha256,
}) {
  assertAbsoluteFileInput(artifactPath, 'artifact');
  assertAbsoluteFileInput(signatureFile, 'detached signature');
  assertAbsoluteFileInput(trustedKeyring, 'trusted keyring');
  const expectedFingerprint = normalizeFingerprint(trustedFingerprint);
  const expectedDigest = normalizeSha256(expectedArtifactSha256);
  await requireRegularFile(artifactPath, 'artifact');
  await requireRegularFile(signatureFile, 'detached signature');
  await requireRegularFile(trustedKeyring, 'trusted keyring');

  const artifactSha256 = createHash('sha256').update(await readFile(artifactPath)).digest('hex');
  if (artifactSha256 !== expectedDigest) {
    throw new Error(`signed artifact digest does not match the externally expected SHA-256 (expected ${expectedDigest}, got ${artifactSha256})`);
  }

  const home = await mkdtemp(join(tmpdir(), 'alder-gpgv-'));
  try {
    const result = spawnSync('gpgv', [
      '--no-options',
      '--status-fd', '1',
      '--keyring', trustedKeyring,
      signatureFile,
      artifactPath,
    ], {
      env: { LANG: 'C', LC_ALL: 'C', GNUPGHOME: home },
      encoding: 'utf8',
      timeout: 120_000,
      windowsHide: true,
    });
    if (result.error?.code === 'ETIMEDOUT') throw new Error('gpgv signature verification timed out');
    const status = parseStatus(String(result.stdout ?? ''));
    if (result.status !== 0) {
      const detail = String(result.stderr ?? '').trim();
      throw new Error(`gpgv rejected the detached signature${detail ? `: ${detail}` : ''}`);
    }
    if (status.bad.length > 0 || status.errors.length > 0 || status.valid.length !== 1) {
      throw new Error('gpgv did not produce exactly one valid detached signature');
    }
    const valid = status.valid[0];
    if (valid.primaryFingerprint !== expectedFingerprint) {
      throw new Error(`detached signature signer fingerprint ${valid.primaryFingerprint} does not match the externally trusted fingerprint ${expectedFingerprint}`);
    }
    return {
      method: 'gpgv',
      verified: true,
      primaryFingerprint: valid.primaryFingerprint,
      signerFingerprint: valid.signerFingerprint,
      artifactSha256,
    };
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

function parseStatus(output) {
  const valid = [];
  const bad = [];
  const errors = [];
  for (const line of output.split(/\r?\n/)) {
    const match = /^\[GNUPG:\] (\S+)(?: (.*))?$/.exec(line);
    if (!match) continue;
    const [, tag, rest = ''] = match;
    if (tag === 'VALIDSIG') {
      const fields = rest.trim().split(/\s+/).filter(Boolean);
      const signerFingerprint = normalizeFingerprint(fields[0], 'gpgv signer fingerprint');
      const primaryFingerprint = normalizeFingerprint(
        fields.slice(1).filter(field => /^[0-9a-fA-F]{40}$/.test(field)).at(-1) ?? fields[0],
        'gpgv primary fingerprint',
      );
      valid.push({ signerFingerprint, primaryFingerprint });
    } else if (tag === 'BADSIG' || tag === 'EXPSIG' || tag === 'EXPKEYSIG' || tag === 'REVKEYSIG') {
      bad.push(tag);
    } else if (tag === 'ERRSIG' || tag === 'NO_PUBKEY' || tag === 'NODATA' || tag === 'FAILURE') {
      errors.push(tag);
    }
  }
  return { valid, bad, errors };
}

function assertAbsoluteFileInput(value, label) {
  if (typeof value !== 'string' || !isAbsolute(value)) throw new Error(`${label} path must be absolute`);
}

async function requireRegularFile(path, label) {
  const info = await stat(path).catch(error => {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') throw new SignatureTrustUnavailableError(`${label} is unavailable: ${path}`);
    throw error;
  });
  if (!info.isFile()) throw new Error(`${label} is not a regular file: ${path}`);
}

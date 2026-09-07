import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, realpath, rename, stat, unlink } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import {
  MAX_NOTEBOOK_SOURCE_BYTES,
  MAX_SOURCE_LINES,
  MAX_SOURCE_LINE_LENGTH,
  notebookInputSchema,
} from './protocol.js';

const MAX_NOTEBOOK_BYTES = MAX_NOTEBOOK_SOURCE_BYTES;
const MAX_SIDECAR_BYTES = 8 * 1024 * 1024;
const CODEC_LINE_ENCODING = 'base64-lines-v1';

export interface RServices {
  service(command: string, payload?: Record<string, unknown>): Promise<unknown>;
}
export interface SourceCell {
  id: string;
  type: 'code' | 'markdown';
  body: string[];
  options?: Record<string, unknown>;
  revision?: number;
}
export interface SourceNotebook {
  path?: string | null;
  metadata?: Record<string, unknown>;
  cells: SourceCell[];
}
interface DiskVersion { bytes: Buffer; identity: string | null; mode: number; }

export class FileConflict extends Error {
  readonly code = 'source_conflict';
  constructor(message = 'Notebook changed on disk; reload before saving') { super(message); }
}

async function diskVersion(path: string): Promise<DiskVersion> {
  let file;
  try { file = await open(path, 'r'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { bytes: Buffer.alloc(0), identity: null, mode: 0o600 };
    }
    throw error;
  }
  try {
    const info = await file.stat({ bigint: true });
    if (!info.isFile()) throw new Error('Notebook path must be a regular file');
    if (info.size > BigInt(MAX_NOTEBOOK_BYTES)) throw new Error('Notebook exceeds 32 MiB source limit');
    const limit = MAX_NOTEBOOK_BYTES;
    const chunks: Buffer[] = [];
    let length = 0;
    while (length <= limit) {
      const chunk = Buffer.allocUnsafe(Math.min(65536, limit + 1 - length));
      const read = await file.read(chunk, 0, chunk.length, null);
      if (read.bytesRead === 0) break;
      chunks.push(chunk.subarray(0, read.bytesRead));
      length += read.bytesRead;
    }
    if (length > limit) throw new Error('Notebook exceeds 32 MiB source limit');
    return {
      bytes: Buffer.concat(chunks, length),
      identity: `${info.dev}:${info.ino}`,
      mode: Number(info.mode & 0o777n),
    };
  } finally { await file.close(); }
}

function sameDisk(left: DiskVersion, right: DiskVersion): boolean {
  return left.identity === right.identity && left.mode === right.mode && left.bytes.equals(right.bytes);
}

function invalidServiceResponse(message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code: 'invalid_service_response' });
}

function decodeBase64(value: unknown, maximum = MAX_NOTEBOOK_BYTES): Buffer {
  if (typeof value !== 'string' || value.length > Math.ceil(maximum / 3) * 4) {
    throw invalidServiceResponse('codec returned invalid notebook bytes');
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length > maximum || bytes.toString('base64') !== value) {
    throw invalidServiceResponse('codec returned invalid notebook bytes');
  }
  return bytes;
}

function encodedText(value: unknown, kind: string): string {
  if (typeof value !== 'string' || Buffer.byteLength(value) > MAX_SIDECAR_BYTES
    || value.includes('\0') || Buffer.from(value, 'utf8').toString('utf8') !== value) {
    throw invalidServiceResponse(`${kind} encoder returned invalid text`);
  }
  return value;
}

function codecCells(cells: readonly SourceCell[]): Record<string, unknown>[] {
  let sourceBytes = 0;
  return cells.map(cell => ({
    id: cell.id,
    type: cell.type,
    body_base64: cell.body.map((line, index) => {
      if (typeof line !== 'string' || line.includes('\0') || /[\r\n]/.test(line)
        || Buffer.from(line, 'utf8').toString('utf8') !== line) {
        throw new TypeError('Notebook source must contain valid UTF-8 lines');
      }
      const bytes = Buffer.from(line, 'utf8');
      sourceBytes += bytes.length + (index === 0 ? 0 : 1);
      if (sourceBytes > MAX_NOTEBOOK_BYTES) {
        throw new Error('Notebook exceeds 32 MiB source limit');
      }
      return bytes.toString('base64');
    }),
    options: cell.options === undefined ? undefined : structuredClone(cell.options),
  }));
}

function decodeCodecLines(value: unknown, budget: { bytes: number }): string[] {
  if (!Array.isArray(value) || value.length > MAX_SOURCE_LINES) {
    throw invalidServiceResponse('codec returned invalid source lines');
  }
  return value.map((encoded, index) => {
    if (typeof encoded !== 'string'
      || encoded.length > Math.ceil(MAX_NOTEBOOK_BYTES / 3) * 4) {
      throw invalidServiceResponse('codec returned invalid source lines');
    }
    const bytes = Buffer.from(encoded, 'base64');
    const separatorBytes = index === 0 ? 0 : 1;
    if (bytes.length > MAX_NOTEBOOK_BYTES || bytes.toString('base64') !== encoded
      || bytes.includes(0)
      || budget.bytes + bytes.length + separatorBytes > MAX_NOTEBOOK_BYTES) {
      throw invalidServiceResponse('codec returned invalid source lines');
    }
    const line = bytes.toString('utf8');
    if (line.length > MAX_SOURCE_LINE_LENGTH
      || Buffer.from(line, 'utf8').toString('base64') !== encoded || /[\r\n]/.test(line)) {
      throw invalidServiceResponse('codec returned invalid source lines');
    }
    budget.bytes += bytes.length + separatorBytes;
    return line;
  });
}

function decodeCodecNotebook(value: unknown): unknown {
  if (!isRecord(value) || value.encoding !== CODEC_LINE_ENCODING
    || !Array.isArray(value.cells)) return value;
  const budget = { bytes: 0 };
  const cells = value.cells.map(cell => {
    if (!isRecord(cell)) throw invalidServiceResponse('codec returned an invalid notebook');
    const { body_base64: encoded, ...rest } = cell;
    return { ...rest, body: decodeCodecLines(encoded, budget) };
  });
  const { encoding: _encoding, ...rest } = value;
  return { ...rest, cells };
}

function decodeCodecRecord(value: unknown, budget: { bytes: number }): Record<string, unknown> {
  if (!isRecord(value) || typeof value.text_base64 !== 'string'
    || typeof value.kind !== 'string'
    || typeof value.eol !== 'string' || !['', '\n', '\r', '\r\n'].includes(value.eol)) {
    throw invalidServiceResponse('codec returned invalid physical records');
  }
  const [text] = decodeCodecLines([value.text_base64], budget);
  budget.bytes += Buffer.byteLength(value.eol);
  if (budget.bytes > MAX_NOTEBOOK_BYTES) {
    throw invalidServiceResponse('codec returned oversized physical records');
  }
  return { text, eol: value.eol, kind: value.kind };
}

function decodeCodecDocument(value: unknown): unknown {
  if (!isRecord(value) || value.encoding !== CODEC_LINE_ENCODING
    || !Array.isArray(value.headerRecords) || !Array.isArray(value.cells)) return value;
  const budget = { bytes: 0 };
  const headerRecords = value.headerRecords.map(record => decodeCodecRecord(record, budget));
  const cells = value.cells.map(cell => {
    if (!isRecord(cell) || typeof cell.id !== 'string' || typeof cell.type !== 'string'
      || !Array.isArray(cell.records)) {
      throw invalidServiceResponse('codec returned invalid document cells');
    }
    const records = cell.records.map(record => decodeCodecRecord(record, budget));
    return {
      id: cell.id,
      type: cell.type,
      body: records.filter(record => record.kind === 'body').map(record => record.text),
      records,
    };
  });
  const records = [...headerRecords, ...cells.flatMap(cell => cell.records)];
  const text = records.map(record => `${String(record.text)}${String(record.eol ?? '')}`).join('');
  return { path: value.path, text, headerRecords, cells };
}

// Only this store mutates source bytes. R returns candidate records; it never
// decides whether a revision is current or writes the interactive notebook.
export class DocumentStore {
  private version!: DiskVersion;
  private ids: string[] = [];
  private readonly sidecars = new Map<string, DiskVersion>();
  private readonly sidecarTargets = new Map<string, string>();
  private queue: Promise<unknown> = Promise.resolve();
  private documentCache?: { key: string; value: Promise<unknown> };
  private constructor(readonly path: string, private readonly spelling: string,
    private readonly r: RServices) {}

  static async open(path: string, r: RServices): Promise<{ store: DocumentStore; notebook: SourceNotebook }> {
    const spelling = resolve(path);
    let canonical: string;
    try { canonical = await realpath(spelling); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      canonical = join(await realpath(dirname(spelling)), basename(spelling));
    }
    const store = new DocumentStore(canonical, spelling, r);
    store.version = await diskVersion(canonical);
    for (const file of [join(dirname(canonical), '.alder', 'config.yaml'), `${canonical}.alder-layout.json`]) {
      store.sidecars.set(file, await diskVersion(file));
      store.sidecarTargets.set(file, await canonicalDestination(file));
    }
    const decoded = await r.service('codec.decode', {
      bytes: store.version.bytes.toString('base64'), path: canonical, compact: true,
    });
    const candidate = typeof decoded === 'object' && decoded !== null && 'notebook' in decoded
      ? decodeCodecNotebook((decoded as { notebook: unknown }).notebook) : undefined;
    const parsed = notebookInputSchema.safeParse(candidate);
    if (!parsed.success) throw invalidServiceResponse('codec returned an invalid notebook');
    const notebook = parsed.data as SourceNotebook;
    store.ids = notebook.cells.map(cell => cell.id);
    return { store, notebook };
  }

  private payload(snapshot: SourceNotebook): Record<string, unknown> {
    return { bytes: this.version.bytes.toString('base64'), ids: [...this.ids],
      path: this.path, cells: codecCells(snapshot.cells),
      metadata: snapshot.metadata === undefined ? undefined : structuredClone(snapshot.metadata),
      compact: true };
  }

  matchesSource(base64: string): boolean {
    try { return this.version.bytes.equals(decodeBase64(base64)); }
    catch { return false; }
  }

  async format(cells: SourceCell[]): Promise<Record<string, string[]>> {
    return await this.r.service('format', this.payload({ cells })) as Record<string, string[]>;
  }

  async document(snapshot: SourceNotebook): Promise<unknown> {
    const payload = this.payload(snapshot);
    const key = JSON.stringify(payload);
    if (this.documentCache?.key !== key) {
      const value = this.r.service('codec.document', payload).then(decodeCodecDocument);
      const entry = { key, value };
      this.documentCache = entry;
      void value.catch(() => { if (this.documentCache === entry) this.documentCache = undefined; });
    }
    // LSP adds revision/URI metadata to its own document projection.
    return structuredClone(await this.documentCache!.value);
  }

  async renderMarkdown(body: string[]): Promise<unknown> {
    return this.r.service('markdown.render', { body });
  }

  async updateConfig(config: Record<string, unknown>): Promise<unknown> {
    const encoded = await this.r.service('config.encode', { config });
    if (!isRecord(encoded) || !isRecord(encoded.config)) {
      throw invalidServiceResponse('config encoder returned invalid data');
    }
    const text = encodedText(encoded.text, 'config');
    await this.writeSidecar(join(dirname(this.path), '.alder', 'config.yaml'), text);
    return { config: encoded.config };
  }

  async updateLayout(layout: unknown): Promise<unknown> {
    const encoded = await this.r.service('layout.encode', { layout });
    if (!isRecord(encoded) || !Object.hasOwn(encoded, 'layout')) {
      throw invalidServiceResponse('layout encoder returned invalid data');
    }
    const text = encodedText(encoded.text, 'layout');
    await this.writeSidecar(`${this.path}.alder-layout.json`, text);
    return { layout: encoded.layout };
  }

  private writeSidecar(path: string, text: string): Promise<void> {
    const next = this.queue.then(async () => {
      const expected = this.sidecars.get(path)!;
      const target = this.sidecarTargets.get(path)!;
      const assertUnchanged = async () => {
        if (await canonicalDestination(path) !== target || !sameDisk(expected, await diskVersion(target))) {
          throw new FileConflict('Notebook sidecar changed on disk');
        }
      };
      await assertUnchanged();
      await mkdir(dirname(target), { recursive: true });
      const stage = join(dirname(target), `.alder-sidecar-${randomUUID()}`);
      try {
        const file = await open(stage, 'wx', expected.mode);
        try { await file.chmod(expected.mode); await file.writeFile(text); await file.sync(); }
        finally { await file.close(); }
        await assertUnchanged();
        await rename(stage, target);
        this.sidecars.set(path, await diskVersion(target));
      } finally { await unlink(stage).catch(error => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }); }
    });
    this.queue = next.catch(() => {});
    return next;
  }

  save(snapshot: SourceNotebook): Promise<{ path: string; changed: false }> {
    // Freeze before waiting for another save or R formatting work. Caller owns
    // deciding whether a later edit keeps its dirty indicator after this ACK.
    const fixed = structuredClone(snapshot);
    const next = this.queue.then(() => this.commit(fixed));
    this.queue = next.catch(() => {});
    return next;
  }

  private async assertUnchanged(): Promise<void> {
    let canonical: string;
    try { canonical = await realpath(this.spelling); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      canonical = join(await realpath(dirname(this.spelling)), basename(this.spelling));
    }
    if (canonical !== this.path || !sameDisk(this.version, await diskVersion(this.path))) {
      throw new FileConflict();
    }
  }

  private async commit(snapshot: SourceNotebook): Promise<{ path: string; changed: false }> {
    await this.assertUnchanged();
    const encoded = await this.r.service('codec.encode', this.payload(snapshot));
    if (!isRecord(encoded) || !Array.isArray(encoded.ids)
      || encoded.ids.some(id => typeof id !== 'string' || !id || id.length > 256)
      || encoded.ids.length !== snapshot.cells.length
      || encoded.ids.some((id, index) => id !== snapshot.cells[index]!.id)
      || new Set(encoded.ids).size !== encoded.ids.length) {
      throw invalidServiceResponse('codec returned invalid cell identities');
    }
    const bytes = decodeBase64(encoded.bytes);
    const stage = join(dirname(this.path), `.alder-save-${randomUUID()}`);
    try {
      const file = await open(stage, 'wx', this.version.mode);
      try { await file.chmod(this.version.mode); await file.writeFile(bytes); await file.sync(); }
      finally { await file.close(); }
      // R can take arbitrarily long; recheck after serialization and staging.
      await this.assertUnchanged();
      await rename(stage, this.path);
      const committed = await diskVersion(this.path);
      if (!committed.bytes.equals(bytes)) throw new FileConflict();
      this.version = committed;
      this.ids = [...encoded.ids];
      return { path: this.path, changed: false };
    } finally { await unlink(stage).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }); }
  }
}

async function canonicalDestination(path: string): Promise<string> {
  try { return await realpath(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(await canonicalDestination(parent), basename(path));
  }
}

export async function sameFile(first: string, second: string): Promise<boolean> {
  if (resolve(first) === resolve(second)) return true;
  try {
    const [a, b] = await Promise.all([stat(first, { bigint: true }), stat(second, { bigint: true })]);
    return a.dev === b.dev && a.ino === b.ino;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function readJsonFile(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8'));
}

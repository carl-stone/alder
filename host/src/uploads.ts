import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { canonicalBase64ByteLength } from './protocol.js';

export const UPLOAD_MAX_FILES = 1_024;
export const UPLOAD_MAX_BASE64_BYTES = 16 * 1024 * 1024;
export const UPLOAD_MAX_TOTAL_BYTES = 12 * 1024 * 1024;

const filesSchema = z.array(z.object({
  name: z.string().min(1).max(32 * 1024).refine(name => (
    !/[\u0000\u0001-\u001f\u007f\r\n/\\]/.test(name)
    && name !== "."
    && name !== ".."
    && !name.startsWith(".")
  ), "upload name must be a plain, non-hidden file name"),
  content_base64: z.string().max(UPLOAD_MAX_BASE64_BYTES).refine(value => canonicalBase64ByteLength(value) !== null, "file content_base64 is invalid"),
}).strict()).max(UPLOAD_MAX_FILES);

type UploadBatchFile = { name: string; size: number; path: string };

function invalid(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

export class UploadStore {
  private readonly batches = new Map<string, string[]>();
  private closed = false;

  constructor(private readonly directory: string) {}

  private async ensureDirectory(): Promise<void> {
    if (this.closed) throw invalid("session_stopped", "upload store is closed");
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const info = await lstat(this.directory);
    if (info.isSymbolicLink() || !info.isDirectory()) throw invalid("invalid_request", "upload directory is not a directory");
    await chmod(this.directory, 0o700);
  }

  async store(input: unknown): Promise<{ uploadId: string; value: UploadBatchFile[] }> {
    if (this.closed) throw invalid("session_stopped", "upload store is closed");
    const parsed = filesSchema.safeParse(input);
    if (!parsed.success) throw invalid("invalid_request", "upload request is invalid");
    const files = parsed.data;
    let total = 0;
    const decoded = files.map(file => {
      const bytes = Buffer.from(file.content_base64, "base64");
      total += bytes.length;
      if (total > UPLOAD_MAX_TOTAL_BYTES) throw invalid("payload_too_large", "decoded upload data exceeds 12 MiB");
      return { name: file.name, bytes };
    });

    await this.ensureDirectory();
    const uploadId = randomUUID();
    const paths: string[] = [];
    this.batches.set(uploadId, paths);
    try {
      const value: UploadBatchFile[] = [];
      for (const file of decoded) {
        if (this.closed) throw invalid("session_stopped", "upload store is closed");
        const path = join(this.directory, `upload-${randomUUID()}`);
        paths.push(path);
        await writeFile(path, file.bytes, { flag: "wx", mode: 0o600 });
        await chmod(path, 0o600);
        value.push({ name: file.name, size: file.bytes.length, path });
      }
      return { uploadId, value };
    } catch (error) {
      await this.remove(uploadId);
      throw error;
    }
  }

  async remove(uploadId: string): Promise<void> {
    const paths = this.batches.get(uploadId) ?? [];
    this.batches.delete(uploadId);
    await Promise.all(paths.map(path => unlink(path).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    })));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const uploadIds = [...this.batches.keys()];
    await Promise.all(uploadIds.map(uploadId => this.remove(uploadId)));
  }
}

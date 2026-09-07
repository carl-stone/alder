import { randomUUID } from 'node:crypto';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

const filesSchema = z.array(z.object({
  name: z.string().min(1).max(4096).refine(name => !/[\u0000\r\n/\\]/.test(name) && !name.startsWith('.')),
  content_base64: z.string().max(16_777_216),
}).strict()).max(1024);

export class UploadStore {
  private readonly batches = new Map<string, string[]>();
  constructor(private readonly directory: string) {}

  async store(input: unknown) {
    const files = filesSchema.parse(input);
    let total = 0;
    const decoded = files.map(file => {
      const bytes = Buffer.from(file.content_base64, 'base64');
      if (bytes.toString('base64') !== file.content_base64) {
        throw Object.assign(new Error('file content_base64 is invalid'), { code: 'invalid_request' });
      }
      total += bytes.length;
      if (total > 12_582_912) throw Object.assign(new Error('decoded upload data exceeds 12 MiB'), { code: 'payload_too_large' });
      return { name: file.name, bytes };
    });
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const uploadId = randomUUID(), paths: string[] = [];
    this.batches.set(uploadId, paths);
    try {
      const value = [];
      for (const file of decoded) {
        const path = join(this.directory, `upload-${randomUUID()}`);
        paths.push(path);
        await writeFile(path, file.bytes, { flag: 'wx', mode: 0o600 });
        value.push({ name: file.name, size: file.bytes.length, path });
      }
      return { uploadId, value };
    } catch (error) { await this.remove(uploadId); throw error; }
  }

  async remove(uploadId: string): Promise<void> {
    const paths = this.batches.get(uploadId) ?? [];
    this.batches.delete(uploadId);
    await Promise.all(paths.map(path => unlink(path).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    })));
  }
}

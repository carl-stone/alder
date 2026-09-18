import { z } from "zod";
import { documentChangeSchema } from "../protocol.js";
import type { BrowserDraftStore, BrowserRecoveryBranch, BrowserRecoveryDraft } from "./transport.js";

export interface DesktopRecoveryRequest {
  keyId: string;
  action: "read" | "write" | "remove" | "list";
  name?: string;
  prefix?: string;
  value?: unknown;
}
export type DesktopRecoveryCall = (request: DesktopRecoveryRequest) => Promise<unknown>;

const revision = z.number().int().nonnegative().safe();
const identity = z.string().min(1);
const cursorSchema = z.object({ epoch: identity, cursor: revision });
const draftSchema = z.object({
  schemaVersion: z.literal(1), clientId: identity,
  base: z.object({ epoch: identity, cursor: revision, version: revision, documentRevision: revision,
    cells: z.array(z.object({ id: identity, revision, type: z.enum(["code", "markdown"]), body: z.array(z.string()) })) }),
  changes: z.array(documentChangeSchema),
  operation: z.object({ operationId: identity, clientId: identity.optional(), kind: z.enum(["transaction", "run"]),
    commandSequence: z.number().int().positive().safe(), expectedDocumentRevision: revision,
    changes: z.array(documentChangeSchema).optional() }).nullable(),
});
const recordsSchema = z.object({ records: z.array(z.object({ name: z.string(), value: z.unknown() })), warning: z.string().optional() });

/** A stable recovery key bridges renderer origins without giving the renderer file access. */
export class DesktopRecoveryStore implements BrowserDraftStore {
  private cursor: { epoch: string; cursor: number } | null = null;
  private cursorLoaded = false;
  private cursorRevision = 0;
  private cursorWriting = false;
  private warned = false;

  constructor(private readonly keyId: string, private readonly call: DesktopRecoveryCall, private readonly onWarning?: (message: string) => void) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(keyId)) throw new Error("Invalid desktop recovery identity");
  }

  private request(action: DesktopRecoveryRequest["action"], extra: Omit<DesktopRecoveryRequest, "keyId" | "action">): Promise<unknown> {
    return this.call({ keyId: this.keyId, action, ...extra });
  }
  async load(): Promise<{ epoch: string; cursor: number } | null> {
    if (!this.cursorLoaded) {
      this.cursorLoaded = true;
      const revision = this.cursorRevision;
      void Promise.resolve().then(() => this.request("read", { name: "cursor" })).then(value => {
        if (revision === this.cursorRevision && value !== null) this.cursor = cursorSchema.parse(value);
      }).catch(() => {});
    }
    // A cursor only optimizes reconnect; a fresh snapshot always works without it.
    return this.cursor === null ? null : { ...this.cursor };
  }
  async save(epoch: string, cursor: number): Promise<void> {
    this.cursor = cursorSchema.parse({ epoch, cursor });
    this.cursorLoaded = true;
    this.cursorRevision += 1;
    this.persistCursor();
  }
  async clear(): Promise<void> {
    this.cursor = null;
    this.cursorLoaded = true;
    this.cursorRevision += 1;
    this.persistCursor();
  }

  private persistCursor(): void {
    if (this.cursorWriting) return;
    this.cursorWriting = true;
    const revision = this.cursorRevision;
    const value = this.cursor;
    void Promise.resolve().then(() => value === null
      ? this.request("remove", { name: "cursor" })
      : this.request("write", { name: "cursor", value })).catch(() => {}).finally(() => {
        this.cursorWriting = false;
        if (revision !== this.cursorRevision) this.persistCursor();
      });
  }

  private warn(message: string): void {
    if (this.warned) return;
    this.warned = true;
    this.onWarning?.(message);
  }

  private async inventory(prefix: string): Promise<Array<{ name: string; value: unknown }>> {
    const result = recordsSchema.parse(await this.request("list", { prefix }));
    if (result.warning) this.warn(result.warning);
    return result.records;
  }

  async loadDraft(clientId?: string): Promise<BrowserRecoveryDraft | null> {
    if (clientId === undefined) return (await this.listDrafts())[0] ?? null;
    const value = await this.request("read", { name: "draft:" + clientId });
    if (value === null) return null;
    const draft = draftSchema.parse(value);
    if (draft.clientId !== clientId) throw new Error("Recovery draft belongs to a different client");
    return draft;
  }
  async listDrafts(): Promise<BrowserRecoveryDraft[]> {
    const drafts: BrowserRecoveryDraft[] = [];
    for (const record of await this.inventory("draft:")) {
      const parsed = draftSchema.safeParse(record.value);
      if (!parsed.success || record.name !== "draft:" + parsed.data.clientId) {
        this.warn("Some recovery drafts could not be read and were retained.");
        continue;
      }
      drafts.push(parsed.data);
    }
    return drafts;
  }
  async saveDraft(draft: BrowserRecoveryDraft): Promise<void> {
    await this.request("write", { name: "draft:" + draft.clientId, value: draftSchema.parse(draft) });
  }
  async clearDraft(clientId: string): Promise<void> { await this.request("remove", { name: "draft:" + clientId }); }
  async saveBranch(branchId: string, draft: BrowserRecoveryDraft): Promise<void> {
    await this.request("write", { name: "branch:" + branchId, value: draftSchema.parse(draft) });
  }
  async listBranches(): Promise<BrowserRecoveryBranch[]> {
    const branches: BrowserRecoveryBranch[] = [];
    for (const record of await this.inventory("branch:")) {
      const parsed = draftSchema.safeParse(record.value);
      if (!parsed.success || !record.name.startsWith("branch:") || record.name.length <= 7) {
        this.warn("Some recovery drafts could not be read and were retained.");
        continue;
      }
      branches.push({ id: record.name.slice(7), draft: parsed.data });
    }
    return branches;
  }
  async deleteBranch(branchId: string): Promise<void> { await this.request("remove", { name: "branch:" + branchId }); }
}

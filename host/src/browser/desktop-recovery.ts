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
const recordsSchema = z.array(z.object({ name: z.string(), value: z.unknown() }));

/** A stable recovery key bridges renderer origins without giving the renderer file access. */
export class DesktopRecoveryStore implements BrowserDraftStore {
  constructor(private readonly keyId: string, private readonly call: DesktopRecoveryCall) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(keyId)) throw new Error("Invalid desktop recovery identity");
  }

  private request(action: DesktopRecoveryRequest["action"], extra: Omit<DesktopRecoveryRequest, "keyId" | "action">): Promise<unknown> {
    return this.call({ keyId: this.keyId, action, ...extra });
  }
  async load(): Promise<{ epoch: string; cursor: number } | null> {
    const value = await this.request("read", { name: "cursor" });
    return value === null ? null : cursorSchema.parse(value);
  }
  async save(epoch: string, cursor: number): Promise<void> {
    await this.request("write", { name: "cursor", value: cursorSchema.parse({ epoch, cursor }) });
  }
  async clear(): Promise<void> { await this.request("remove", { name: "cursor" }); }

  async loadDraft(clientId?: string): Promise<BrowserRecoveryDraft | null> {
    if (clientId === undefined) return (await this.listDrafts())[0] ?? null;
    const value = await this.request("read", { name: "draft:" + clientId });
    if (value === null) return null;
    const draft = draftSchema.parse(value);
    if (draft.clientId !== clientId) throw new Error("Recovery draft belongs to a different client");
    return draft;
  }
  async listDrafts(): Promise<BrowserRecoveryDraft[]> {
    const records = recordsSchema.parse(await this.request("list", { prefix: "draft:" }));
    return records.map(record => {
      const draft = draftSchema.parse(record.value);
      if (record.name !== "draft:" + draft.clientId) throw new Error("Recovery draft identity does not match its record");
      return draft;
    });
  }
  async saveDraft(draft: BrowserRecoveryDraft): Promise<void> {
    await this.request("write", { name: "draft:" + draft.clientId, value: draftSchema.parse(draft) });
  }
  async clearDraft(clientId: string): Promise<void> { await this.request("remove", { name: "draft:" + clientId }); }
  async saveBranch(branchId: string, draft: BrowserRecoveryDraft): Promise<void> {
    await this.request("write", { name: "branch:" + branchId, value: draftSchema.parse(draft) });
  }
  async listBranches(): Promise<BrowserRecoveryBranch[]> {
    const records = recordsSchema.parse(await this.request("list", { prefix: "branch:" }));
    return records.map(record => {
      if (!record.name.startsWith("branch:") || record.name.length <= 7) throw new Error("Invalid recovery branch identity");
      return { id: record.name.slice(7), draft: draftSchema.parse(record.value) };
    });
  }
  async deleteBranch(branchId: string): Promise<void> { await this.request("remove", { name: "branch:" + branchId }); }
}

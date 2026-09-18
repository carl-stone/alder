import { z } from "zod";
import { readRecoveryDraft, type BrowserDraftStore, type BrowserRecoveryDraft } from "./transport.js";

export interface DesktopRecoveryRequest {
  recoveryId: string;
  action: "read" | "write" | "remove" | "list";
  name?: string;
  prefix?: string;
  value?: unknown;
}
export type DesktopRecoveryCall = (request: DesktopRecoveryRequest) => Promise<unknown>;
const recordsSchema = z.object({ records: z.array(z.object({ name: z.string(), value: z.unknown() })), warning: z.string().optional() });

/** The desktop stores drafts independently of browser origins and temporary credentials. */
export class DesktopRecoveryStore implements BrowserDraftStore {
  private legacyNames = new Map<string, string>();
  constructor(private readonly recoveryId: string, private readonly call: DesktopRecoveryCall, private readonly onWarning?: (message: string) => void) {}
  async listDrafts(): Promise<BrowserRecoveryDraft[]> {
    const result = recordsSchema.parse(await this.call({ recoveryId: this.recoveryId, action: "list", prefix: "" }));
    if (result.warning) this.onWarning?.(result.warning);
    const drafts = new Map<string, BrowserRecoveryDraft>();
    for (const record of result.records) {
      if (!record.name.startsWith("draft:") && !record.name.startsWith("branch:")) continue;
      const legacyId = record.name.startsWith("branch:") ? "saved-" + record.name.slice(7) : record.name.slice(6);
      const draft = readRecoveryDraft(record.value, legacyId);
      if (!draft) { this.onWarning?.("A saved draft could not be read and has been retained."); continue; }
      if (record.name !== "draft:" + draft.draftId) this.legacyNames.set(draft.draftId, record.name);
      drafts.set(draft.draftId, draft);
    }
    return [...drafts.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }
  async saveDraft(draft: BrowserRecoveryDraft): Promise<void> {
    await this.call({ recoveryId: this.recoveryId, action: "write", name: "draft:" + draft.draftId, value: draft });
  }
  async clearDraft(draftId: string): Promise<void> {
    await this.call({ recoveryId: this.recoveryId, action: "remove", name: "draft:" + draftId });
    const legacy = this.legacyNames.get(draftId);
    if (legacy) { await this.call({ recoveryId: this.recoveryId, action: "remove", name: legacy }); this.legacyNames.delete(draftId); }
  }
}

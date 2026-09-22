import { readRecoveryDraft, type BrowserDraftStore, type BrowserRecoveryDraft } from "./transport.js";

export interface DesktopRecoveryRequest {
  recoveryId: string;
  action: "read" | "write" | "remove" | "list" | "claim";
  name?: string;
  value?: unknown;
}
export type DesktopRecoveryCall = (request: DesktopRecoveryRequest) => Promise<unknown>;

/** The desktop stores drafts independently of browser origins and temporary credentials. */
export class DesktopRecoveryStore implements BrowserDraftStore {
  constructor(private readonly recoveryId: string, private readonly call: DesktopRecoveryCall, private readonly onWarning?: (message: string) => void) {}
  async readDraft(draftId: string): Promise<BrowserRecoveryDraft | null> {
    const value = await this.call({ recoveryId: this.recoveryId, action: "read", name: "draft:" + draftId });
    const draft = readRecoveryDraft(value);
    if (value !== null && (draft === null || draft.draftId !== draftId)) this.onWarning?.("The saved draft could not be read and has been retained.");
    return draft?.draftId === draftId ? draft : null;
  }
  async saveDraft(draft: BrowserRecoveryDraft): Promise<void> {
    await this.call({ recoveryId: this.recoveryId, action: "write", name: "draft:" + draft.draftId, value: draft });
  }
  async clearDraft(draftId: string): Promise<void> {
    await this.call({ recoveryId: this.recoveryId, action: "remove", name: "draft:" + draftId });
  }
  async listDrafts(): Promise<BrowserRecoveryDraft[]> {
    const result = await this.call({ recoveryId: this.recoveryId, action: "list" });
    if (typeof result !== "object" || result === null || !Array.isArray((result as { draftIds?: unknown }).draftIds)) throw new Error("Draft inventory is invalid");
    const inventory = result as { draftIds: unknown[]; damaged?: number };
    if (inventory.damaged) this.onWarning?.("Some saved drafts are damaged and have been retained.");
    const drafts: BrowserRecoveryDraft[] = [];
    for (const id of inventory.draftIds) {
      if (typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(id)) throw new Error("Draft inventory contains an invalid identity");
      const draft = await this.readDraft(id);
      if (draft) drafts.push(draft);
    }
    return drafts;
  }
  async claimDraft(draftId: string): Promise<void> {
    await this.call({ recoveryId: this.recoveryId, action: "claim", name: "draft:" + draftId });
  }
}

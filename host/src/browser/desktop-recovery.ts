import { readRecoveryDraft, type BrowserDraftStore, type BrowserRecoveryDraft } from "./transport.js";

export interface DesktopRecoveryRequest {
  recoveryId: string;
  action: "read" | "write" | "remove";
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
    if (value !== null && draft === null) this.onWarning?.("The saved draft could not be read and has been retained.");
    return draft;
  }
  async saveDraft(draft: BrowserRecoveryDraft): Promise<void> {
    await this.call({ recoveryId: this.recoveryId, action: "write", name: "draft:" + draft.draftId, value: draft });
  }
  async clearDraft(draftId: string): Promise<void> {
    await this.call({ recoveryId: this.recoveryId, action: "remove", name: "draft:" + draftId });
  }
}

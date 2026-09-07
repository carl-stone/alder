export interface EditorHandle {
  view?: {
    readonly hasFocus?: boolean;
    state?: { selection?: { main?: { anchor: number; head: number } }; doc?: { length: number } };
    scrollDOM?: HTMLElement;
    dispatch?(transaction: { selection?: { anchor: number; head: number }; scrollIntoView?: boolean }): void;
  };
  getDoc(): string;
  completionStatus(): "active" | "pending" | null;
  closeCompletion?(): void;
  setDoc(text: string, options?: boolean | { silent?: boolean }): void;
  focus(): void;
  destroy(): void;
  setDiagnostics?(diagnostics: readonly EditorDiagnostic[]): void;
  setReactiveRefs?(references: readonly EditorReference[]): void;
  setCompletionsEnabled?(enabled: boolean): void;
  setSignatureHelpEnabled?(enabled: boolean): void;
  setCompletionSource?(source: EditorCompletionSource | null): void;
}

export interface EditorCompletionContext {
  pos: number;
  explicit: boolean;
  matchBefore(expression: RegExp): { from: number; to: number; text: string } | null;
}

export interface EditorCompletion {
  label: string;
  type: string;
  detail: string;
  info: string;
  apply: string;
}

export type EditorCompletionSource = (context: EditorCompletionContext) => Promise<{
  from: number;
  options: EditorCompletion[];
} | null> | null;

export interface EditorFactoryOptions {
  parent?: HTMLElement;
  doc?: string;
  language?: "r" | "markdown";
  readOnly?: boolean;
  keymap?: string;
  completionsEnabled?: boolean;
  signatureHelpEnabled?: boolean;
  onChange?(text: string, update?: unknown): void;
  onRun?(next?: boolean): void;
  onRunAll?(): void;
  onSave?(): void;
  onFormat?(): void;
  onJump?(kind: "move" | "reference", value: number): void;
  onHover?(view: unknown, position: number): EditorHover | Promise<EditorHover>;
  onSignature?(view: unknown, position: number, trigger: string): EditorSignature | null | Promise<EditorSignature | null>;
}

export interface EditorDiagnostic {
  from: number;
  to: number;
  severity: "error" | "warning" | "info" | "hint";
  message: string;
}

export interface EditorReference {
  from: number;
  to?: number;
}

export type EditorHover = string | { text?: string; html?: string } | null;

export interface EditorSignature {
  label: string;
  activeParameter?: string;
  documentation?: string;
}

declare global {
  interface Window {
    AlderEditor?: { createEditor(options?: EditorFactoryOptions): EditorHandle };
  }
}

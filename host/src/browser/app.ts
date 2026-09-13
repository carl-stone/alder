import { BrowserNotebookClient } from "./client.js";
import { IndexedDBRecoveryStore } from "./transport.js";
import type { BrowserTransportOptions } from "./transport.js";
import { NotebookView } from "./view.js";
import type { HostEvent, PreloadApi, WindowAction } from "../protocol.js";
import { blocksNotebookNavigation, notebookUrl } from "./url.js";

let view: NotebookView | null = null;
let client: BrowserNotebookClient | null = null;

interface BrowserSessionCredentials {
  leaseId: string;
  clientId: string;
  nextCommandSequence: number;
  epoch: string;
  continuityProof: string;
  csrf: string;
  recoveryKey?: string;
  recoveryKeyId?: string;
}
const pendingRenders = new Map<string, HostEvent>();
const pendingStarts = new Map<string, number>();
let renderFrame: number | null = null;

function flushRenders(): void {
  if (renderFrame !== null) window.cancelAnimationFrame(renderFrame);
  renderFrame = null;
  const events = [...pendingRenders.values()].sort((left, right) => left.cursor - right.cursor);
  pendingRenders.clear();
  const document = client?.document;
  if (document) for (const event of events) {
    if (event.epoch === document.epoch) view?.render(document, event);
  }
}

function queueRender(event: HostEvent): void {
  const projection = ["cell-started", "cell-output", "cell-completed"].includes(event.type) ? "cell-result" : event.type;
  const key = event.type === "transaction" || event.type === "notebook"
    ? projection + ":" + event.cursor
    : projection + ":" + (event.cellId ?? "");
  pendingRenders.set(key, event);
  if (pendingRenders.size >= 64) return flushRenders();
  renderFrame ??= window.requestAnimationFrame(flushRenders);
}

let desktopUnsubscribe: (() => void) | null = null;
const unsafeLinkObserver = new MutationObserver((records) => {
  for (const record of records) {
    if (record.type === "attributes" && record.target instanceof Element) neutralizeUnsafeNotebookLinks(record.target);
    for (const node of Array.from(record.addedNodes)) if (node instanceof Element) neutralizeUnsafeNotebookLinks(node);
  }
});
unsafeLinkObserver.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["href"] });
neutralizeUnsafeNotebookLinks(document);

function bindDesktopActions(next: BrowserNotebookClient): void {
  const desktop = (globalThis as typeof globalThis & { alderDesktop?: PreloadApi }).alderDesktop;
  if (!desktop) return;
  desktopUnsubscribe = desktop.onWindowAction((action: WindowAction) => {
    let operation: Promise<unknown> | undefined;
    if (action === "save-as") {
      operation = desktop.chooseSavePath().then((path) => path === null ? undefined : next.saveAs(path));
    } else if (action === "run-all") {
      operation = view?.runExplicit(() => next.runAll("all"));
    } else if (action === "run-stale") {
      operation = view?.runExplicit(() => next.runAll("stale"));
    } else if (action === "select-r") {
      operation = desktop.chooseRscript().then((path) => path === null ? undefined : next.selectR(path, true));
    }
    void operation?.catch((error) => view?.showError(error));
  });
}

window.addEventListener("pagehide", () => {
  unsafeLinkObserver.disconnect();
  desktopUnsubscribe?.();
  desktopUnsubscribe = null;
});

function bindClient(next: BrowserNotebookClient): void {
  client = next;
  next.subscribe((document, event, localCellKeys) => {
    if (!event) {
      flushRenders();
      view?.render(document, event, localCellKeys);
      return;
    }
    if (event.cellId) {
      const cellId = event.cellId;
      window.clearTimeout(pendingStarts.get(cellId));
      pendingStarts.delete(cellId);
      if (event.type === "cell-started") {
        pendingStarts.set(cellId, window.setTimeout(() => {
          pendingStarts.delete(cellId);
          const current = client?.document;
          if (current?.epoch === event.epoch && current.snapshot.runtime.activeRunId === event.runId && current.cell(cellId)?.server?.status === "running") queueRender(event);
        }, 100));
        return;
      }
    }
    queueRender(event);
  });
}

function neutralizeUnsafeNotebookLinks(root: ParentNode): void {
  const links = root instanceof HTMLAnchorElement ? [root] : Array.from(root.querySelectorAll<HTMLAnchorElement>("a[href]"));
  for (const link of links) {
    const destination = link.getAttribute("href");
    if (!destination || !blocksNotebookNavigation(destination)) continue;
    link.removeAttribute("href");
    link.setAttribute("aria-disabled", "true");
    link.title = "Blocked because another port on this host could receive notebook session credentials";
  }
}
window.addEventListener("beforeunload", (event) => {
  void client?.flushDraftPersistence();
  if (view?.allowsUnload) return;
  const document = client?.document;
  const pending = document?.pendingSource();
  if (!document?.snapshot.changed && !pending?.changes.length) return;
  event.preventDefault();
});

async function bootstrapSession(): Promise<BrowserSessionCredentials> {
  const current = new URL(location.href);
  const ticket = current.hash.startsWith("#ticket=") ? decodeURIComponent(current.hash.slice("#ticket=".length)) : "";
  if (!ticket) throw new Error("browser session ticket is missing");
  history.replaceState(null, "", `${current.pathname}${current.search}`);
  const response = await fetch(notebookUrl("/api/session"), {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ticket }),
  });
  const value: unknown = await response.json().catch(() => null);
  if (!response.ok || !isSessionCredentials(value)) throw new Error("browser session ticket exchange was rejected");
  return value;
}

async function start(): Promise<void> {
  const session = await bootstrapSession();
  const options: BrowserTransportOptions = {
    recoveryStore: new IndexedDBRecoveryStore(recoveryIdentity(), session.recoveryKey, session.recoveryKeyId),
    clientId: session.clientId,
    leaseId: session.leaseId,
    csrf: session.csrf,
    continuityProof: session.continuityProof,
    nextCommandSequence: session.nextCommandSequence,
    reconnect: true,
    onState: (state, error) => view?.setTransportState(state, error),
  };
  const next = new BrowserNotebookClient({
    ...options,
    onCommand: (command, result) => window.dispatchEvent(new CustomEvent("alder:host-command", { detail: { command, result } })),
    onVisibleResult: (observation) => window.dispatchEvent(new CustomEvent("alder:visible-result", { detail: observation })),
  });
  bindClient(next);
  view = new NotebookView(next);
  bindDesktopActions(next);
  window.__alderHost = { client: next, view };
  await next.connect();
}

void start().catch((error) => view?.showError(error));


function recoveryIdentity(): string {
  const current = new URL(location.href);
  current.hash = "";
  current.searchParams.delete("view");
  return current.origin + current.pathname + current.search;
}
function isSessionCredentials(value: unknown): value is BrowserSessionCredentials {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const recoveryKey = record.recoveryKey;
  const recoveryKeyId = record.recoveryKeyId;
  const recoveryPairValid = recoveryKey === undefined && recoveryKeyId === undefined ||
    typeof recoveryKey === "string" && /^[A-Za-z0-9_-]{43}$/.test(recoveryKey) &&
    typeof recoveryKeyId === "string" && /^[A-Za-z0-9_-]{43}$/.test(recoveryKeyId);
  return recoveryPairValid && typeof record.leaseId === "string" && typeof record.clientId === "string" && Number.isSafeInteger(record.nextCommandSequence) && (record.nextCommandSequence as number) > 0 && typeof record.epoch === "string" && typeof record.continuityProof === "string" && record.continuityProof.length > 0 && typeof record.csrf === "string";
}

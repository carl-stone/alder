import { z } from "zod";
import { BrowserNotebookClient } from "./client.js";
import { DesktopRecoveryStore } from "./desktop-recovery.js";
import { IndexedDBRecoveryStore } from "./transport.js";
import type { BrowserTransportOptions } from "./transport.js";
import { NotebookView } from "./view.js";
import type { HostEvent, PreloadApi, WindowAction } from "../protocol.js";
import { blocksNotebookNavigation, notebookUrl } from "./url.js";

let view: NotebookView | null = null;
let client: BrowserNotebookClient | null = null;

const browserSessionSchema = z.object({
  leaseId: z.string(), clientId: z.string(), epoch: z.string(),
  continuityProof: z.string().min(1), csrf: z.string(), recoveryId: z.string().optional(),
});
type BrowserSessionCredentials = z.infer<typeof browserSessionSchema>;
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
  const openNotebook = document.getElementById("open-notebook");
  if (openNotebook instanceof HTMLButtonElement) {
    openNotebook.hidden = false;
    openNotebook.addEventListener("click", () => {
      void desktop.openNotebook().catch((error) => view?.showError(error));
    });
  }
  desktopUnsubscribe = desktop.onWindowAction((action: WindowAction) => {
    let operation: Promise<unknown> | undefined;
    if (action === "prepare-unload") {
      operation = next.flushDraftPersistence().then(() => desktop.rendererDraftFlushed());
    } else if (action === "save") {
      operation = view?.saveForDesktop().then(async (outcome) => {
        if (outcome === "cancelled") await desktop.saveCancelled();
      });
    } else if (action === "close") {
      operation = (async () => {
        await next.discardAndClose();
        await desktop.hostShutdown();
      })();
    } else if (action === "save-as") {
      operation = desktop.chooseSavePath().then((path) => path === null ? undefined : next.saveAs(path));
    } else if (action === "run-all") {
      operation = view?.runExplicit(() => next.startRunAll("all"));
    } else if (action === "run-stale") {
      operation = view?.runExplicit(() => next.startRunAll("stale"));
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
  if (!response.ok || !browserSessionSchema.safeParse(value).success) throw new Error("browser session ticket exchange was rejected");
  return browserSessionSchema.parse(value);
}

async function start(): Promise<void> {
  const session = await bootstrapSession();
  const desktop = (globalThis as typeof globalThis & { alderDesktop?: PreloadApi }).alderDesktop;
  const options: BrowserTransportOptions = {
    recoveryStore: desktop && session.recoveryId
      ? new DesktopRecoveryStore(session.recoveryId, request => desktop.recovery(request), message => view?.showError(new Error(message)))
      : new IndexedDBRecoveryStore(session.recoveryId ?? recoveryIdentity()),
    clientId: session.clientId,
    leaseId: session.leaseId,
    csrf: session.csrf,
    continuityProof: session.continuityProof,
    reconnect: true,
    onState: (state, error) => view?.setTransportState(state, error),
  };
  const next = new BrowserNotebookClient({
    ...options,
    draftId: desktop ? await desktop.getDraftId() : browserDraftId(),
    onCommand: (command, result) => window.dispatchEvent(new CustomEvent("alder:host-command", { detail: { command, result } })),
    onVisibleResult: (observation) => window.dispatchEvent(new CustomEvent("alder:visible-result", { detail: observation })),
  });
  bindClient(next);
  view = new NotebookView(next);
  bindDesktopActions(next);
  window.__alderHost = { client: next, view };
  await next.connect();
  await (globalThis as typeof globalThis & { alderDesktop?: PreloadApi }).alderDesktop?.rendererReady();
}

void start().catch((error) => view?.showError(error));


function recoveryIdentity(): string {
  const current = new URL(location.href);
  current.hash = "";
  current.searchParams.delete("view");
  return current.origin + current.pathname + current.search;
}
function browserDraftId(): string {
  const key = "alder-draft:" + recoveryIdentity();
  let id = sessionStorage.getItem(key);
  if (!id) { id = crypto.randomUUID(); sessionStorage.setItem(key, id); }
  return id;
}

import { BrowserNotebookClient } from "./client.js";
import { NotebookView } from "./view.js";
import type { HostEvent } from "../protocol.js";

let view: NotebookView | null = null;
const client = new BrowserNotebookClient({
  reconnect: true,
  onState: (state, error) => view?.setTransportState(state, error),
  onCommand: (command, result) => {
    window.dispatchEvent(new CustomEvent("alder:host-command", {
      detail: { command, result },
    }));
  },
  onVisibleResult: (observation) => {
    window.dispatchEvent(new CustomEvent("alder:visible-result", { detail: observation }));
  },
});

view = new NotebookView(client);
window.__alderHost = { client, view };
const pendingRenders = new Map<string, HostEvent>();
const pendingStarts = new Map<string, number>();
let renderFrame: number | null = null;
function flushRenders(): void {
  if (renderFrame !== null) window.cancelAnimationFrame(renderFrame);
  renderFrame = null;
  const events = [...pendingRenders.values()].sort((left, right) => left.cursor - right.cursor);
  pendingRenders.clear();
  const document = client.document;
  if (document) for (const event of events) {
    if (event.epoch === document.epoch) view?.render(document, event);
  }
}
function queueRender(event: HostEvent): void {
  const projection = ["cell-started", "cell-output", "cell-completed"].includes(event.type)
    ? "cell-result" : event.type;
  pendingRenders.set(`${projection}:${event.cellId ?? ""}`, event);
  // Background tabs may suspend animation frames while peer edits continue.
  if (pendingRenders.size >= 64) return flushRenders();
  renderFrame ??= window.requestAnimationFrame(flushRenders);
}
client.subscribe((document, event, localCellKeys) => {
  // The document applies every ordered event immediately, including every log
  // delta. Render its latest projections once per frame; local input stays
  // synchronous so creating or editing a focused cell never waits for paint.
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
      // Avoid a running-state flash for quick evaluations. Output and terminal
      // projections replace this timer; runtime controls remain immediate.
      pendingStarts.set(cellId, window.setTimeout(() => {
        pendingStarts.delete(cellId);
        const current = client.document;
        if (current?.epoch === event.epoch && current.snapshot.runtime.activeRunId === event.runId
          && current.cell(cellId)?.server?.status === "running") queueRender(event);
      }, 100));
      return;
    }
  }
  queueRender(event);
});

window.addEventListener("beforeunload", (event) => {
  if (view?.allowsUnload) return;
  const document = client.document;
  const pending = document?.pendingSource();
  if (!document?.snapshot.changed && !pending?.edits.length && !pending?.creations.length) return;
  event.preventDefault();
});

void client.connect().catch((error) => view?.showError(error));

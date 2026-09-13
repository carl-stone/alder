/** Build a URL for the current notebook host; notebook selection is session-scoped. */
export function notebookUrl(path: string, href = location.href): string {
  const current = new URL(href);
  const target = new URL(path, current.origin);
  return target.pathname + target.search + target.hash;
}

export function notebookSocketUrl(href = location.href): string {
  const current = new URL(href);
  const target = new URL(notebookUrl("/api/socket", href), current.origin);
  target.protocol = current.protocol === "https:" ? "wss:" : "ws:";
  return target.href;
}

export function notebookViewUrl(view: "app" | "editor", href = location.href): string {
  const current = new URL(href);
  current.hash = "";
  current.searchParams.set("view", view);
  return current.pathname + current.search;
}

/** Same-host cross-origin navigation would disclose host-scoped session cookies across ports. */
export function blocksNotebookNavigation(destination: string, href = location.href): boolean {
  try {
    const current = new URL(href);
    const target = new URL(destination, current.href);
    return target.hostname === current.hostname && target.origin !== current.origin;
  } catch {
    return true;
  }
}

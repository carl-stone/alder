/** Keep the gallery notebook identity on every notebook-scoped request. */
export function notebookUrl(path: string, href = location.href): string {
  const current = new URL(href);
  const target = new URL(path, current.origin);
  const notebook = notebookIdentity(current);
  if (notebook !== null) target.searchParams.set("nb", notebook);
  return `${target.pathname}${target.search}${target.hash}`;
}

export function notebookSocketUrl(href = location.href): string {
  const current = new URL(href);
  const target = new URL(notebookUrl("/api/socket", href), current.origin);
  target.protocol = current.protocol === "https:" ? "wss:" : "ws:";
  return target.href;
}

export function notebookViewUrl(view: "app" | "editor", href = location.href): string {
  const current = new URL(href);
  const notebook = notebookIdentity(current);
  current.hash = "";
  if (notebook !== null) current.searchParams.set("nb", notebook);
  current.searchParams.set("view", view);
  return `${current.pathname}${current.search}`;
}

function notebookIdentity(url: URL): string | null {
  const explicit = url.searchParams.get("nb");
  if (explicit !== null) return explicit;
  const match = /^\/n\/([^/]+)$/.exec(url.pathname);
  if (!match) return null;
  try { return decodeURIComponent(match[1]!); } catch { return null; }
}

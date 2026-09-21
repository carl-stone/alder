/** The private HTML launcher is shared; only the system opener differs. */
export function systemBrowserCommand(platform: NodeJS.Platform): string {
  if (platform === "darwin") return "open";
  if (platform === "linux") return "xdg-open";
  throw new Error(`system browser launch is unavailable on ${platform}`);
}

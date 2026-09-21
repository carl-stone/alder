import { delimiter, join } from "node:path";

/** Host facilities required to discover and launch the selected R installation. */
export interface RPlatform {
  readonly name: "darwin" | "linux";
  readonly desktopRscriptFallback: string | null;
  readonly sharedLibrary: string;
  readonly loaderPathVariable: "DYLD_LIBRARY_PATH" | "LD_LIBRARY_PATH";
  readonly analyzerNeedsRHome: boolean;
  matchesRPlatform(value: string): boolean;
}

const mac: RPlatform = {
  name: "darwin",
  desktopRscriptFallback: "/Library/Frameworks/R.framework/Resources/bin/Rscript",
  sharedLibrary: "libR.dylib",
  loaderPathVariable: "DYLD_LIBRARY_PATH",
  analyzerNeedsRHome: false,
  matchesRPlatform: value => value.toLowerCase().includes("darwin"),
};

const linux: RPlatform = {
  name: "linux",
  desktopRscriptFallback: null,
  sharedLibrary: "libR.so",
  loaderPathVariable: "LD_LIBRARY_PATH",
  analyzerNeedsRHome: true,
  matchesRPlatform: value => value.toLowerCase().includes("linux"),
};

export function rPlatform(platform: NodeJS.Platform = process.platform): RPlatform {
  if (platform === "darwin") return mac;
  if (platform === "linux") return linux;
  throw new Error(`unsupported R host platform ${platform}`);
}

export function rLoaderEnvironment(rHome: string, platform: RPlatform = rPlatform()): Record<string, string> {
  const key = platform.loaderPathVariable;
  const directories = [join(rHome, "lib"), join(rHome, "lib", "R")];
  const existing = process.env[key];
  return { [key]: [...directories, ...(existing ? existing.split(delimiter) : [])].join(delimiter) };
}

import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

export interface ManifestResourcePaths {
  cliLauncher: string;
  hostEntry: string;
  rendererDirectory: string;
  workerDirectory: string;
  rLibraryDirectory: string;
  arkExecutable: string;
  airExecutable: string;
  nodeExecutable: string;
  electronEntry: string | null;
}

export interface ApplicationManifest {
  schemaVersion: 1;
  kind: "desktop" | "headless";
  applicationVersion: string;
  resources: ManifestResourcePaths;
}

export interface ApplicationResources extends ManifestResourcePaths {
  readonly manifest?: ApplicationManifest;
  root: string;
  /** Transitional callers may still pass this value; no supervisor is used. */
  processSupervisorExecutable: string;
}

export class ResourceValidationError extends Error {
  readonly code = "resource_invalid" as const;
  constructor(message: string) { super(message); this.name = "ResourceValidationError"; }
}

export async function resolveApplicationResources(root: string): Promise<ApplicationResources> {
  const physicalRoot = await realpath(root);
  const manifest = await readApplicationManifest(physicalRoot);
  const paths = Object.fromEntries(Object.entries(manifest.resources).map(([key, path]) => [key, path === null ? null : resolve(physicalRoot, path)])) as unknown as ManifestResourcePaths;
  // Editing has no dependency on R, Ark, Air or an installed helper library.
  for (const [key, directory] of [["hostEntry", false], ["rendererDirectory", true], ["workerDirectory", true]] as const) {
    const path = paths[key];
    const info = await stat(path).catch(() => { throw invalid(`${key} is unavailable: ${path}`); });
    if (directory ? !info.isDirectory() : !info.isFile()) throw invalid(`${key} has the wrong file type: ${path}`);
  }
  return { ...paths, root: physicalRoot, manifest, processSupervisorExecutable: "" };
}

export async function verifiedApplicationManifest(resources: ApplicationResources): Promise<ApplicationManifest> {
  return resources.manifest ?? readApplicationManifest(resources.root);
}

export async function readApplicationManifest(root: string): Promise<ApplicationManifest> {
  try { return validateApplicationManifest(JSON.parse(await readFile(join(root, "manifest.json"), "utf8"))); }
  catch (error) {
    if (error instanceof ResourceValidationError) throw error;
    throw invalid(`application manifest is unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function validateApplicationManifest(value: unknown): ApplicationManifest {
  if (!record(value) || value.schemaVersion !== 1 || !["desktop", "headless"].includes(String(value.kind)) ||
      typeof value.applicationVersion !== "string" || !value.applicationVersion || !record(value.resources)) {
    throw invalid("invalid application manifest");
  }
  const resources = value.resources;
  const paths = {} as ManifestResourcePaths;
  for (const key of ["cliLauncher", "hostEntry", "rendererDirectory", "workerDirectory", "rLibraryDirectory", "arkExecutable", "airExecutable", "nodeExecutable", "electronEntry"] as const) {
    const path = resources[key];
    if (key === "electronEntry" && path === null) { paths[key] = null; continue; }
    if (typeof path !== "string" || !path || path.includes("\0") || isAbsolute(path) || path.includes("\\") ||
        path.split("/").some(part => !part || part === "." || part === "..")) {
      throw invalid(`invalid resource path: ${key}`);
    }
    paths[key] = path;
  }
  return { schemaVersion: 1, kind: value.kind as ApplicationManifest["kind"], applicationVersion: value.applicationVersion, resources: paths };
}

function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function invalid(message: string): ResourceValidationError { return new ResourceValidationError(message); }

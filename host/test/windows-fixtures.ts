import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { join, resolve } from "node:path";

const execFileAsync = promisify(execFile);

export const windowsNodeExecutable = resolve(
  fileURLToPath(new URL("../.application/resources/runtime/node.exe", import.meta.url)),
);
export const windowsProcessSupervisorExecutable = resolve(
  fileURLToPath(new URL("../.application/resources/runtime/alder-process-supervisor.exe", import.meta.url)),
);

export function testNodeExecutable(): string {
  return process.platform === "win32" ? windowsNodeExecutable : process.execPath;
}

export async function secureWindowsPath(kind: "directory" | "file", path: string): Promise<void> {
  if (process.platform !== "win32") return;
  await execFileAsync(
    windowsProcessSupervisorExecutable,
    ["--private-path", "secure", kind, path],
    { windowsHide: true },
  );
}

export async function overshareWindowsPath(path: string): Promise<void> {
  if (process.platform !== "win32") return;
  await execFileAsync(
    "icacls",
    [path, "/grant", "*S-1-1-0:(R)"],
    { windowsHide: true },
  );
}

function cWideLiteral(value: string): string {
  return `L"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

async function windowsGcc(): Promise<string> {
  const roots = ["RTOOLS45_HOME", "RTOOLS44_HOME", "RTOOLS43_HOME", "RTOOLS42_HOME"]
    .map((name) => process.env[name])
    .filter((root): root is string => root !== undefined && root.length > 0);
  const candidates = roots.flatMap((root) => [
    join(root, "x86_64-w64-mingw32.static.posix", "bin", "gcc.exe"),
    join(root, "ucrt64", "bin", "gcc.exe"),
    join(root, "mingw64", "bin", "gcc.exe"),
    join(root, "usr", "bin", "gcc.exe"),
  ]);
  candidates.push("gcc.exe");
  for (const candidate of candidates) {
    try {
      await execFileAsync(candidate, ["--version"], { windowsHide: true, timeout: 10_000, maxBuffer: 16 * 1024 });
      return candidate;
    } catch {
      // Try the next deterministic Rtools location or PATH entry.
    }
  }
  throw new Error("Windows fixture launcher requires gcc.exe from Rtools; no supported compiler was found");
}

export async function createWindowsNodeLauncher(outputPath: string, scriptPath: string): Promise<string> {
  if (process.platform !== "win32") throw new Error("Windows launcher requested on a non-Windows host");
  const sourcePath = outputPath + ".c";
  const node = cWideLiteral(windowsNodeExecutable);
  const script = cWideLiteral(scriptPath);
  const source = [
    "#include <process.h>",
    "#include <stdlib.h>",
    "#include <wchar.h>",
    "",
    "int wmain(int argc, wchar_t **argv) {",
    "  wchar_t **child = calloc((size_t)argc + 2, sizeof(*child));",
    "  if (child == NULL) return 125;",
    `  child[0] = ${node};`,
    `  child[1] = ${script};`,
    "  for (int index = 1; index < argc; index += 1) child[index + 1] = argv[index];",
    "  child[argc + 1] = NULL;",
    `  int status = _wspawnv(_P_WAIT, ${node}, (const wchar_t * const *)child);`,
    "  free(child);",
    "  return status < 0 ? 126 : status;",
    "}",
    "",
  ].join("\n");
  await writeFile(sourcePath, source, "utf8");
  const gcc = await windowsGcc();
  await execFileAsync(gcc,
    ["-O2", "-s", "-municode", "-static", "-static-libgcc", sourcePath, "-o", outputPath],
    { windowsHide: true, timeout: 30_000, maxBuffer: 128 * 1024 },
  );
  return outputPath;
}

import { lstat, mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

const OUTPUT_ARGUMENT = "--output-dir";

export function parseNativeReviewOutputParent(argv: readonly string[]): string {
  const positions = argv.flatMap((value, index) => value === OUTPUT_ARGUMENT ? [index] : []);
  if (positions.length !== 1) throw new Error(`Expected exactly one ${OUTPUT_ARGUMENT} argument`);
  const value = argv[positions[0]! + 1];
  if (!value || value.startsWith("--")) throw new Error(`${OUTPUT_ARGUMENT} requires a path`);
  if (!isAbsolute(value)) throw new Error("Native review output parent must be absolute");
  return resolve(value);
}

export async function createNativeReviewOutputDirectory(
  argv: readonly string[],
  options: { temporaryRoot?: string } = {},
): Promise<string> {
  const requested = parseNativeReviewOutputParent(argv);
  const requestedStat = await lstat(requested).catch(() => null);
  if (!requestedStat?.isDirectory() || requestedStat.isSymbolicLink()) {
    throw new Error("Native review output parent must be an existing non-symlink directory");
  }
  const temporaryRoot = await realpath(options.temporaryRoot ?? tmpdir());
  const canonicalRequested = await realpath(requested);
  if (canonicalRequested !== temporaryRoot) {
    throw new Error("Native review output parent must be the system temporary directory");
  }
  const outputDirectory = await mkdtemp(join(temporaryRoot, "alder-native-review-"));
  const canonicalOutput = await realpath(outputDirectory);
  if (!canonicalOutput.startsWith(temporaryRoot + "/")) {
    throw new Error("Native review output escaped the system temporary directory");
  }
  return canonicalOutput;
}

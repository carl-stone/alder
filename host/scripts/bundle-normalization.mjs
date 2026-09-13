import { readFile, writeFile } from 'node:fs/promises';

/** Preserve generated dependency string bytes while eliminating source-level
 * trailing whitespace that would make the committed bundle nondeterministic. */
export async function normalizeHostBundleWhitespace(path) {
  let source = await readFile(path, 'utf8');
  for (const [original, replacement] of [
    ['Received response message without id: Error is: \n${', 'Received response message without id: Error is: \\x20\n${'],
    ['\ndata: \n', '\ndata:\\x20\n'],
    ['\n        \n        if (${id2}.value', '\n\n        if (${id2}.value'],
    ['    setStart(node, offset) {\n      this[START] = node.childNodes[offset];\n    }\n  \n    setEnd', '    setStart(node, offset) {\n      this[START] = node.childNodes[offset];\n    }\n\n    setEnd'],
  ]) source = source.replaceAll(original, replacement);
  if (/[ \t]+$/mu.test(source)) {
    throw new Error('Generated host bundle contains an unclassified trailing-whitespace context');
  }
  await writeFile(path, source);
}

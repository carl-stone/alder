export function parseJson(input: string | Uint8Array, maxBytes?: number): unknown {
  const bytes = typeof input === "string" ? Buffer.from(input, "utf8") : Buffer.from(input);
  if (maxBytes !== undefined && bytes.byteLength > maxBytes) throw new SyntaxError(`JSON exceeds ${maxBytes} bytes`);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new SyntaxError("JSON is not valid UTF-8");
  }
  return JSON.parse(text);
}

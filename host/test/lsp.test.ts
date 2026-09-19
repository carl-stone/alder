import assert from "node:assert/strict";
import test from "node:test";
import { Duplex, PassThrough, type TransformCallback } from "node:stream";
import { createMessageConnection, StreamMessageReader, StreamMessageWriter } from "vscode-jsonrpc/node";
import { InitializeRequest, ShutdownRequest } from "vscode-languageserver-protocol";
import { LspClient } from "../src/lsp.js";
import { parseNotebook } from "../src/notebook.js";

class ControlledWriter extends PassThrough {
  private holdNext = false;
  private writeStarted: (() => void) | null = null;
  private heldCallback: TransformCallback | null = null;

  holdNextWrite(): Promise<void> {
    this.holdNext = true;
    return new Promise<void>(resolve => { this.writeStarted = resolve; });
  }

  override _transform(chunk: Buffer, encoding: BufferEncoding, callback: TransformCallback): void {
    if (!this.holdNext) {
      super._transform(chunk, encoding, callback);
      return;
    }
    this.holdNext = false;
    this.writeStarted?.();
    this.writeStarted = null;
    // Deliberately never call callback. LspClient.stop() must destroy the
    // transport after its grace period and settle this write itself.
    this.heldCallback = callback;
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    const heldCallback = this.heldCallback;
    this.heldCallback = null;
    heldCallback?.(Object.assign(new Error("controlled writer destroyed"), { code: "EPIPE" }));
    super._destroy(error, callback);
  }
}

test("LSP teardown bounds a permanently stuck writer and settles every send", { timeout: 5_000 }, async () => {
  const clientToServer = new ControlledWriter();
  const serverToClient = new PassThrough();
  const clientSocket = Duplex.from({ readable: serverToClient, writable: clientToServer });
  const serverSocket = Duplex.from({ readable: clientToServer, writable: serverToClient });
  const server = createMessageConnection(new StreamMessageReader(serverSocket), new StreamMessageWriter(serverSocket));
  server.onRequest(InitializeRequest.type, () => ({ capabilities: {} }));
  server.onRequest(ShutdownRequest.type, () => null);
  server.listen();
  const document = parseNotebook(Buffer.from("# %%\nx <- 1\n", "utf8"));
  const client = new LspClient({ document, connect: async () => clientSocket });
  try {
    await client.start();
    const started = clientToServer.holdNextWrite();
    const saving = client.didSave();
    await started;
    const beganStopping = performance.now();
    const stopping = client.stop();
    let guard: NodeJS.Timeout | undefined;
    const settled = Promise.allSettled([saving, stopping]);
    const guarded = new Promise<never>((_, reject) => {
      guard = setTimeout(() => reject(new Error("LSP stop did not settle stuck writer")), 4_000);
    });
    const [saveResult, stopResult] = await Promise.race([settled, guarded]).finally(() => {
      if (guard) clearTimeout(guard);
    });
    assert.equal(stopResult.status, "fulfilled");
    assert.ok(saveResult.status === "fulfilled" || saveResult.status === "rejected");
    assert.ok(performance.now() - beganStopping < 3_000, "stop exceeded its two-second shutdown bound");
    assert.equal(clientSocket.destroyed, true);
    await client.stop();
    await new Promise(resolve => setImmediate(resolve));
  } finally {
    await client.stop();
    server.dispose();
    server.end();
    clientSocket.destroy();
    serverSocket.destroy();
  }
});

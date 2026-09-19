import assert from "node:assert/strict";
import test from "node:test";
import { Duplex, PassThrough, type TransformCallback } from "node:stream";
import { createMessageConnection, StreamMessageReader, StreamMessageWriter } from "vscode-jsonrpc/node";
import { InitializeRequest, ShutdownRequest } from "vscode-languageserver-protocol";
import { LspClient } from "../src/lsp.js";
import { parseNotebook } from "../src/notebook.js";

class ControlledWriter extends PassThrough {
  private rejectNext = false;
  private releaseFailure: (() => void) | null = null;
  private failureStarted: (() => void) | null = null;

  failNextWrite(): { started: Promise<void>; release(): void } {
    this.rejectNext = true;
    const started = new Promise<void>(resolve => { this.failureStarted = resolve; });
    const released = new Promise<void>(resolve => { this.releaseFailure = resolve; });
    return { started, release: () => this.releaseFailure?.() };
  }

  override _transform(chunk: Buffer, encoding: BufferEncoding, callback: TransformCallback): void {
    if (!this.rejectNext) {
      super._transform(chunk, encoding, callback);
      return;
    }
    this.rejectNext = false;
    this.failureStarted?.();
    this.failureStarted = null;
    const error = Object.assign(new Error("controlled writer EPIPE"), { code: "EPIPE" });
    const release = this.releaseFailure;
    this.releaseFailure = null;
    if (release === null) callback(error);
    else {
      const original = release;
      this.releaseFailure = () => { original(); callback(error); };
    }
  }
}

test("LSP teardown settles an in-flight writer rejection before it returns", async () => {
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
    const failure = clientToServer.failNextWrite();
    const saving = client.didSave();
    await failure.started;
    const stopping = client.stop();
    failure.release();
    await assert.rejects(saving, /controlled writer EPIPE|stream was destroyed/);
    await stopping;
    await new Promise(resolve => setImmediate(resolve));
  } finally {
    await client.stop();
    server.dispose();
    server.end();
    clientSocket.destroy();
    serverSocket.destroy();
  }
});

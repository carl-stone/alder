import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { browserUrl, desktopUnavailableError, openSystemBrowser, parseCli, waitForRuntimeReadiness } from "../src/main.js";
import type { HostSnapshot, SessionConnection } from "../src/protocol.js";

test("internal deferred startup does not disable configured startup", () => {
  const options = parseCli(["--internal-host", "--defer-startup"]);
  assert.equal(options.deferStartup, true);
  assert.equal(options.noRun, false);
});
test("internal host accepts forwarded remote session options", () => {
  const options = parseCli([
    "--internal-host", "notebook.R", "--defer-startup",
    "--external-origin", "https://proxy.example", "--token-file", "token",
  ]);
  assert.equal(options.internalHost, true);
  assert.equal(options.externalOrigin, "https://proxy.example");
  assert.equal(options.tokenFile, "token");
});


test("explicit no-run remains distinct from deferred startup", () => {
  const options = parseCli(["--no-run"]);
  assert.equal(options.noRun, true);
  assert.equal(options.deferStartup, false);
});

test("deferred startup transport is internal-only", () => {
  assert.throws(() => parseCli(["--defer-startup"]), /reserved for internal hosts/);
});
test("CLI waits for cold runtime startup before the first operation", async () => {
  const snapshots = [
    { runtime: { executionReady: false, executionBlockedReason: null } },
    { runtime: { executionReady: true, executionBlockedReason: null } },
  ] as unknown as HostSnapshot[];
  let reads = 0;
  const ready = await waitForRuntimeReadiness(async () => snapshots[Math.min(reads++, snapshots.length - 1)]!, { timeoutMs: 100, pollIntervalMs: 0 });
  assert.equal(reads, 2);
  assert.equal(ready.runtime.executionReady, true);
});

test("CLI readiness wait returns a terminal runtime block", async () => {
  const blocked = { code: "engine_start_failed", message: "R runtime unavailable" };
  const snapshot = { runtime: { executionReady: false, executionBlockedReason: blocked } } as unknown as HostSnapshot;
  const result = await waitForRuntimeReadiness(async () => snapshot, { timeoutMs: 100, pollIntervalMs: 0 });
  assert.deepEqual(result.runtime.executionBlockedReason, blocked);
});

test("browser bootstrap URL uses the browser origin", async () => {
  const browserOrigin = "http://0123456789abcdef0123456789abcdef.localhost:4312";
  const requested: { path?: string; init?: RequestInit } = {};
  const ticket = "c".repeat(64);
  const connection = {
    browserOrigin,
    request: async (path: string, init?: RequestInit) => {
      requested.path = path;
      requested.init = init;
      return new Response(JSON.stringify({ ticket }), { status: 200 });
    },
  } as unknown as SessionConnection;
  assert.equal(await browserUrl(connection), `${browserOrigin}/index.html#ticket=${ticket}`);
  assert.equal(requested.path, "/api/ticket");
  assert.deepEqual(JSON.parse(String(requested.init?.body)), { origin: browserOrigin });
  assert.equal(new Headers(requested.init?.headers).get("Origin"), null);
});

class FakeBrowserOpener extends EventEmitter {
  unrefCalled = false;
  unref(): void { this.unrefCalled = true; }
}

async function waitForMissing(path: string): Promise<void> {
  const deadline = Date.now() + 1_000;
  for (;;) {
    try {
      await stat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (Date.now() >= deadline) throw new Error("browser launcher cleanup timed out");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test("external browser launch keeps its bearer out of opener arguments", async () => {
  const root = await mkdtemp(join(tmpdir(), "alder-browser-opener-test-"));
  const ticket = "d".repeat(64);
  const target = `https://browser.example/index.html#ticket=${ticket}&next=</script><img src=x onerror=1>\u2028`;
  const child = new FakeBrowserOpener();
  let command: string | undefined;
  let args: readonly string[] | undefined;
  let spawnOptions: unknown;
  let launcherPath: string | undefined;
  try {
    await openSystemBrowser(target, {
      platform: "linux",
      temporaryRoot: root,
      cleanupDelayMs: 50,
      spawn: (executable, openerArgs, options) => {
        command = executable;
        args = [...openerArgs];
        spawnOptions = options;
        launcherPath = fileURLToPath(openerArgs.at(-1)!);
        queueMicrotask(() => child.emit("spawn"));
        return child;
      },
    });

    assert.equal(command, "xdg-open");
    assert.deepEqual(spawnOptions, { detached: true, stdio: "ignore" });
    assert.equal(args?.length, 1);
    assert.match(args![0]!, /^file:\/\//);
    assert.equal(args![0]!.includes(ticket), false);
    assert.equal(args![0]!.includes("browser.example"), false);
    assert.equal(new URL(args![0]!).hash, "");
    assert.equal(child.unrefCalled, true);
    assert.equal(launcherPath!.includes(ticket), false);

    const directoryInfo = await stat(dirname(launcherPath!));
    const launcherInfo = await stat(launcherPath!);
    assert.equal(directoryInfo.mode & 0o777, 0o700);
    assert.equal(launcherInfo.mode & 0o777, 0o600);
    const contents = await readFile(launcherPath!, "utf8");
    assert.match(contents, /^<!doctype html>/);
    assert.match(contents, /<meta name="referrer" content="no-referrer">/);
    assert.equal(contents.includes(ticket), true);
    assert.equal(contents.includes("</script><img"), false);
    const redirect = /location\.replace\((.*)\)<\/script>/.exec(contents);
    assert.ok(redirect);
    assert.equal(JSON.parse(redirect[1]!), target);

    await waitForMissing(dirname(launcherPath!));
    assert.deepEqual(await readdir(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("external browser launch removes its private launcher on spawn failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "alder-browser-opener-failure-test-"));
  const ticket = "e".repeat(64);
  const target = `https://browser.example/index.html#ticket=${ticket}`;
  const child = new FakeBrowserOpener();
  let args: readonly string[] = [];
  try {
    await assert.rejects(
      openSystemBrowser(target, {
        platform: "linux",
        temporaryRoot: root,
        spawn: (_executable, openerArgs) => {
          args = [...openerArgs];
          queueMicrotask(() => child.emit("error", new Error("opener unavailable")));
          return child;
        },
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, "could not open system browser");
        assert.equal(error.message.includes(ticket), false);
        assert.equal(error.message.includes(target), false);
        return true;
      },
    );
    assert.equal(args.some(argument => argument.includes(ticket) || argument.includes("browser.example")), false);
    assert.deepEqual(await readdir(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("desktop-unavailable CLI error gives explicit alternatives", () => {
  const error = desktopUnavailableError();
  assert.equal(error.code, "desktop_unavailable");
  assert.match(error.message, /--browser/);
  assert.match(error.message, /--headless/);
});

import { describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { JsonRpcTransport } from "../src/acp/json-rpc.ts";

/**
 * Regression coverage for Devin review comments #1 and #2: every
 * outgoing JSON-RPC message MUST include the `jsonrpc: "2.0"` field.
 * Stricter servers (and Codex's future versions) will reject messages
 * without it.
 */

function makeFakeProc() {
  const emitter = new EventEmitter() as unknown as ChildProcess;
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  (emitter as unknown as { stdin: PassThrough }).stdin = stdin;
  (emitter as unknown as { stdout: PassThrough }).stdout = stdout;
  (emitter as unknown as { stderr: PassThrough }).stderr = stderr;
  (emitter as unknown as { exitCode: number | null }).exitCode = null;
  (emitter as unknown as { kill: () => void }).kill = () => {};
  return { proc: emitter, stdin, stdout };
}

describe("JsonRpcTransport spec compliance", () => {
  it('includes jsonrpc: "2.0" on every request', async () => {
    const { proc, stdin } = makeFakeProc();
    const transport = new JsonRpcTransport("fake", [], { label: "fake" });
    // Inject fake subprocess so we can observe stdin writes.
    (transport as unknown as { proc: typeof proc }).proc = proc;

    const writes: string[] = [];
    stdin.on("data", (chunk) => writes.push(chunk.toString("utf8")));

    // Fire-and-forget: we don't care about the response.
    void transport.request("someMethod", { foo: "bar" });

    // Give the microtask queue a tick to flush.
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(writes.length).toBe(1);
    const parsed = JSON.parse(writes[0]!);
    expect(parsed.jsonrpc).toBe("2.0");
    expect(parsed.method).toBe("someMethod");
    expect(parsed.id).toBe(1);
    expect(parsed.params).toEqual({ foo: "bar" });
  });

  it('includes jsonrpc: "2.0" on every notification', async () => {
    const { proc, stdin } = makeFakeProc();
    const transport = new JsonRpcTransport("fake", [], { label: "fake" });
    (transport as unknown as { proc: typeof proc }).proc = proc;

    const writes: string[] = [];
    stdin.on("data", (chunk) => writes.push(chunk.toString("utf8")));

    await transport.notify("initialized");

    expect(writes.length).toBe(1);
    const parsed = JSON.parse(writes[0]!);
    expect(parsed.jsonrpc).toBe("2.0");
    expect(parsed.method).toBe("initialized");
    expect("id" in parsed).toBe(false);
  });
});

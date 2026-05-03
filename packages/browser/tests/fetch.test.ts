import { describe, expect, it, vi } from "vitest";
import { tryFetchPack } from "../src/git/fetch.ts";
import type { FetchPackInput, FetchPackResult } from "../src/types.ts";

/**
 * Cover the input-validation + callback-shaping contract for
 * `tryFetchPack`. The fetch path's actual pack-indexing step requires
 * a real git tree fixture, so these tests deliberately fail at the
 * `findPackStart` step (the callback returns junk bytes) — that's
 * AFTER we've already validated the input and called fetchPack with
 * the right shape, which is the surface the review flagged.
 *
 * Regression target: `computeDiff`'s base-ref-miss path used to call
 * tryFetchPack with `wants: []`, hitting the early `no valid wants`
 * exit before fetchPack was ever invoked. The refNames mode is the
 * fix; these tests pin both:
 *
 *   - Empty wants AND empty refNames → fast-fail (preserved guard)
 *   - Empty wants + non-empty refNames → callback is called, refNames
 *     are passed through
 *   - `{ pack, refs }` response shape is recognized
 */

const STUB_FS = {
  promises: {
    mkdir: vi.fn(async () => undefined),
    writeFile: vi.fn(async () => undefined),
    readFile: vi.fn(async () => new Uint8Array()),
    stat: vi.fn(async () => {
      throw new Error("not found");
    }),
    readdir: vi.fn(async () => []),
    unlink: vi.fn(async () => undefined),
    rmdir: vi.fn(async () => undefined),
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;

describe("tryFetchPack input validation", () => {
  it("rejects when both wants and refNames are empty", async () => {
    const fetchPack = vi.fn(async () => new Uint8Array());
    const result = await tryFetchPack({
      fs: STUB_FS,
      gitdir: "/.git",
      cloneId: "c1",
      remoteUrl: "https://github.com/foo/bar.git",
      wants: [],
      haves: [],
      fetchPack,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("missing-object");
      expect(result.details).toMatch(/no valid wants or refNames/);
    }
    expect(fetchPack).not.toHaveBeenCalled();
  });

  it("rejects when wants is empty AND refNames is empty array", async () => {
    const fetchPack = vi.fn(async () => new Uint8Array());
    const result = await tryFetchPack({
      fs: STUB_FS,
      gitdir: "/.git",
      cloneId: "c1",
      remoteUrl: "",
      wants: [],
      haves: [],
      refNames: [],
      fetchPack,
    });
    expect(result.ok).toBe(false);
    expect(fetchPack).not.toHaveBeenCalled();
  });

  it("filters non-string and empty refNames before evaluating non-empty", async () => {
    const fetchPack = vi.fn(async () => new Uint8Array());
    const result = await tryFetchPack({
      fs: STUB_FS,
      gitdir: "/.git",
      cloneId: "c1",
      remoteUrl: "",
      wants: [],
      haves: [],
      // Mix of empty + null-likes that the filter must drop.
      refNames: ["", "  ".trim() /* ""*/],
      fetchPack,
    });
    // Only empties → still rejects without calling fetchPack.
    expect(result.ok).toBe(false);
    expect(fetchPack).not.toHaveBeenCalled();
  });

  it("calls fetchPack with refNames when wants is empty but refNames is set", async () => {
    let receivedInput: FetchPackInput | null = null;
    const fetchPack = vi.fn(async (input: FetchPackInput): Promise<FetchPackResult> => {
      receivedInput = input;
      // Return junk so the pipeline fails at `findPackStart` (we've
      // already exercised the input-shaping path which is what the
      // regression test cares about).
      return new Uint8Array([0, 0, 0, 0]);
    });
    const result = await tryFetchPack({
      fs: STUB_FS,
      gitdir: "/.git",
      cloneId: "c1",
      remoteUrl: "https://github.com/foo/bar.git",
      wants: [],
      haves: [],
      refNames: ["main"],
      fetchPack,
    });
    expect(fetchPack).toHaveBeenCalledTimes(1);
    expect(receivedInput).toMatchObject({
      cloneId: "c1",
      remoteUrl: "https://github.com/foo/bar.git",
      wants: [],
      haves: [],
      refNames: ["main"],
    });
    // Falls over at findPackStart — that's the expected non-success
    // signal for this stub harness, NOT a regression.
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("unknown");
      expect(result.details).toMatch(/PACK magic/);
    }
  });

  it("accepts mixed wants + refNames (proxy may use either source)", async () => {
    let lastInput: FetchPackInput | null = null;
    const fetchPack = vi.fn(async (input: FetchPackInput): Promise<FetchPackResult> => {
      lastInput = input;
      return new Uint8Array([0, 0, 0, 0]);
    });
    await tryFetchPack({
      fs: STUB_FS,
      gitdir: "/.git",
      cloneId: "c1",
      remoteUrl: "",
      // Fully formed sha + a refName at the same time.
      wants: ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
      haves: [],
      refNames: ["release/2026-04"],
      fetchPack,
    });
    expect(fetchPack).toHaveBeenCalledTimes(1);
    expect(lastInput).not.toBeNull();
    expect(lastInput!.wants).toEqual(["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]);
    expect(lastInput!.refNames).toEqual(["release/2026-04"]);
  });

  it("does not include refNames in callback input when only wants supplied", async () => {
    let lastInput: FetchPackInput | null = null;
    const fetchPack = vi.fn(async (input: FetchPackInput): Promise<FetchPackResult> => {
      lastInput = input;
      return new Uint8Array([0, 0, 0, 0]);
    });
    await tryFetchPack({
      fs: STUB_FS,
      gitdir: "/.git",
      cloneId: "c1",
      remoteUrl: "",
      wants: ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
      haves: [],
      fetchPack,
    });
    expect(lastInput).not.toBeNull();
    // Backwards compat: existing wants-mode consumers don't see a new
    // field; refNames is undefined so the input shape matches what
    // they've been observing.
    expect(lastInput!.refNames).toBeUndefined();
  });

  it("accepts the legacy Uint8Array response shape", async () => {
    // Same junk-bytes harness — we just verify the response-shape
    // discriminant doesn't reject it. Failure happens at
    // findPackStart (no PACK magic), not at the type check.
    const fetchPack = vi.fn(async (): Promise<FetchPackResult> => new Uint8Array([0]));
    const result = await tryFetchPack({
      fs: STUB_FS,
      gitdir: "/.git",
      cloneId: "c1",
      remoteUrl: "",
      wants: ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
      haves: [],
      fetchPack,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.details).toMatch(/PACK magic/);
    }
  });

  it("accepts the new { pack, refs } response shape", async () => {
    const fetchPack = vi.fn(
      async (): Promise<FetchPackResult> => ({
        pack: new Uint8Array([0]),
        refs: { main: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
      }),
    );
    const result = await tryFetchPack({
      fs: STUB_FS,
      gitdir: "/.git",
      cloneId: "c1",
      remoteUrl: "",
      wants: [],
      haves: [],
      refNames: ["main"],
      fetchPack,
    });
    // Same — type-shape was accepted; we fail at findPackStart.
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.details).toMatch(/PACK magic/);
    }
  });

  it("rejects an unrecognized response shape", async () => {
    // Consumer returned neither Uint8Array nor { pack, refs }.
    const fetchPack = vi.fn(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async (): Promise<any> => ({ wrong: "shape" }),
    );
    const result = await tryFetchPack({
      fs: STUB_FS,
      gitdir: "/.git",
      cloneId: "c1",
      remoteUrl: "",
      wants: ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
      haves: [],
      fetchPack,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("unknown");
      expect(result.details).toMatch(/Uint8Array|pack/);
    }
  });
});

import { mkdtempSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearHostBinding,
  hostBindingPath,
  loadHostBinding,
  saveHostBinding,
} from "../src/state/global-state.ts";

/**
 * Cover the persistence of `--host` / `--host-key` to `<dataDir>/host.json`:
 * the daemon writes once, subsequent boots read it back, perms are `0600`,
 * and `clear` removes the file.
 *
 * Each helper accepts an explicit `dataDir` so tests stay scoped to a tmp
 * dir instead of touching the real `~/.spawntree`.
 */
describe("HostBinding state file", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(resolve(tmpdir(), "spawntree-host-binding-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns null when no file exists", () => {
    expect(loadHostBinding(dir)).toBeNull();
  });

  it("save → load round-trips the binding", () => {
    saveHostBinding(
      { url: "http://controller:7777", key: "dh_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
      dir,
    );
    expect(loadHostBinding(dir)).toEqual({
      url: "http://controller:7777",
      key: "dh_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    });
  });

  it("hostBindingPath(dir) resolves to <dir>/host.json", () => {
    expect(hostBindingPath(dir)).toBe(resolve(dir, "host.json"));
  });

  it("file is mode 0600 so a snooping local user can't read the bearer token", () => {
    saveHostBinding(
      { url: "http://controller:7777", key: "dh_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
      dir,
    );
    const mode = statSync(hostBindingPath(dir)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("save overwrites a previous binding (CLI args override persisted file)", () => {
    saveHostBinding(
      { url: "http://old:7777", key: "dh_OLDxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" },
      dir,
    );
    saveHostBinding(
      { url: "http://new:8888", key: "dh_NEWxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" },
      dir,
    );
    const loaded = loadHostBinding(dir);
    expect(loaded?.url).toBe("http://new:8888");
    expect(loaded?.key.startsWith("dh_NEW")).toBe(true);
  });

  it("clear removes the file; load then returns null", () => {
    saveHostBinding(
      { url: "http://controller:7777", key: "dh_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
      dir,
    );
    expect(loadHostBinding(dir)).not.toBeNull();
    clearHostBinding(dir);
    expect(loadHostBinding(dir)).toBeNull();
  });

  it("clear is idempotent on an absent file", () => {
    expect(() => clearHostBinding(dir)).not.toThrow();
  });

  it("returns null on a corrupt JSON payload (graceful, never crashes boot)", () => {
    saveHostBinding(
      { url: "http://controller:7777", key: "dh_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
      dir,
    );
    writeFileSync(hostBindingPath(dir), "{ this is not json", "utf-8");
    expect(loadHostBinding(dir)).toBeNull();
  });

  it("returns null when fields are missing or wrong type (don't apply garbage)", () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(hostBindingPath(dir), JSON.stringify({ url: "http://x" }), "utf-8");
    expect(loadHostBinding(dir)).toBeNull();
  });
});

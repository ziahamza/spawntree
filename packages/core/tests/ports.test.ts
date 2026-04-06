import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PortAllocator } from "../src/env/ports.js";

describe("PortAllocator", () => {
  let tempDir: string;
  let allocator: PortAllocator;

  beforeEach(() => {
    tempDir = resolve(tmpdir(), `spawntree-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
    allocator = new PortAllocator(tempDir);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("allocates first available slot", () => {
    const port = allocator.allocate("env-1", process.pid);
    expect(port).toBe(10000);
  });

  it("allocates sequential slots", () => {
    const port1 = allocator.allocate("env-1", process.pid);
    const port2 = allocator.allocate("env-2", process.pid);
    expect(port1).toBe(10000);
    expect(port2).toBe(10100);
  });

  it("reuses existing allocation for same env", () => {
    const port1 = allocator.allocate("env-1", process.pid);
    const port2 = allocator.allocate("env-1", process.pid);
    expect(port1).toBe(port2);
  });

  it("frees allocated slot", () => {
    allocator.allocate("env-1", process.pid);
    allocator.allocate("env-2", process.pid);
    allocator.free("env-1");

    // Next allocation should reuse freed slot
    const port = allocator.allocate("env-3", process.pid);
    expect(port).toBe(10000);
  });

  it("calculates physical port correctly", () => {
    expect(PortAllocator.physicalPort(10000, 0)).toBe(10000);
    expect(PortAllocator.physicalPort(10000, 1)).toBe(10001);
    expect(PortAllocator.physicalPort(10100, 5)).toBe(10105);
  });

  it("throws on port range overflow", () => {
    expect(() => PortAllocator.physicalPort(10000, 100)).toThrow("exceeds port range");
  });

  it("lists allocated slots", () => {
    allocator.allocate("env-1", process.pid);
    allocator.allocate("env-2", process.pid);
    const slots = allocator.list();
    expect(slots).toHaveLength(2);
    expect(slots[0].envName).toBe("env-1");
    expect(slots[1].envName).toBe("env-2");
  });

  it("gets allocation by name", () => {
    allocator.allocate("env-1", process.pid);
    const slot = allocator.get("env-1");
    expect(slot).toBeDefined();
    expect(slot?.basePort).toBe(10000);
  });

  it("returns undefined for unknown env", () => {
    expect(allocator.get("missing")).toBeUndefined();
  });

  it("cleans up stale PIDs", () => {
    // Allocate with a fake PID that doesn't exist
    allocator.allocate("stale-env", 999999);
    // Next allocation should reclaim the stale slot
    const port = allocator.allocate("new-env", process.pid);
    expect(port).toBe(10000);
  });
});

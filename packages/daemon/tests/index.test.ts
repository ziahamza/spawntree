import { describe, expect, it } from "vitest";
import {
  daemonBinaryName,
  daemonBinaryTarget,
  supportedDaemonBinaryTargets,
} from "../src/index.js";

describe("daemonBinaryTarget", () => {
  it("maps Node x64 linux to Go amd64 linux", () => {
    expect(daemonBinaryTarget("linux", "x64")).toEqual({
      platform: "linux",
      arch: "x64",
      goOs: "linux",
      goArch: "amd64",
      ext: "",
    });
    expect(daemonBinaryName("linux", "x64")).toBe("spawntreed-linux-amd64");
  });

  it("maps Node x64 macOS to Go amd64 darwin", () => {
    expect(daemonBinaryName("darwin", "x64")).toBe("spawntreed-darwin-amd64");
  });

  it("maps Node win32 x64 to Go windows amd64", () => {
    expect(daemonBinaryName("win32", "x64")).toBe("spawntreed-windows-amd64.exe");
  });

  it("rejects unsupported targets", () => {
    expect(() => daemonBinaryTarget("linux", "ia32")).toThrow(/Unsupported daemon platform/);
  });

  it("enumerates the packaged targets", () => {
    expect(supportedDaemonBinaryTargets()).toHaveLength(6);
  });
});

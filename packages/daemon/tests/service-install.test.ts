import { describe, expect, it } from "vitest";
import {
  detectPlatform,
  renderLaunchdPlist,
  renderSystemdUnit,
  type ServiceSpec,
} from "../src/service/install.ts";

const SPEC: ServiceSpec = {
  node: "/usr/local/bin/node",
  entry: "/home/u/.npm/_npx/abc/node_modules/spawntree-daemon/dist/server-main.js",
  home: "/home/u/.spawntree",
};

describe("renderLaunchdPlist", () => {
  it("emits a launchd agent with node+entry, RunAtLoad and KeepAlive", () => {
    const plist = renderLaunchdPlist(SPEC);
    expect(plist).toContain("<!DOCTYPE plist");
    expect(plist).toContain("<string>dev.gitenv.spawntree-daemon</string>");
    expect(plist).toContain(`<string>${SPEC.node}</string>`);
    expect(plist).toContain(`<string>${SPEC.entry}</string>`);
    expect(plist).toContain("<key>RunAtLoad</key>");
    expect(plist).toContain("<key>KeepAlive</key>");
  });

  it("XML-escapes metacharacters in paths", () => {
    const plist = renderLaunchdPlist({ ...SPEC, entry: "/a&b/<x>.js" });
    expect(plist).toContain("/a&amp;b/&lt;x&gt;.js");
    expect(plist).not.toContain("<string>/a&b/<x>.js</string>");
  });
});

describe("renderSystemdUnit", () => {
  it("emits ExecStart, Restart=always and WantedBy=default.target", () => {
    const unit = renderSystemdUnit(SPEC);
    expect(unit).toContain(`ExecStart=${SPEC.node} ${SPEC.entry}`);
    expect(unit).toContain("Restart=always");
    expect(unit).toContain("WantedBy=default.target");
    expect(unit).toContain(`WorkingDirectory=${SPEC.home}`);
  });
});

describe("detectPlatform", () => {
  it("returns the current platform when supported, else throws", () => {
    if (process.platform === "darwin" || process.platform === "linux") {
      expect(detectPlatform()).toBe(process.platform);
    } else {
      expect(() => detectPlatform()).toThrow(/unsupported platform/);
    }
  });
});

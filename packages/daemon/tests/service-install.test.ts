import { describe, expect, it } from "vitest";
import {
  detectPlatform,
  isHostKey,
  isHttpUrl,
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

  it("uses ProgramArguments array (not ExecStart), so spaces in paths are safe on macOS", () => {
    const spec: ServiceSpec = {
      node: "/Users/First Last/nvm/versions/node/v20.0.0/bin/node",
      entry: "/Users/First Last/.npm/_npx/abc/dist/server-main.js",
      home: "/Users/First Last/.spawntree",
    };
    const plist = renderLaunchdPlist(spec);
    // launchd ProgramArguments uses one <string> per argument — spaces in
    // a path element are fine because the path is never shell-word-split.
    expect(plist).toContain(`<string>${spec.node}</string>`);
    expect(plist).toContain(`<string>${spec.entry}</string>`);
  });
});

describe("renderSystemdUnit", () => {
  it("emits ExecStart with double-quoted paths, Restart=always and WantedBy=default.target", () => {
    const unit = renderSystemdUnit(SPEC);
    // Paths must be individually double-quoted so systemd does not split on
    // spaces. The form is: ExecStart="<node>" "<entry>"
    expect(unit).toContain(`ExecStart="${SPEC.node}" "${SPEC.entry}"`);
    expect(unit).toContain("Restart=always");
    expect(unit).toContain("WantedBy=default.target");
    expect(unit).toContain(`WorkingDirectory=${SPEC.home}`);
  });

  it("paths with spaces are preserved correctly via quoting (not word-split)", () => {
    const spec: ServiceSpec = {
      node: "/home/my user/nvm/node",
      entry: "/home/my user/.npm/server-main.js",
      home: "/home/my user/.spawntree",
    };
    const unit = renderSystemdUnit(spec);
    // systemd does NOT shell-word-split ExecStart — it parses the
    // double-quoted tokens directly. Verify each path appears as a
    // standalone quoted token.
    expect(unit).toContain(`"${spec.node}"`);
    expect(unit).toContain(`"${spec.entry}"`);
    // The unquoted form with a space would be misread as two arguments.
    expect(unit).not.toContain(`ExecStart=${spec.node} ${spec.entry}`);
  });

  it("internal double-quotes in paths are backslash-escaped", () => {
    const spec: ServiceSpec = {
      node: '/usr/bin/node"bad',
      entry: "/home/u/server-main.js",
      home: "/home/u/.spawntree",
    };
    const unit = renderSystemdUnit(spec);
    expect(unit).toContain('"/usr/bin/node\\"bad"');
  });
});

describe("isHttpUrl", () => {
  it("accepts http:// and https:// URLs", () => {
    expect(isHttpUrl("http://localhost:7777")).toBe(true);
    expect(isHttpUrl("https://host.example.com")).toBe(true);
    expect(isHttpUrl("https://host.example.com/")).toBe(true);
  });

  it("rejects non-HTTP protocols, bare strings, and garbage", () => {
    expect(isHttpUrl("ftp://host")).toBe(false);
    expect(isHttpUrl("not-a-url")).toBe(false);
    expect(isHttpUrl("")).toBe(false);
    expect(isHttpUrl("//host")).toBe(false);
  });

  it("strips trailing slashes before parsing (matches server-main.ts behaviour)", () => {
    // Trailing slash is stripped; URL is still valid.
    expect(isHttpUrl("http://host:7777/")).toBe(true);
    expect(isHttpUrl("http://host:7777///")).toBe(true);
  });
});

describe("isHostKey", () => {
  it("accepts well-formed dh_ keys (dh_ + ≥40 base64url chars)", () => {
    expect(isHostKey("dh_" + "A".repeat(40))).toBe(true);
    expect(isHostKey("dh_" + "Az09_-".repeat(7))).toBe(true);
  });

  it("rejects keys that are too short, wrong prefix, or contain invalid chars", () => {
    expect(isHostKey("dh_short")).toBe(false);
    expect(isHostKey("sk_" + "A".repeat(40))).toBe(false);
    expect(isHostKey("dh_" + "A".repeat(39))).toBe(false);
    // Space is not in base64url
    expect(isHostKey("dh_" + "A ".repeat(20))).toBe(false);
    expect(isHostKey("")).toBe(false);
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

import { describe, expect, it } from "vitest";
import {
  buildCorsHeaders,
  corsHeaderEntries,
  corsPolicyFromEnv,
  isAllowedBrowserOrigin,
} from "../src/lib/cors.ts";

describe("CORS / PNA helpers", () => {
  describe("isAllowedBrowserOrigin", () => {
    const policy = { trustRemote: false };

    it("allows loopback origins on any port", () => {
      expect(isAllowedBrowserOrigin("http://127.0.0.1:5173", policy)).toBe(true);
      expect(isAllowedBrowserOrigin("http://localhost:3000", policy)).toBe(true);
      expect(isAllowedBrowserOrigin("http://[::1]:8080", policy)).toBe(true);
    });

    it("allows the gitenv production origins by default", () => {
      expect(isAllowedBrowserOrigin("https://gitenv.dev", policy)).toBe(true);
      expect(isAllowedBrowserOrigin("https://www.gitenv.dev", policy)).toBe(true);
      expect(isAllowedBrowserOrigin("https://studio.gitenv.dev", policy)).toBe(true);
      expect(isAllowedBrowserOrigin("https://app.gitenv.dev", policy)).toBe(true);
    });

    it("rejects unknown origins by default", () => {
      expect(isAllowedBrowserOrigin("https://evil.example.com", policy)).toBe(false);
      expect(isAllowedBrowserOrigin("https://gitenv.dev.evil.com", policy)).toBe(false);
      expect(isAllowedBrowserOrigin("http://gitenv.dev", policy)).toBe(false); // wrong scheme
    });

    it("opens up to any origin when trustRemote is true", () => {
      const trust = { trustRemote: true };
      expect(isAllowedBrowserOrigin("https://anything.test", trust)).toBe(true);
      expect(isAllowedBrowserOrigin("http://attacker.example", trust)).toBe(true);
    });

    it("respects extra origins from policy", () => {
      const withExtra = {
        trustRemote: false,
        extraOrigins: ["https://my-self-hosted.test"],
      };
      expect(isAllowedBrowserOrigin("https://my-self-hosted.test", withExtra)).toBe(true);
      expect(isAllowedBrowserOrigin("https://other.test", withExtra)).toBe(false);
    });

    it("rejects malformed origins", () => {
      expect(isAllowedBrowserOrigin("not a url", policy)).toBe(false);
      expect(isAllowedBrowserOrigin("", policy)).toBe(false);
    });
  });

  describe("buildCorsHeaders", () => {
    it("includes the standard set of CORS headers", () => {
      const h = buildCorsHeaders("https://gitenv.dev");
      expect(h.get("Access-Control-Allow-Origin")).toBe("https://gitenv.dev");
      expect(h.get("Access-Control-Allow-Methods")).toBe("GET,POST,DELETE,OPTIONS");
      expect(h.get("Access-Control-Allow-Headers")).toBe("Content-Type, Authorization");
      expect(h.get("Vary")).toContain("Origin");
      expect(h.get("Vary")).toContain("Access-Control-Request-Private-Network");
    });

    it("echoes Access-Control-Allow-Private-Network when preflight requested it", () => {
      const h = buildCorsHeaders("https://gitenv.dev", { pnaRequested: true });
      expect(h.get("Access-Control-Allow-Private-Network")).toBe("true");
    });

    it("omits the PNA header when not requested", () => {
      const h = buildCorsHeaders("https://gitenv.dev");
      expect(h.has("Access-Control-Allow-Private-Network")).toBe(false);
    });

    it("respects a custom methods list", () => {
      const h = buildCorsHeaders("https://gitenv.dev", { methods: "GET,POST,OPTIONS" });
      expect(h.get("Access-Control-Allow-Methods")).toBe("GET,POST,OPTIONS");
    });
  });

  describe("corsHeaderEntries", () => {
    it("returns the same headers in tuple form", () => {
      const entries = corsHeaderEntries("https://gitenv.dev", { pnaRequested: true });
      const map = new Map(entries);
      expect(map.get("Access-Control-Allow-Origin")).toBe("https://gitenv.dev");
      expect(map.get("Access-Control-Allow-Private-Network")).toBe("true");
    });
  });

  describe("corsPolicyFromEnv", () => {
    it("reads SPAWNTREE_*_TRUST_REMOTE=1", () => {
      const flag = "__TEST_TRUST_REMOTE__";
      try {
        process.env[flag] = "1";
        expect(corsPolicyFromEnv(flag).trustRemote).toBe(true);
      } finally {
        delete process.env[flag];
      }
    });

    it("parses SPAWNTREE_CORS_ORIGINS as comma-separated", () => {
      try {
        process.env["SPAWNTREE_CORS_ORIGINS"] = "https://a.test, https://b.test";
        const policy = corsPolicyFromEnv("__NOT_SET__");
        expect(policy.extraOrigins).toEqual(["https://a.test", "https://b.test"]);
      } finally {
        delete process.env["SPAWNTREE_CORS_ORIGINS"];
      }
    });
  });
});

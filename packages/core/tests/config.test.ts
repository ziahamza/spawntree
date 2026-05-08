import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config/parser.ts";
import { validateConfig } from "../src/config/schema.ts";
import { findVarRefs, substituteVars } from "../src/config/substitution.ts";

describe("substituteVars", () => {
  it("replaces ${VAR} with value", () => {
    expect(substituteVars("hello ${NAME}", { NAME: "world" })).toBe("hello world");
  });

  it("leaves unresolved vars intact", () => {
    expect(substituteVars("${MISSING}", {})).toBe("${MISSING}");
  });

  it("collects missing vars", () => {
    const missing = new Set<string>();
    substituteVars("${A} and ${B}", { A: "1" }, missing);
    expect(missing).toEqual(new Set(["B"]));
  });

  it("handles multiple substitutions", () => {
    expect(substituteVars("${A}:${B}", { A: "x", B: "y" })).toBe("x:y");
  });

  it("handles no substitutions", () => {
    expect(substituteVars("plain text", {})).toBe("plain text");
  });
});

describe("findVarRefs", () => {
  it("finds all variable references", () => {
    expect(findVarRefs("${A} and ${B}")).toEqual(["A", "B"]);
  });

  it("returns empty for no refs", () => {
    expect(findVarRefs("no vars here")).toEqual([]);
  });
});

describe("parseConfig", () => {
  it("parses valid YAML with substitution", () => {
    const yaml = `
services:
  api:
    type: process
    command: node server.js
    port: 3000
    environment:
      SECRET: \${MY_SECRET}
`;
    const config = parseConfig(yaml, { MY_SECRET: "s3cret" });
    expect(config.services.api.type).toBe("process");
    expect(config.services.api.environment?.SECRET).toBe("s3cret");
  });

  it("preserves unresolved vars in config", () => {
    const yaml = `
services:
  db:
    type: postgres
    fork_from: \${PROD_DB_URL}
`;
    const config = parseConfig(yaml, {});
    expect(config.services.db.fork_from).toBe("${PROD_DB_URL}");
  });

  it("treats explicit default profile as no-op when config has no profiles", () => {
    const yaml = `
services:
  app:
    type: process
    command: node server.js
`;
    const config = parseConfig(yaml, {}, { profile: "default" });
    expect(config.services.app.command).toBe("node server.js");
  });

  it("applies default profile when profiles are present", () => {
    const yaml = `
services:
  api:
    type: process
    command: node server.js
profiles:
  default:
    environment:
      API_PORT: "8787"
    services:
      api:
        command: node server.js --port \${API_PORT}
`;
    const config = parseConfig(yaml, {});
    expect(config.services.api.command).toBe("node server.js --port 8787");
  });

  it("overlays named profiles and inherited services", () => {
    const yaml = `
services:
  api:
    type: process
    command: node server.js
profiles:
  powersync:
    services:
      powersync:
        type: container
        image: journeyapps/powersync-service:latest
  local:
    extends: powersync
    services:
      db:
        type: postgres
      api:
        depends_on: [db, powersync]
`;
    const config = parseConfig(yaml, {}, { profile: "local" });
    expect(config.services.api.depends_on).toEqual(["db", "powersync"]);
    expect(config.services.powersync.type).toBe("container");
    expect(config.services.db.type).toBe("postgres");
  });
});

describe("validateConfig", () => {
  it("accepts valid config", () => {
    const result = validateConfig({
      prepare: { command: "pnpm install", inputs: ["package.json"] },
      services: {
        api: { type: "process", command: "node server.js" },
      },
    });
    expect("config" in result).toBe(true);
  });

  it("rejects missing services", () => {
    const result = validateConfig({});
    expect("errors" in result).toBe(true);
  });

  it("rejects empty services", () => {
    const result = validateConfig({ services: {} });
    expect("errors" in result).toBe(true);
    if ("errors" in result) {
      expect(result.errors[0].message).toContain("At least one service");
    }
  });

  it("rejects unknown service type", () => {
    const result = validateConfig({
      services: { api: { type: "unknown" } },
    });
    expect("errors" in result).toBe(true);
    if ("errors" in result) {
      expect(result.errors[0].message).toContain("Unknown type");
    }
  });

  it("rejects process without command", () => {
    const result = validateConfig({
      services: { api: { type: "process" } },
    });
    expect("errors" in result).toBe(true);
    if ("errors" in result) {
      expect(result.errors[0].message).toContain("command is required");
    }
  });

  it("rejects container without image", () => {
    const result = validateConfig({
      services: { db: { type: "container" } },
    });
    expect("errors" in result).toBe(true);
    if ("errors" in result) {
      expect(result.errors[0].message).toContain("image is required");
    }
  });

  it("rejects unknown dependency", () => {
    const result = validateConfig({
      services: {
        api: { type: "process", command: "node", depends_on: ["missing"] },
      },
    });
    expect("errors" in result).toBe(true);
    if ("errors" in result) {
      expect(result.errors[0].message).toContain('Unknown dependency "missing"');
    }
  });

  it("detects circular dependencies", () => {
    const result = validateConfig({
      services: {
        a: { type: "process", command: "a", depends_on: ["b"] },
        b: { type: "process", command: "b", depends_on: ["a"] },
      },
    });
    expect("errors" in result).toBe(true);
    if ("errors" in result) {
      expect(result.errors.some((e) => e.message.includes("Circular"))).toBe(true);
    }
  });

  it("accepts valid depends_on", () => {
    const result = validateConfig({
      services: {
        db: { type: "postgres" },
        api: { type: "process", command: "node", depends_on: ["db"] },
      },
    });
    expect("config" in result).toBe(true);
  });
});

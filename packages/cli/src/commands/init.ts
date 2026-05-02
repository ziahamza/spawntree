import type { Command } from "commander";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml, stringify } from "yaml";

export function registerInitCommand(program: Command): void {
  program
    .command("init")
    .description("Generate a spawntree.yaml config file")
    .option("--from-compose", "Convert from docker-compose.yml")
    .option("--from-package", "Generate from package.json scripts")
    .action((options) => {
      const configFile = resolve(process.cwd(), "spawntree.yaml");

      if (existsSync(configFile)) {
        console.error("spawntree.yaml already exists. Delete it first to regenerate.");
        process.exit(1);
      }

      if (options.fromCompose) {
        const composePath = resolve(process.cwd(), "docker-compose.yml");
        const composeAltPath = resolve(process.cwd(), "docker-compose.yaml");
        const actualPath = existsSync(composePath)
          ? composePath
          : existsSync(composeAltPath)
            ? composeAltPath
            : null;

        if (!actualPath) {
          console.error("No docker-compose.yml or docker-compose.yaml found.");
          process.exit(1);
        }

        const config = convertFromCompose(actualPath);
        writeFileSync(configFile, config);
        console.log("Created spawntree.yaml from docker-compose.yml");
        console.log("Review and adjust the generated config before running spawntree up.");
        return;
      }

      if (options.fromPackage) {
        const packagePath = resolve(process.cwd(), "package.json");
        if (!existsSync(packagePath)) {
          console.error("No package.json found.");
          process.exit(1);
        }

        const config = convertFromPackage(packagePath);
        writeFileSync(configFile, config);
        console.log("Created spawntree.yaml from package.json");
        return;
      }

      // Default: generate a template
      const template = generateTemplate();
      writeFileSync(configFile, template);
      console.log("Created spawntree.yaml with example template.");
      console.log('Edit it to match your project, then run "spawntree up".');
    });
}

function convertFromCompose(composePath: string): string {
  const content = readFileSync(composePath, "utf-8");
  const compose = parseYaml(content) as Record<string, unknown>;
  const composeServices = (compose.services || {}) as Record<string, Record<string, unknown>>;

  const services: Record<string, Record<string, unknown>> = {};

  for (const [name, svc] of Object.entries(composeServices)) {
    if (svc.image) {
      services[name] = {
        type: "container",
        image: svc.image,
      };

      if (svc.ports && Array.isArray(svc.ports) && svc.ports.length > 0) {
        const portStr = String(svc.ports[0]);
        const parts = portStr.split(":");
        services[name].port = parseInt(parts[parts.length - 1], 10);
      }

      if (svc.environment) {
        services[name].environment = svc.environment;
      }
    } else if (svc.build) {
      services[name] = {
        type: "process",
        command: `# TODO: replace with your start command for ${name}`,
      };

      if (svc.ports && Array.isArray(svc.ports) && svc.ports.length > 0) {
        const portStr = String(svc.ports[0]);
        const parts = portStr.split(":");
        services[name].port = parseInt(parts[parts.length - 1], 10);
      }
    }

    if (svc.depends_on && services[name]) {
      const deps = Array.isArray(svc.depends_on)
        ? svc.depends_on
        : Object.keys(svc.depends_on as Record<string, unknown>);
      services[name].depends_on = deps;
    }
  }

  return stringify({ services }, { lineWidth: 120 });
}

function convertFromPackage(packagePath: string): string {
  const pkg = JSON.parse(readFileSync(packagePath, "utf-8")) as Record<string, unknown>;
  const scripts = (pkg.scripts || {}) as Record<string, string>;

  const services: Record<string, Record<string, unknown>> = {};

  // Common script patterns to convert
  const startScripts = ["start", "dev", "serve", "server"];

  for (const scriptName of startScripts) {
    if (scripts[scriptName]) {
      services[scriptName === "start" ? "app" : scriptName] = {
        type: "process",
        command: scripts[scriptName],
        port: 3000,
      };
      break;
    }
  }

  if (Object.keys(services).length === 0) {
    services.app = {
      type: "process",
      command: "# TODO: add your start command",
      port: 3000,
    };
  }

  return stringify({ services }, { lineWidth: 120 });
}

function generateTemplate(): string {
  return `# spawntree configuration
# See: https://github.com/spawntree/spawntree

services:
  app:
    type: process
    command: node src/server.js
    port: 3000
    healthcheck:
      url: http://localhost:\${PORT}/health
      timeout: 30
    # toolchain:
    #   node: "22"

  # worker:
  #   type: process
  #   command: node src/worker.js
  #   depends_on:
  #     - app

  # db:
  #   type: postgres
  #   fork_from: \${PROD_DATABASE_URL}  # optional: seed from another database

  # redis:
  #   type: redis

  # legacy:
  #   type: container
  #   image: some-image:latest
  #   port: 8080
`;
}

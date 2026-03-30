#!/usr/bin/env node

import { Command } from "commander";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { registerUpCommand } from "./commands/up.js";
import { registerDownCommand } from "./commands/down.js";
import { registerStatusCommand } from "./commands/status.js";
import { registerLogsCommand } from "./commands/logs.js";
import { registerRmCommand } from "./commands/rm.js";
import { registerInitCommand } from "./commands/init.js";

const program = new Command();

program
  .name("spawntree")
  .description("Isolated environment orchestrator")
  .version("0.1.0")
  .option("--config-file <path>", "Path to spawntree.yaml", "spawntree.yaml")
  .option("--lock-file <path>", "Path to lock file");

registerUpCommand(program);
registerDownCommand(program);
registerStatusCommand(program);
registerLogsCommand(program);
registerRmCommand(program);
registerInitCommand(program);

program.parse();

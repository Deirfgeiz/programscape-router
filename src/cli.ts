#!/usr/bin/env node
import { main } from "./cli-main.js";

main(process.argv.slice(2), {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
}).then(
  (code) => {
    // The MCP server keeps the process alive through its stdio transport.
    if (code !== 0) process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`programscape-router: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);

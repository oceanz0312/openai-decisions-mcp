#!/usr/bin/env node
// openai-decisions-mcp CLI: boots the MCP server over stdio (default) or stateless HTTP.
//
// This entry is the `openai-decisions-mcp` bin; running it starts a transport. It is NOT
// the package's import entry: `exports` maps the root import to
// dist/server.js, which exposes `createServer()` without booting anything,
// so importing the package from another process never opens stdio or a
// listener.
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createServer, MODEL } from "./server.js";

if (process.argv.includes("--http") || process.env.OPENAI_DECISIONS_MCP_TRANSPORT === "http") {
  const { serveHttp } = await import("./http.js");
  const { url } = await serveHttp(createServer);
  console.error(`[openai-decisions-mcp] ready — model ${MODEL}, stateless HTTP at ${url}`);
} else {
  serveStdio(createServer);
  console.error(`[openai-decisions-mcp] ready — model ${MODEL}`);
}

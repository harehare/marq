// marq's tools over MCP's streamable HTTP, for agents that run in a process of their own (ACP agents).
// The Claude backend hands the same tools to the Agent SDK in-process instead.
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { log } from "./protocol.ts";
import { vaultServer } from "./tools.ts";

/** Token in the URL → the session its tools act for. */
const routes = new Map<string, { sessionId: string }>();
let port: Promise<number> | undefined;

/** Starts the server on a free loopback port the first time a session needs it. */
function listen(): Promise<number> {
  return (port ??= new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      const route = routes.get(req.url?.split("?")[0].replace(/^\/mcp\//, "") ?? "");
      if (!route) {
        res.writeHead(404).end();
        return;
      }
      // Stateless: a server and a transport for each request.
      const { instance } = vaultServer(route.sessionId);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => {
        void transport.close();
        void instance.close();
      });
      try {
        await instance.connect(transport);
        await transport.handleRequest(req, res);
      } catch (e) {
        log("mcp request failed:", e);
        if (!res.headersSent) res.writeHead(500).end();
      }
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
    server.unref();
  }));
}

/** A URL that serves marq's tools to one session, until `close`. The random token keeps other local processes out. */
export async function mcpUrl(sessionId: string): Promise<{ url: string; close: () => void }> {
  const p = await listen();
  const token = randomBytes(24).toString("hex");
  routes.set(token, { sessionId });
  return { url: `http://127.0.0.1:${p}/mcp/${token}`, close: () => routes.delete(token) };
}

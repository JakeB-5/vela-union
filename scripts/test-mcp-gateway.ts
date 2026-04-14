#!/usr/bin/env npx tsx
// Phase 4 — End-to-end test of the unified Vela Union MCP gateway.
//
// Spawns the gateway as a stdio MCP server (the same way Claude Code would),
// sends raw JSON-RPC frames, and verifies that:
//   1. initialization handshake succeeds
//   2. tools/list reports tools from every namespace (doc.* graph.* gstack.* vela.*)
//   3. graph.stats works against the already-built sweditor-v2 graph
//   4. vela.list_projects returns the registry contents
//   5. gstack.check_availability reports the Claude CLI status
//   6. the server shuts down cleanly
//
// Run with:
//   pnpm --filter @vela-union/mcp-gateway build && \
//   node --experimental-strip-types scripts/test-mcp-gateway.ts

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { resolve } from "node:path";

const SERVER_SCRIPT = resolve(
  "/Users/jin/projects/vela-union/packages/mcp-gateway/dist/server.js",
);

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface ToolDescriptor {
  name: string;
  description?: string;
}

let passed = 0;
let failed = 0;

function assert(cond: unknown, label: string): void {
  if (cond) {
    console.log(`  PASS: ${label}`);
    passed++;
  } else {
    console.error(`  FAIL: ${label}`);
    failed++;
  }
}

/** Minimal stdio JSON-RPC client wrapper. */
class StdioClient {
  private readonly proc: ChildProcessWithoutNullStreams;
  private buffer = "";
  private nextId = 1;
  private readonly pending = new Map<
    number,
    {
      resolve: (value: JsonRpcResponse) => void;
      reject: (err: Error) => void;
    }
  >();

  constructor(scriptPath: string) {
    this.proc = spawn("node", [scriptPath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });

    this.proc.stdout.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString("utf-8");
      this.drainBuffer();
    });

    this.proc.stderr.on("data", (chunk: Buffer) => {
      // Stderr is informational; print it so test runners see startup logs.
      process.stderr.write(`[gateway] ${chunk.toString("utf-8")}`);
    });

    this.proc.on("error", (err) => {
      for (const { reject } of this.pending.values()) reject(err);
      this.pending.clear();
    });
  }

  private drainBuffer(): void {
    // MCP stdio frames are newline-delimited JSON.
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line) as JsonRpcResponse;
        if (typeof msg.id === "number" && this.pending.has(msg.id)) {
          const handler = this.pending.get(msg.id)!;
          this.pending.delete(msg.id);
          handler.resolve(msg);
        }
      } catch (err) {
        console.error(`  WARN: failed to parse response line: ${line.slice(0, 200)}`);
        void err;
      }
    }
  }

  request(method: string, params?: unknown): Promise<JsonRpcResponse> {
    const id = this.nextId++;
    const req: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolveP, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`request '${method}' timed out after 30s`));
        }
      }, 30_000);
      this.pending.set(id, {
        resolve: (msg) => {
          clearTimeout(timer);
          resolveP(msg);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      this.proc.stdin.write(JSON.stringify(req) + "\n");
    });
  }

  notify(method: string, params?: unknown): void {
    const msg = { jsonrpc: "2.0", method, params };
    this.proc.stdin.write(JSON.stringify(msg) + "\n");
  }

  close(): Promise<number | null> {
    return new Promise((resolveP) => {
      this.proc.on("close", (code) => resolveP(code));
      this.proc.stdin.end();
      // Force-kill after 5s if it didn't exit cleanly.
      setTimeout(() => {
        if (this.proc.exitCode === null) this.proc.kill("SIGTERM");
      }, 5_000);
    });
  }
}

function unwrapToolText(result: unknown): unknown {
  // MCP tool responses are { content: [{ type: "text", text: "..." }] }
  if (
    typeof result === "object" &&
    result !== null &&
    "content" in result &&
    Array.isArray((result as { content: unknown[] }).content)
  ) {
    const content = (result as { content: Array<{ type: string; text?: string }> }).content;
    const first = content[0];
    if (first && first.type === "text" && typeof first.text === "string") {
      try {
        return JSON.parse(first.text);
      } catch {
        return first.text;
      }
    }
  }
  return result;
}

async function main(): Promise<void> {
  console.log("\n=== Vela MCP Gateway: Phase 4 Integration Test ===\n");
  console.log(`Server: ${SERVER_SCRIPT}`);

  const client = new StdioClient(SERVER_SCRIPT);

  try {
    // --- Step 1: initialize ---
    console.log("\n[1/6] initialize");
    const init = await client.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "vela-test-client", version: "0.1.0" },
    });
    assert(init.error === undefined, "initialize succeeded without error");
    assert(
      init.result !== undefined &&
        typeof init.result === "object" &&
        "serverInfo" in (init.result as Record<string, unknown>),
      "initialize result includes serverInfo",
    );

    // MCP requires this notification after initialize succeeds.
    client.notify("notifications/initialized", {});

    // --- Step 2: tools/list ---
    console.log("\n[2/6] tools/list");
    const listResp = await client.request("tools/list", {});
    assert(listResp.error === undefined, "tools/list succeeded without error");

    const tools =
      (listResp.result as { tools?: ToolDescriptor[] } | undefined)?.tools ?? [];
    const toolNames = tools.map((t) => t.name).sort();
    console.log(`      ${tools.length} tools registered:`);
    for (const name of toolNames) console.log(`        - ${name}`);

    const docTools = toolNames.filter((n) => n.startsWith("doc."));
    const graphTools = toolNames.filter((n) => n.startsWith("graph."));
    const gstackTools = toolNames.filter((n) => n.startsWith("gstack."));
    const velaTools = toolNames.filter((n) => n.startsWith("vela."));

    assert(docTools.length === 3, `doc.* has 3 tools (got ${docTools.length})`);
    assert(graphTools.length === 6, `graph.* has 6 tools (got ${graphTools.length})`);
    assert(gstackTools.length === 4, `gstack.* has 4 tools (got ${gstackTools.length})`);
    assert(velaTools.length === 1, `vela.* has 1 tool (got ${velaTools.length})`);

    // Spot-check expected tool names exist
    const required = [
      "doc.index",
      "doc.get_structure",
      "doc.get_pages",
      "graph.build",
      "graph.query",
      "graph.get_neighbors",
      "graph.get_node",
      "graph.stats",
      "graph.refresh",
      "gstack.execute_skill",
      "gstack.dispatch_goal",
      "gstack.list_goals",
      "gstack.check_availability",
      "vela.list_projects",
    ];
    for (const name of required) {
      assert(toolNames.includes(name), `tool '${name}' is registered`);
    }

    // --- Step 3: graph.stats for sweditor-v2 (already built) ---
    console.log("\n[3/6] graph.stats for sweditor-v2");
    const statsResp = await client.request("tools/call", {
      name: "graph.stats",
      arguments: { projectName: "sweditor-v2" },
    });
    assert(statsResp.error === undefined, "graph.stats call did not error");
    const statsBody = unwrapToolText(statsResp.result) as {
      success?: boolean;
      stats?: { nodes?: number; edges?: number; exists?: boolean };
    };
    console.log(`      ${JSON.stringify(statsBody)}`);
    assert(statsBody.success === true, "graph.stats returned success=true");
    if (statsBody.stats?.exists) {
      assert(
        (statsBody.stats?.nodes ?? 0) > 0,
        "sweditor-v2 graph has > 0 nodes",
      );
    } else {
      console.log(
        "      (sweditor-v2 graph not built — skipping nodes>0 check)",
      );
    }

    // --- Step 4: vela.list_projects ---
    console.log("\n[4/6] vela.list_projects");
    const projResp = await client.request("tools/call", {
      name: "vela.list_projects",
      arguments: {},
    });
    assert(projResp.error === undefined, "vela.list_projects did not error");
    const projBody = unwrapToolText(projResp.result) as {
      success?: boolean;
      count?: number;
      projects?: Array<{ name: string }>;
    };
    console.log(`      registered projects: ${projBody.count}`);
    assert(projBody.success === true, "vela.list_projects returned success");
    assert(Array.isArray(projBody.projects), "projects is an array");

    // --- Step 5: gstack.check_availability ---
    console.log("\n[5/6] gstack.check_availability");
    const claudeResp = await client.request("tools/call", {
      name: "gstack.check_availability",
      arguments: {},
    });
    assert(claudeResp.error === undefined, "gstack.check_availability did not error");
    const claudeBody = unwrapToolText(claudeResp.result) as {
      success?: boolean;
      data?: { available?: boolean; path?: string | null; version?: string | null };
    };
    console.log(`      ${JSON.stringify(claudeBody.data)}`);
    assert(claudeBody.success === true, "check_availability returned success");
    assert(
      typeof claudeBody.data?.available === "boolean",
      "data.available is a boolean",
    );

    // --- Step 6: clean shutdown ---
    console.log("\n[6/6] shutdown");
    const exitCode = await client.close();
    console.log(`      gateway exited with code ${exitCode ?? "null"}`);
    assert(
      exitCode === 0 || exitCode === null,
      "gateway exited cleanly (0 or null)",
    );
  } catch (err) {
    console.error(`\nFATAL: ${(err as Error).message}`);
    failed++;
    await client.close();
  }

  console.log("\n=== Summary ===");
  console.log(`  Passed: ${passed}`);
  console.log(`  Failed: ${failed}`);
  console.log(`  Total:  ${passed + failed}`);

  if (failed > 0) {
    console.error("\nSome tests failed!");
    process.exit(1);
  }
  console.log("\nAll tests passed!");
}

main().catch((err: unknown) => {
  console.error(`Unhandled error: ${(err as Error).message}`);
  process.exit(1);
});

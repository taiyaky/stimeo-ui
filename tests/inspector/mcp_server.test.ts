import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import type { ExamplesIndex } from "../../src/inspector/examples";
import {
  EXAMPLE_RESOURCE_PREFIX,
  JSONRPC_INVALID_PARAMS,
  JSONRPC_INVALID_REQUEST,
  JSONRPC_METHOD_NOT_FOUND,
  JSONRPC_PARSE_ERROR,
  JSONRPC_RESOURCE_NOT_FOUND,
  JSONRPC_SERVER_NOT_INITIALIZED,
  LATEST_PROTOCOL_VERSION,
  MANIFEST_RESOURCE_URI,
  McpSession,
  runMcpServer,
} from "../../src/inspector/mcp/server";
import type { ToolContext } from "../../src/inspector/mcp/tools";
import type { Manifest } from "../../src/inspector/types";

/** A minimal manifest so protocol tests never need the post-build bundle. */
const fakeManifest: Manifest = {
  schemaVersion: 5,
  packageVersion: "9.9.9",
  controllers: {
    "stimeo--demo": {
      targets: ["panel"],
      values: ["open"],
      valueConstraints: [],
      valueRelations: [],
      actions: ["toggle"],
      events: ["changed"],
      requiredTargets: ["panel"],
      conditionalTargets: [],
      requiredActions: [],
      actionCompletion: [],
      a11y: [],
      keyboard: [],
      hosts: [],
      managedAria: [],
      compositions: [],
      companions: [],
      targetDeclarations: [],
      cardinality: [],
      forbiddenAria: [],
    },
  },
};

/** A check-clean example paired with {@link fakeManifest}. */
const fakeExamples: ExamplesIndex = {
  schemaVersion: 1,
  examples: {
    "stimeo--demo": {
      file: "app/views/components/demos/demo/_demo.html.erb",
      source: '<div data-controller="stimeo--demo"><p data-stimeo--demo-target="panel"></p></div>',
    },
  },
};

const fakeContext: ToolContext = { manifest: fakeManifest, examples: fakeExamples };

/** Sends one request and returns the parsed response (null for notifications). */
function roundTrip(
  session: McpSession,
  method: string,
  params?: unknown,
  id: string | number = 1,
): Record<string, unknown> | null {
  const message: Record<string, unknown> = { jsonrpc: "2.0", id, method };
  if (params !== undefined) message.params = params;
  const response = session.handleLine(JSON.stringify(message));
  return response === null ? null : (JSON.parse(response) as Record<string, unknown>);
}

/** A session that has completed the initialize handshake. */
function initializedSession(): McpSession {
  const session = new McpSession(fakeContext);
  roundTrip(session, "initialize", {
    protocolVersion: LATEST_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "test", version: "0.0.0" },
  });
  session.handleLine(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
  return session;
}

/**
 * Tests for the JSON-RPC / MCP protocol layer: initialization handshake,
 * version negotiation, tools/list and tools/call framing, and the error paths
 * (parse, invalid request, unknown method, not initialized). Tool semantics
 * are covered by `mcp_tools.test.ts`.
 */
describe("McpSession", () => {
  it("answers initialize with capabilities, serverInfo, and the echoed version", () => {
    const session = new McpSession(fakeContext);
    const response = roundTrip(session, "initialize", { protocolVersion: "2025-03-26" });
    const result = response?.result as Record<string, unknown>;
    expect(result.protocolVersion).toBe("2025-03-26");
    expect(result.capabilities).toEqual({
      tools: { listChanged: false },
      resources: { subscribe: false, listChanged: false },
      prompts: { listChanged: false },
    });
    expect(result.serverInfo).toMatchObject({ name: "stimeo-ui", version: "9.9.9" });
  });

  it("keeps the server instructions searchable and inside the host truncation limit", () => {
    // This is the discovery layer the tool descriptions cannot reach: per the
    // MCP schema `instructions` is a hint a client MAY put in front of the
    // model, and clients that defer tool definitions still tend to load it
    // with the tool names — so it can be read before any tool is. Both
    // assertions follow from clients truncating it: the trigger vocabulary has
    // to survive, and it has to survive near the start. 2KB is the tightest
    // client limit known; the margin below it is slack.
    const session = new McpSession(fakeContext);
    const response = roundTrip(session, "initialize", { protocolVersion: "2025-03-26" });
    const result = response?.result as Record<string, unknown>;
    const instructions = result.instructions as string;
    expect(Buffer.byteLength(instructions)).toBeLessThan(2048);
    const opening = instructions.slice(0, 400).toLowerCase();
    for (const keyword of ["search", "rails", "accessible", "component"]) {
      expect(opening, `server instructions lost "${keyword}" from the opening`).toContain(keyword);
    }
  });

  it("falls back to the latest protocol version for unsupported requests", () => {
    const session = new McpSession(fakeContext);
    const response = roundTrip(session, "initialize", { protocolVersion: "1999-01-01" });
    const result = response?.result as Record<string, unknown>;
    expect(result.protocolVersion).toBe(LATEST_PROTOCOL_VERSION);
  });

  it("does not respond to notifications", () => {
    const session = initializedSession();
    const line = JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled" });
    expect(session.handleLine(line)).toBeNull();
  });

  it("ignores blank lines", () => {
    expect(new McpSession(fakeContext).handleLine("   ")).toBeNull();
  });

  it("answers ping before and after initialization", () => {
    const fresh = new McpSession(fakeContext);
    expect(roundTrip(fresh, "ping")?.result).toEqual({});
    expect(roundTrip(initializedSession(), "ping")?.result).toEqual({});
  });

  it("rejects requests sent before initialize", () => {
    const session = new McpSession(fakeContext);
    const response = roundTrip(session, "tools/list");
    const error = response?.error as Record<string, unknown>;
    expect(error.code).toBe(JSONRPC_SERVER_NOT_INITIALIZED);
  });

  it("lists the four read-only tools with input schemas", () => {
    const response = roundTrip(initializedSession(), "tools/list");
    const result = response?.result as { tools: { name: string; inputSchema: unknown }[] };
    expect(result.tools.map((t) => t.name)).toEqual([
      "stimeo_check",
      "stimeo_catalog",
      "stimeo_controller",
      "stimeo_example",
    ]);
    for (const tool of result.tools) {
      expect(tool.inputSchema).toMatchObject({ type: "object" });
    }
  });

  it("round-trips a stimeo_check call as text plus structured content", () => {
    const response = roundTrip(
      initializedSession(),
      "tools/call",
      {
        name: "stimeo_check",
        arguments: {
          source:
            '<div data-controller="stimeo--demo"><p data-stimeo--demo-target="panel"></p></div>',
        },
      },
      "check-1",
    );
    expect(response?.id).toBe("check-1");
    const result = response?.result as {
      content: { type: string; text: string }[];
      structuredContent: { ok: boolean };
      isError?: boolean;
    };
    expect(result.structuredContent.ok).toBe(true);
    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.type).toBe("text");
    expect(JSON.parse(result.content[0]?.text ?? "")).toMatchObject({ ok: true });
  });

  it("returns tool execution failures as isError results, not protocol errors", () => {
    const response = roundTrip(initializedSession(), "tools/call", {
      name: "stimeo_controller",
      arguments: { id: "stimeo--nope" },
    });
    const result = response?.result as { content: { text: string }[]; isError: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('Unknown controller "stimeo--nope"');
  });

  it("maps invalid tool arguments to a JSON-RPC invalid-params error", () => {
    const session = initializedSession();
    const missingSource = roundTrip(session, "tools/call", {
      name: "stimeo_check",
      arguments: {},
    });
    const missingSourceError = missingSource?.error as Record<string, unknown>;
    expect(missingSourceError.code).toBe(JSONRPC_INVALID_PARAMS);
    const unknownTool = roundTrip(session, "tools/call", { name: "stimeo_write" });
    const unknownToolError = unknownTool?.error as Record<string, unknown>;
    expect(unknownToolError.code).toBe(JSONRPC_INVALID_PARAMS);
    const missingName = roundTrip(session, "tools/call", {});
    const missingNameError = missingName?.error as Record<string, unknown>;
    expect(missingNameError.code).toBe(JSONRPC_INVALID_PARAMS);
  });

  it("rejects unknown methods", () => {
    const response = roundTrip(initializedSession(), "completion/complete");
    const error = response?.error as Record<string, unknown>;
    expect(error.code).toBe(JSONRPC_METHOD_NOT_FOUND);
  });

  it("lists the workflow prompts and rejects prompts/list before initialize", () => {
    const listed = roundTrip(initializedSession(), "prompts/list");
    const result = listed?.result as { prompts: { name: string }[] };
    expect(result.prompts.map((p) => p.name)).toEqual(["stimeo_build_ui", "stimeo_fix_markup"]);
    const early = roundTrip(new McpSession(fakeContext), "prompts/list");
    const earlyError = early?.error as Record<string, unknown>;
    expect(earlyError.code).toBe(JSONRPC_SERVER_NOT_INITIALIZED);
  });

  it("round-trips prompts/get with interpolated arguments", () => {
    const response = roundTrip(initializedSession(), "prompts/get", {
      name: "stimeo_build_ui",
      arguments: { request: "a dropdown menu", controller: "stimeo--demo" },
    });
    const result = response?.result as {
      description: string;
      messages: { role: string; content: { type: string; text: string } }[];
    };
    expect(result.messages[0]?.role).toBe("user");
    expect(result.messages[0]?.content.text).toContain("Task: a dropdown menu");
    expect(result.messages[0]?.content.text).toContain('"stimeo--demo"');
  });

  it("maps unknown prompts and bad prompt arguments to invalid-params errors", () => {
    const session = initializedSession();
    const unknown = roundTrip(session, "prompts/get", { name: "stimeo_nope" });
    const unknownError = unknown?.error as Record<string, unknown>;
    expect(unknownError.code).toBe(JSONRPC_INVALID_PARAMS);
    const missingArg = roundTrip(session, "prompts/get", { name: "stimeo_build_ui" });
    const missingArgError = missingArg?.error as Record<string, unknown>;
    expect(missingArgError.code).toBe(JSONRPC_INVALID_PARAMS);
    const missingName = roundTrip(session, "prompts/get", {});
    const missingNameError = missingName?.error as Record<string, unknown>;
    expect(missingNameError.code).toBe(JSONRPC_INVALID_PARAMS);
  });

  it("round-trips a stimeo_example call with guidance attached", () => {
    const response = roundTrip(initializedSession(), "tools/call", {
      name: "stimeo_example",
      arguments: { id: "stimeo--demo" },
    });
    const result = response?.result as {
      structuredContent: { id: string; source: string; guidance: string };
      isError?: boolean;
    };
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent.id).toBe("stimeo--demo");
    expect(result.structuredContent.source).toContain('data-controller="stimeo--demo"');
    expect(result.structuredContent.guidance).toContain("demo styling placeholders");
  });

  it("lists the manifest and one example resource per controller", () => {
    const response = roundTrip(initializedSession(), "resources/list");
    const result = response?.result as {
      resources: { uri: string; name: string; mimeType: string }[];
    };
    expect(result.resources.map((r) => r.uri)).toEqual([
      MANIFEST_RESOURCE_URI,
      `${EXAMPLE_RESOURCE_PREFIX}stimeo--demo`,
    ]);
    expect(result.resources[0]?.mimeType).toBe("application/json");
    expect(result.resources[1]?.mimeType).toBe("text/x-erb");
  });

  it("rejects resources/list before initialize", () => {
    const response = roundTrip(new McpSession(fakeContext), "resources/list");
    const error = response?.error as Record<string, unknown>;
    expect(error.code).toBe(JSONRPC_SERVER_NOT_INITIALIZED);
  });

  it("reads the manifest resource as pretty-printed JSON", () => {
    const response = roundTrip(initializedSession(), "resources/read", {
      uri: MANIFEST_RESOURCE_URI,
    });
    const result = response?.result as {
      contents: { uri: string; mimeType: string; text: string }[];
    };
    expect(result.contents).toHaveLength(1);
    expect(result.contents[0]?.uri).toBe(MANIFEST_RESOURCE_URI);
    const parsed = JSON.parse(result.contents[0]?.text ?? "") as Manifest;
    expect(Object.keys(parsed.controllers)).toEqual(["stimeo--demo"]);
  });

  it("reads an example resource as its raw ERB source", () => {
    const uri = `${EXAMPLE_RESOURCE_PREFIX}stimeo--demo`;
    const response = roundTrip(initializedSession(), "resources/read", { uri });
    const result = response?.result as {
      contents: { uri: string; mimeType: string; text: string }[];
    };
    expect(result.contents[0]?.mimeType).toBe("text/x-erb");
    expect(result.contents[0]?.text).toBe(fakeExamples.examples["stimeo--demo"]?.source);
  });

  it("answers resources/read of unknown or prototype-key URIs with resource-not-found", () => {
    const session = initializedSession();
    for (const suffix of ["stimeo--nope", "constructor", "__proto__"]) {
      const response = roundTrip(session, "resources/read", {
        uri: `${EXAMPLE_RESOURCE_PREFIX}${suffix}`,
      });
      const error = response?.error as Record<string, unknown>;
      expect(error.code).toBe(JSONRPC_RESOURCE_NOT_FOUND);
      expect(error.message).toContain("Resource not found");
    }
  });

  it("rejects resources/read without a string uri as invalid params", () => {
    const response = roundTrip(initializedSession(), "resources/read", {});
    const error = response?.error as Record<string, unknown>;
    expect(error.code).toBe(JSONRPC_INVALID_PARAMS);
  });

  it("rejects unparsable lines with a parse error addressed to id null", () => {
    const response = new McpSession(fakeContext).handleLine("not json");
    const parsed = JSON.parse(response ?? "") as Record<string, unknown>;
    expect(parsed.id).toBeNull();
    expect((parsed.error as Record<string, unknown>).code).toBe(JSONRPC_PARSE_ERROR);
  });

  it("rejects non-request payloads (including JSON-RPC batches)", () => {
    const session = new McpSession(fakeContext);
    for (const line of ['[{"jsonrpc":"2.0","id":1,"method":"ping"}]', '{"method":"ping","id":1}']) {
      const response = JSON.parse(session.handleLine(line) ?? "") as Record<string, unknown>;
      expect((response.error as Record<string, unknown>).code).toBe(JSONRPC_INVALID_REQUEST);
    }
  });

  it("rejects requests whose id is not a string or number (null included)", () => {
    const session = new McpSession(fakeContext);
    // MCP tightens JSON-RPC 2.0: a request id MUST NOT be null.
    for (const id of [{ nested: true }, null]) {
      const line = JSON.stringify({ jsonrpc: "2.0", id, method: "ping" });
      const response = JSON.parse(session.handleLine(line) ?? "") as Record<string, unknown>;
      expect((response.error as Record<string, unknown>).code).toBe(JSONRPC_INVALID_REQUEST);
    }
  });
});

describe("runMcpServer", () => {
  it("rejects (instead of throwing synchronously) when the manifest cannot load", async () => {
    const input = new PassThrough();
    const failing = runMcpServer({
      input,
      write: () => {},
      load: () => {
        throw new Error("manifest.json is missing");
      },
    });
    await expect(failing).rejects.toThrow("manifest.json is missing");
    input.end();
  });

  it("keeps serving after a parse error and after a write failure", async () => {
    const input = new PassThrough();
    const lines: string[] = [];
    const errors: string[] = [];
    let failNextWrite = true;
    const done = runMcpServer({
      input,
      write: (line) => {
        if (failNextWrite) {
          failNextWrite = false;
          throw new Error("pipe gone");
        }
        lines.push(line);
      },
      load: () => fakeContext,
      logError: (message) => errors.push(message),
    });
    // First response hits the failing write; the loop must survive it.
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`);
    input.write("not json\n");
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" })}\n`);
    input.end();
    await done;
    expect(errors).toEqual(["pipe gone"]);
    expect(lines).toHaveLength(2);
    const parseError = JSON.parse(lines[0] ?? "") as Record<string, unknown>;
    expect((parseError.error as Record<string, unknown>).code).toBe(JSONRPC_PARSE_ERROR);
    const ping = JSON.parse(lines[1] ?? "") as { id: number; result: unknown };
    expect(ping.id).toBe(2);
    expect(ping.result).toEqual({});
  });

  it("serves newline-delimited JSON-RPC over a stream until it closes", async () => {
    const input = new PassThrough();
    const lines: string[] = [];
    const done = runMcpServer({
      input,
      write: (line) => lines.push(line),
      load: () => fakeContext,
    });
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`);
    input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
    input.end();
    await done;
    expect(lines).toHaveLength(2);
    const initialize = JSON.parse(lines[0] ?? "") as { id: number; result: unknown };
    const list = JSON.parse(lines[1] ?? "") as { id: number; result: { tools: unknown[] } };
    expect(initialize.id).toBe(1);
    expect(list.id).toBe(2);
    expect(list.result.tools).toHaveLength(4);
  });
});

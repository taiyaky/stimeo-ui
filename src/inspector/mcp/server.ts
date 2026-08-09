import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import { getPrompt, InvalidPromptRequestError, PROMPT_DESCRIPTORS } from "./prompts";
import type { ToolContext } from "./tools";
import {
  callTool,
  getOwn,
  InvalidToolArgsError,
  TOOL_DESCRIPTORS,
  ToolExecutionError,
} from "./tools";

/**
 * `stimeo mcp` — a zero-dependency Model Context Protocol server over stdio.
 *
 * Implements the JSON-RPC 2.0 subset an MCP client needs to use the Inspector
 * as read-only tools, resources, and prompts: `initialize`, the
 * `notifications/initialized` notification, `ping`, `tools/list`,
 * `tools/call`, `resources/list`, `resources/read`, `prompts/list`, and
 * `prompts/get` (newline-delimited messages, one per line). It is hand-written
 * to keep the shipped server dependency-free; this bounded subset is small
 * enough to implement and review directly.
 *
 * stdout carries protocol messages only; anything diagnostic must go to the
 * caller-provided error log (stderr in production).
 */

/** Latest MCP protocol revision this server implements. */
export const LATEST_PROTOCOL_VERSION = "2025-06-18";

/**
 * Revisions this server can speak. The tools-only subset is identical across
 * these revisions, so we echo whichever supported version the client asks for
 * and otherwise answer with the latest (per the MCP version-negotiation rule).
 */
export const SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = [
  LATEST_PROTOCOL_VERSION,
  "2025-03-26",
  "2024-11-05",
];

/** JSON-RPC 2.0 error codes used by this server. */
export const JSONRPC_PARSE_ERROR = -32700;
export const JSONRPC_INVALID_REQUEST = -32600;
export const JSONRPC_METHOD_NOT_FOUND = -32601;
export const JSONRPC_INVALID_PARAMS = -32602;
export const JSONRPC_INTERNAL_ERROR = -32603;
/**
 * MCP server-defined code (-32002). The MCP specification assigns it both to requests sent
 * before `initialize` and to `resources/read` of an unknown URI; the two named
 * constants keep call sites self-documenting.
 */
export const JSONRPC_SERVER_NOT_INITIALIZED = -32002;
/** See {@link JSONRPC_SERVER_NOT_INITIALIZED} — same spec-assigned code. */
export const JSONRPC_RESOURCE_NOT_FOUND = -32002;

/** URI of the full-manifest resource. */
export const MANIFEST_RESOURCE_URI = "stimeo://manifest";
/** URI prefix of the per-controller example resources. */
export const EXAMPLE_RESOURCE_PREFIX = "stimeo://examples/";

/**
 * Request id this server accepts. MCP tightens bare JSON-RPC 2.0 here: a
 * request id MUST NOT be null, so `id: null` requests are rejected as invalid
 * rather than answered.
 */
type JsonRpcId = string | number;

/**
 * Id an error response may carry: null only for messages whose id could not
 * be established (unparsable lines, malformed requests), per JSON-RPC 2.0.
 */
type JsonRpcErrorId = JsonRpcId | null;

interface JsonRpcSuccess {
  readonly jsonrpc: "2.0";
  readonly id: JsonRpcId;
  readonly result: unknown;
}

interface JsonRpcError {
  readonly jsonrpc: "2.0";
  readonly id: JsonRpcErrorId;
  readonly error: { readonly code: number; readonly message: string };
}

/** Builds a serialized JSON-RPC success response. */
function success(id: JsonRpcId, result: unknown): string {
  const response: JsonRpcSuccess = { jsonrpc: "2.0", id, result };
  return JSON.stringify(response);
}

/** Builds a serialized JSON-RPC error response. */
function failure(id: JsonRpcErrorId, code: number, message: string): string {
  const response: JsonRpcError = { jsonrpc: "2.0", id, error: { code, message } };
  return JSON.stringify(response);
}

/** Narrows an unknown parsed message to a record. */
function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/**
 * One MCP session: a tiny state machine over parsed JSON-RPC messages.
 * Transport-free so tests can drive it line by line; {@link runMcpServer}
 * wires it to a readable stream.
 */
export class McpSession {
  #context: ToolContext;
  #initialized = false;

  constructor(context: ToolContext) {
    this.#context = context;
  }

  /**
   * Handles one newline-delimited message.
   *
   * @returns The serialized response line, or null when no response is due
   *   (blank lines and notifications).
   */
  handleLine(line: string): string | null {
    const trimmed = line.trim();
    if (trimmed === "") return null;
    let message: unknown;
    try {
      message = JSON.parse(trimmed);
    } catch {
      return failure(null, JSONRPC_PARSE_ERROR, "Parse error");
    }
    return this.#handleMessage(message);
  }

  #handleMessage(message: unknown): string | null {
    const record = asRecord(message);
    // JSON-RPC batches were removed in MCP 2025-06-18; reject them explicitly.
    if (record === null || record.jsonrpc !== "2.0" || typeof record.method !== "string") {
      return failure(null, JSONRPC_INVALID_REQUEST, "Invalid request");
    }
    const method = record.method;
    const hasId = "id" in record;
    const id = record.id;
    if (!hasId) {
      // Notifications (initialized, cancelled, …) never get a response.
      return null;
    }
    if (typeof id !== "string" && typeof id !== "number") {
      // Covers `id: null` too: the MCP base protocol forbids null request
      // ids (unlike bare JSON-RPC 2.0), so it is rejected, not echoed.
      return failure(null, JSONRPC_INVALID_REQUEST, "Invalid request id");
    }
    return this.#handleRequest(id, method, record.params);
  }

  #handleRequest(id: JsonRpcId, method: string, params: unknown): string {
    if (method === "initialize") return this.#initialize(id, params);
    if (method === "ping") return success(id, {});
    if (!this.#initialized) {
      return failure(
        id,
        JSONRPC_SERVER_NOT_INITIALIZED,
        "Server not initialized. Send an initialize request first.",
      );
    }
    if (method === "tools/list") return success(id, { tools: TOOL_DESCRIPTORS });
    if (method === "tools/call") return this.#callTool(id, params);
    if (method === "resources/list") return success(id, { resources: this.#listResources() });
    if (method === "resources/read") return this.#readResource(id, params);
    if (method === "prompts/list") return success(id, { prompts: PROMPT_DESCRIPTORS });
    if (method === "prompts/get") return this.#getPrompt(id, params);
    return failure(id, JSONRPC_METHOD_NOT_FOUND, `Method not found: "${method}"`);
  }

  #initialize(id: JsonRpcId, params: unknown): string {
    const record = asRecord(params) ?? {};
    const requested = typeof record.protocolVersion === "string" ? record.protocolVersion : "";
    const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
      ? requested
      : LATEST_PROTOCOL_VERSION;
    this.#initialized = true;
    return success(id, {
      protocolVersion,
      capabilities: {
        tools: { listChanged: false },
        resources: { subscribe: false, listChanged: false },
        prompts: { listChanged: false },
      },
      serverInfo: {
        name: "stimeo-ui",
        title: "Stimeo UI Inspector",
        version: this.#context.manifest.packageVersion,
      },
      // The server's own account of itself. Per the MCP schema this is a hint
      // a client MAY put in front of the model, which makes it the earliest
      // point this server can be routed to — clients that defer tool
      // definitions still tend to load it alongside the tool names. Hence the
      // trigger condition first, in the words a request would use, and a
      // length that survives truncation.
      instructions:
        "Search for these tools whenever a task involves building, editing, or reviewing " +
        "an accessible UI component in a Rails view — dialog/modal, drawer, dropdown menu, " +
        "tabs, accordion, combobox, toast, and the rest of the catalog — or whenever " +
        "HTML/ERB carrying stimeo--* attributes is in play. " +
        "Stimeo UI is a headless Stimulus UI framework for Rails. Use stimeo_catalog to " +
        "discover controllers, stimeo_controller for one controller's usage and " +
        "accessibility contract, stimeo_example for verified reference markup, and " +
        "stimeo_check to validate generated HTML/ERB before presenting it. The full " +
        "manifest and every example are also exposed as resources (stimeo:// URIs), and " +
        "the stimeo_build_ui / stimeo_fix_markup prompts bake this workflow into " +
        "user-invokable templates.",
    });
  }

  #getPrompt(id: JsonRpcId, params: unknown): string {
    const record = asRecord(params);
    const name = record?.name;
    if (typeof name !== "string") {
      return failure(id, JSONRPC_INVALID_PARAMS, 'prompts/get requires a string "name" param.');
    }
    try {
      return success(id, getPrompt(name, record?.arguments));
    } catch (error) {
      if (error instanceof InvalidPromptRequestError) {
        // Unknown prompt names and bad arguments are protocol errors per the
        // MCP prompts spec (unlike tool execution failures).
        return failure(id, JSONRPC_INVALID_PARAMS, error.message);
      }
      const message = error instanceof Error ? error.message : String(error);
      return failure(id, JSONRPC_INTERNAL_ERROR, `Internal error: ${message}`);
    }
  }

  /** Static resource listing: the manifest plus one example per controller. */
  #listResources(): readonly Record<string, unknown>[] {
    const resources: Record<string, unknown>[] = [
      {
        uri: MANIFEST_RESOURCE_URI,
        name: "manifest",
        title: "Stimeo UI controller manifest",
        description:
          "The full reflected manifest: every controller's targets, values, actions, " +
          "events, required targets, and accessibility contract.",
        mimeType: "application/json",
      },
    ];
    for (const id of Object.keys(this.#context.examples.examples).sort()) {
      resources.push({
        uri: `${EXAMPLE_RESOURCE_PREFIX}${id}`,
        name: id,
        title: `Example markup — ${id}`,
        description: `Verified catalog demo markup for ${id} (passes stimeo_check).`,
        mimeType: "text/x-erb",
      });
    }
    return resources;
  }

  #readResource(id: JsonRpcId, params: unknown): string {
    const record = asRecord(params);
    const uri = record?.uri;
    if (typeof uri !== "string") {
      return failure(id, JSONRPC_INVALID_PARAMS, 'resources/read requires a string "uri" param.');
    }
    if (uri === MANIFEST_RESOURCE_URI) {
      return success(id, {
        contents: [
          {
            uri,
            mimeType: "application/json",
            text: JSON.stringify(this.#context.manifest, null, 2),
          },
        ],
      });
    }
    if (uri.startsWith(EXAMPLE_RESOURCE_PREFIX)) {
      const exampleId = uri.slice(EXAMPLE_RESOURCE_PREFIX.length);
      const entry = getOwn(this.#context.examples.examples, exampleId);
      if (entry) {
        return success(id, {
          contents: [{ uri, mimeType: "text/x-erb", text: entry.source }],
        });
      }
    }
    return failure(id, JSONRPC_RESOURCE_NOT_FOUND, `Resource not found: "${uri}"`);
  }

  #callTool(id: JsonRpcId, params: unknown): string {
    const record = asRecord(params);
    const name = record?.name;
    if (typeof name !== "string") {
      return failure(id, JSONRPC_INVALID_PARAMS, 'tools/call requires a string "name" param.');
    }
    try {
      const result = callTool(this.#context, name, record?.arguments);
      return success(id, {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
      });
    } catch (error) {
      if (error instanceof InvalidToolArgsError) {
        return failure(id, JSONRPC_INVALID_PARAMS, error.message);
      }
      if (error instanceof ToolExecutionError) {
        // Tool execution errors flow back as results so the model can read
        // the message and self-correct (MCP tools spec).
        return success(id, {
          content: [{ type: "text", text: error.message }],
          isError: true,
        });
      }
      const message = error instanceof Error ? error.message : String(error);
      return failure(id, JSONRPC_INTERNAL_ERROR, `Internal error: ${message}`);
    }
  }
}

/** I/O seams for {@link runMcpServer}; injectable for tests. */
export interface McpServerIo {
  /** Stream carrying newline-delimited JSON-RPC messages (stdin in production). */
  readonly input: Readable;
  /** Sink for one serialized response line (stdout in production). */
  readonly write: (line: string) => void;
  /**
   * Tool-context loader (the bundled `dist/inspector/manifest.json` and
   * `examples.json` in production).
   */
  readonly load: () => ToolContext;
  /** Diagnostic sink; must never be stdout (protocol-only). */
  readonly logError?: (message: string) => void;
}

/**
 * Runs the stdio server loop: one JSON-RPC message per input line, one
 * response per output line. Resolves when the input stream closes (the MCP
 * client disconnecting), which is the server's shutdown signal. Declared
 * async so a failing manifest load rejects the returned promise instead of
 * throwing synchronously past the caller's rejection handler.
 */
export async function runMcpServer(io: McpServerIo): Promise<void> {
  const session = new McpSession(io.load());
  const lines = createInterface({ input: io.input, crlfDelay: Number.POSITIVE_INFINITY });
  return new Promise((resolve) => {
    lines.on("line", (line) => {
      try {
        const response = session.handleLine(line);
        if (response !== null) io.write(response);
      } catch (error) {
        // The session already converts per-request failures into JSON-RPC
        // errors; this guards the loop itself so one bad line cannot kill
        // the server.
        io.logError?.(error instanceof Error ? error.message : String(error));
      }
    });
    lines.on("close", resolve);
  });
}

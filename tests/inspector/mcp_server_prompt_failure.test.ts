import { afterEach, describe, expect, it, vi } from "vitest";
import type * as Prompts from "../../src/inspector/mcp/prompts";
import type { ToolContext } from "../../src/inspector/mcp/tools";

/** What the prompt builder throws in place of building, when set. */
const fault = vi.hoisted(() => ({ thrown: undefined as unknown, armed: false }));

vi.mock("../../src/inspector/mcp/prompts", async (importOriginal) => {
  const actual = await importOriginal<typeof Prompts>();
  return {
    ...actual,
    getPrompt: (name: string, args: unknown) => {
      if (fault.armed) throw fault.thrown;
      return actual.getPrompt(name, args);
    },
  };
});

// Imported after the mock so the session's prompt dispatch binds the mock.
const { JSONRPC_INTERNAL_ERROR, LATEST_PROTOCOL_VERSION, McpSession } = await import(
  "../../src/inspector/mcp/server"
);

/** An empty catalog: `prompts/get` reads nothing from the context. */
const context: ToolContext = {
  manifest: { schemaVersion: 5, packageVersion: "9.9.9", controllers: {} },
  examples: { schemaVersion: 1, examples: {} },
};

/** Sends one `prompts/get` for a real prompt and returns the parsed response. */
function getPrompt(session: InstanceType<typeof McpSession>): Record<string, unknown> {
  const line = JSON.stringify({
    jsonrpc: "2.0",
    id: 7,
    method: "prompts/get",
    params: { name: "stimeo_build_ui", arguments: { request: "a menu" } },
  });
  return JSON.parse(session.handleLine(line) ?? "") as Record<string, unknown>;
}

/**
 * `prompts/get` when building the prompt fails for a reason other than a bad
 * request. The builders only reject bad requests, so the failure is injected:
 * the session must answer it as a JSON-RPC internal error naming the failure,
 * and keep serving.
 */
describe("McpSession prompts/get internal failure", () => {
  afterEach(() => {
    fault.armed = false;
    fault.thrown = undefined;
  });

  it("answers with an internal error carrying the failure's message", () => {
    const session = new McpSession(context);
    session.handleLine(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: LATEST_PROTOCOL_VERSION },
      }),
    );
    for (const thrown of [new TypeError("template unavailable"), "template unavailable"]) {
      fault.armed = true;
      fault.thrown = thrown;
      expect(getPrompt(session)).toEqual({
        jsonrpc: "2.0",
        id: 7,
        error: { code: JSONRPC_INTERNAL_ERROR, message: "Internal error: template unavailable" },
      });
    }
    fault.armed = false;
    expect(getPrompt(session).result).toMatchObject({ messages: [{ role: "user" }] });
  });
});

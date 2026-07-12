/**
 * Post-build smoke gate for the `stimeo mcp` stdio server (see the
 * `ci-quality-gates` skill and `docs/specs/common/inspector.md` §9).
 *
 * Unit tests drive `McpSession` and the pure tool handlers in-process; this
 * script covers the layer they cannot reach — the **built bin**
 * (`dist/inspector/cli_bin.js`): the `mcp` argv dispatch, loading the bundled
 * manifest from `dist/`, stdout line framing, and a clean exit when the client
 * closes stdin. It runs one real MCP session end to end (initialize →
 * initialized → tools/list → tools/call → unknown method → resources/list →
 * resources/read → stimeo_example → prompts/list → prompts/get) plus the
 * `mcp --help` escape hatch, and fails CI on any deviation.
 *
 * The script is dependency-free (Bun + `node:` APIs), like `audit.ts`.
 *
 * Usage: `bun scripts/mcp_smoke.ts`  (requires a prior `bun run build`;
 * exit code 1 on any failure).
 */

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const BIN = join(SCRIPT_DIR, "..", "dist", "inspector", "cli_bin.js");

/** Hard cap so a hung server fails CI instead of stalling the job. */
const TIMEOUT_MS = 30_000;

interface RunResult {
  readonly exitCode: number;
  readonly stdout: string;
}

/** Aborts the smoke run with a diagnostic. */
function fail(message: string): never {
  console.error(`✖ mcp smoke: ${message}`);
  process.exit(1);
}

/**
 * Spawns the built bin, writes the given stdin lines, closes stdin, and
 * resolves with the exit code and captured stdout (stderr passes through).
 */
function runBin(args: readonly string[], stdinLines: readonly string[]): Promise<RunResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    // Spawn `node` explicitly: this script runs under Bun (`bun run smoke:mcp`),
    // where process.execPath is the bun binary — which would silently test the
    // wrong runtime. The bin ships with a Node shebang; smoke it on Node.
    const child = spawn("node", [BIN, ...args], {
      stdio: ["pipe", "pipe", "inherit"],
    });
    let stdout = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectPromise(new Error(`timed out after ${TIMEOUT_MS}ms (server never exited)`));
    }, TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ exitCode: code ?? 1, stdout });
    });
    for (const line of stdinLines) child.stdin.write(`${line}\n`);
    child.stdin.end();
  });
}

/** Parses one response line, failing loudly on non-JSON output. */
function parseLine(line: string, label: string): Record<string, unknown> {
  try {
    return JSON.parse(line) as Record<string, unknown>;
  } catch {
    return fail(`${label}: stdout line is not JSON: ${line}`);
  }
}

/** Asserts a condition with a labeled message. */
function expect(condition: boolean, message: string): void {
  if (!condition) fail(message);
}

const session = await runBin(
  ["mcp"],
  [
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "mcp-smoke", version: "0" },
      },
    }),
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "stimeo_check",
        // Missing required target + trigger a11y → the report must carry errors.
        arguments: { source: '<div data-controller="stimeo--menu"></div>' },
      },
    }),
    JSON.stringify({ jsonrpc: "2.0", id: 4, method: "completion/complete" }),
    JSON.stringify({ jsonrpc: "2.0", id: 5, method: "resources/list" }),
    JSON.stringify({
      jsonrpc: "2.0",
      id: 6,
      method: "resources/read",
      params: { uri: "stimeo://manifest" },
    }),
    JSON.stringify({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "stimeo_example", arguments: { id: "stimeo--menu" } },
    }),
    JSON.stringify({ jsonrpc: "2.0", id: 8, method: "prompts/list" }),
    JSON.stringify({
      jsonrpc: "2.0",
      id: 9,
      method: "prompts/get",
      params: { name: "stimeo_build_ui", arguments: { request: "a dropdown menu" } },
    }),
  ],
);

expect(session.exitCode === 0, `mcp session: expected exit 0, got ${session.exitCode}`);
const lines = session.stdout.split("\n").filter((line) => line !== "");
expect(lines.length === 9, `mcp session: expected 9 response lines, got ${lines.length}`);

const initialize = parseLine(lines[0] ?? "", "initialize");
const initResult = initialize.result as {
  protocolVersion?: string;
  serverInfo?: { name?: string };
};
expect(initialize.id === 1, "initialize: response id must echo 1");
expect(
  initResult?.protocolVersion === "2025-06-18",
  `initialize: expected protocolVersion 2025-06-18, got ${String(initResult?.protocolVersion)}`,
);
expect(
  initResult?.serverInfo?.name === "stimeo-ui",
  "initialize: serverInfo.name must be stimeo-ui",
);

const list = parseLine(lines[1] ?? "", "tools/list");
const tools = (list.result as { tools?: { name?: string }[] })?.tools ?? [];
const names = tools.map((tool) => tool.name);
expect(
  JSON.stringify(names) ===
    JSON.stringify(["stimeo_check", "stimeo_catalog", "stimeo_controller", "stimeo_example"]),
  `tools/list: unexpected tool names ${JSON.stringify(names)}`,
);

const check = parseLine(lines[2] ?? "", "tools/call stimeo_check");
const checkResult = check.result as {
  isError?: boolean;
  structuredContent?: { ok?: boolean; errorCount?: number };
  content?: { type?: string }[];
};
expect(checkResult?.isError === undefined, "stimeo_check: diagnostics must not set isError");
expect(
  checkResult?.structuredContent?.ok === false,
  "stimeo_check: bad markup must report ok=false",
);
expect(
  (checkResult?.structuredContent?.errorCount ?? 0) > 0,
  "stimeo_check: bad markup must report errors",
);
expect(
  checkResult?.content?.[0]?.type === "text",
  "stimeo_check: first content block must be text",
);

const unknown = parseLine(lines[3] ?? "", "unknown method");
expect(
  (unknown.error as { code?: number })?.code === -32601,
  "unknown method: expected JSON-RPC -32601",
);

const resourceList = parseLine(lines[4] ?? "", "resources/list");
const resources = (resourceList.result as { resources?: { uri?: string }[] })?.resources ?? [];
expect(
  resources[0]?.uri === "stimeo://manifest",
  "resources/list: first resource must be stimeo://manifest",
);
expect(resources.length > 1, "resources/list: must list example resources alongside the manifest");

const manifestRead = parseLine(lines[5] ?? "", "resources/read manifest");
const manifestText =
  (manifestRead.result as { contents?: { text?: string }[] })?.contents?.[0]?.text ?? "";
expect(
  manifestText.includes('"controllers"'),
  "resources/read: manifest resource must contain the controllers map",
);

const example = parseLine(lines[6] ?? "", "tools/call stimeo_example");
const exampleResult = example.result as {
  isError?: boolean;
  structuredContent?: { source?: string; guidance?: string };
};
expect(exampleResult?.isError === undefined, "stimeo_example: known id must not error");
expect(
  (exampleResult?.structuredContent?.source ?? "").includes("stimeo--menu"),
  "stimeo_example: example source must reference its controller",
);
expect(
  (exampleResult?.structuredContent?.guidance ?? "").length > 0,
  "stimeo_example: guidance must be attached",
);

const promptList = parseLine(lines[7] ?? "", "prompts/list");
const prompts = (promptList.result as { prompts?: { name?: string }[] })?.prompts ?? [];
expect(
  JSON.stringify(prompts.map((p) => p.name)) ===
    JSON.stringify(["stimeo_build_ui", "stimeo_fix_markup"]),
  `prompts/list: unexpected prompt names ${JSON.stringify(prompts.map((p) => p.name))}`,
);

const promptGet = parseLine(lines[8] ?? "", "prompts/get");
const promptText =
  (promptGet.result as { messages?: { content?: { text?: string } }[] })?.messages?.[0]?.content
    ?.text ?? "";
expect(
  promptText.includes("Task: a dropdown menu") && promptText.includes("stimeo_check"),
  "prompts/get: message must interpolate the request and bake in the check step",
);

const help = await runBin(["mcp", "--help"], []);
expect(help.exitCode === 0, `mcp --help: expected exit 0, got ${help.exitCode}`);
expect(help.stdout.includes("stimeo mcp"), "mcp --help: usage must mention `stimeo mcp`");

console.log("✓ mcp smoke: built bin serves a full MCP session and exits cleanly.");

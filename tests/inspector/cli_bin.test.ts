import process from "node:process";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import type { McpServerIo } from "../../src/inspector/mcp/server";
import { tick } from "../helpers/timing";

const server = vi.hoisted(() => ({
  runMcpServer: vi.fn<(io: McpServerIo) => Promise<void>>(),
}));

vi.mock("../../src/inspector/mcp/server", () => ({ runMcpServer: server.runMcpServer }));

/**
 * Tests for the `stimeo` bin entry point: the exit code it settles on when the
 * stdout pipe fails, and how `stimeo mcp` reports a server that ends or fails.
 * The server is replaced so no test reads the real stdin; the entry point runs
 * on import, so each test imports a fresh copy under its own `process.argv`.
 */
describe("stimeo bin", () => {
  const argv = process.argv;
  const exitCode = process.exitCode;
  let exit: MockInstance<typeof process.exit>;
  let stdoutOn: MockInstance;
  let stderrWrite: MockInstance;

  /** Runs the entry point as `stimeo <args...>`. */
  async function runBin(...args: string[]): Promise<void> {
    process.argv = ["node", "stimeo", ...args];
    vi.resetModules();
    await import("../../src/inspector/cli_bin");
    await tick();
  }

  /** The listener the entry point registered for stdout errors. */
  function stdoutErrorListener(): (error: NodeJS.ErrnoException) => void {
    const call = stdoutOn.mock.calls.find(([event]) => event === "error");
    expect(call).toBeDefined();
    return call?.[1] as (error: NodeJS.ErrnoException) => void;
  }

  /** Everything the entry point wrote to stderr. */
  function stderr(): string {
    return stderrWrite.mock.calls.map(([chunk]) => String(chunk)).join("");
  }

  beforeEach(() => {
    server.runMcpServer.mockReset();
    exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    stdoutOn = vi.spyOn(process.stdout, "on");
    stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    for (const [event, listener] of stdoutOn.mock.calls) {
      if (event === "error") process.stdout.removeListener("error", listener);
    }
    vi.restoreAllMocks();
    process.argv = argv;
    process.exitCode = exitCode;
  });

  it("exits 0 when the reader closes stdout early (EPIPE)", async () => {
    server.runMcpServer.mockReturnValue(new Promise(() => {}));
    await runBin("mcp");
    stdoutErrorListener()(Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("exits 1 on any other stdout failure", async () => {
    server.runMcpServer.mockReturnValue(new Promise(() => {}));
    await runBin("mcp");
    stdoutErrorListener()(Object.assign(new Error("write EIO"), { code: "EIO" }));
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("mcp writes each server line to stdout followed by a newline", async () => {
    const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    server.runMcpServer.mockReturnValue(new Promise(() => {}));
    await runBin("mcp");
    server.runMcpServer.mock.calls[0]?.[0].write('{"jsonrpc":"2.0","id":1,"result":{}}');
    expect(stdoutWrite.mock.calls.map(([chunk]) => String(chunk))).toEqual([
      '{"jsonrpc":"2.0","id":1,"result":{}}\n',
    ]);
  });

  it("mcp logs a server error to stderr under its own prefix", async () => {
    server.runMcpServer.mockReturnValue(new Promise(() => {}));
    await runBin("mcp");
    const logError = server.runMcpServer.mock.calls[0]?.[0].logError;
    if (!logError) throw new Error("the bin handed the server no logError");
    logError("Parse error");
    expect(stderr()).toBe("stimeo mcp: Parse error\n");
  });

  it("mcp leaves exit code 0 once the server ends", async () => {
    server.runMcpServer.mockResolvedValue(undefined);
    await runBin("mcp");
    expect(process.exitCode).toBe(0);
    expect(stderr()).toBe("");
  });

  it("mcp reports a server that fails to start by its message and exits 1", async () => {
    server.runMcpServer.mockRejectedValue(new Error("manifest.json is missing"));
    await runBin("mcp");
    expect(stderr()).toBe("stimeo mcp: manifest.json is missing\n");
    expect(process.exitCode).toBe(1);
  });

  it("mcp reports a rejection that is not an Error by its string form", async () => {
    server.runMcpServer.mockRejectedValue("stdin closed abnormally");
    await runBin("mcp");
    expect(stderr()).toBe("stimeo mcp: stdin closed abnormally\n");
    expect(process.exitCode).toBe(1);
  });
});

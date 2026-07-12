import { describe, expect, it } from "vitest";
import type { ExamplesIndex } from "../../src/inspector/examples";
import { buildManifest } from "../../src/inspector/manifest";
import type { ToolContext } from "../../src/inspector/mcp/tools";
import {
  callTool,
  DEFAULT_CHECK_FILENAME,
  EXAMPLE_GUIDANCE,
  InvalidToolArgsError,
  runCatalogTool,
  runCheckTool,
  runControllerTool,
  runExampleTool,
  TOOL_DESCRIPTORS,
  ToolExecutionError,
} from "../../src/inspector/mcp/tools";
import type { Manifest } from "../../src/inspector/types";

const manifest = buildManifest("0.0.0");

/** Known-clean markup (mirrors the engine test fixture in `check.test.ts`). */
const validMenu = `
  <div data-controller="stimeo--menu">
    <button aria-haspopup="menu" data-stimeo--menu-target="trigger"
            data-action="click->stimeo--menu#toggle">Actions</button>
    <ul role="menu" data-stimeo--menu-target="menu" hidden>
      <li role="none"><button role="menuitem" data-stimeo--menu-target="item"
                  data-action="click->stimeo--menu#activate">Edit</button></li>
    </ul>
  </div>`;

/** A one-entry example index so tool tests never need the post-build bundle. */
const examples: ExamplesIndex = {
  schemaVersion: 1,
  examples: {
    "stimeo--menu": {
      file: "playground/app/views/components/demos/menu/_demo.html.erb",
      source: validMenu,
    },
  },
};

const context: ToolContext = { manifest, examples };

/**
 * Tests for the pure MCP tool handlers. Protocol framing is covered by
 * `mcp_server.test.ts`; here we assert each handler's pure
 * `(context slice, args) → result` contract — manifest-backed tools against
 * the real reflected manifest, `stimeo_example` against a fixed index.
 */
describe("runCheckTool", () => {
  it("reports ok for clean markup", () => {
    const report = runCheckTool(manifest, { source: validMenu });
    expect(report.ok).toBe(true);
    expect(report.checkedFiles).toBe(1);
    expect(report.errorCount).toBe(0);
    expect(report.files).toEqual([]);
  });

  it("reports diagnostics for an unknown controller under the default filename", () => {
    const report = runCheckTool(manifest, {
      source: '<div data-controller="stimeo--menuu"></div>',
    });
    expect(report.ok).toBe(false);
    expect(report.errorCount).toBeGreaterThan(0);
    expect(report.files[0]?.file).toBe(DEFAULT_CHECK_FILENAME);
    expect(report.files[0]?.diagnostics.map((d) => d.code)).toContain("unknown-controller");
  });

  it("reports a missing required target with the client-supplied filename", () => {
    const report = runCheckTool(manifest, {
      source: '<div data-controller="stimeo--menu"></div>',
      filename: "app/views/users/show.html.erb",
    });
    expect(report.ok).toBe(false);
    expect(report.files[0]?.file).toBe("app/views/users/show.html.erb");
    expect(report.files[0]?.diagnostics.map((d) => d.code)).toContain("missing-required-target");
  });

  it("rejects a missing source argument", () => {
    expect(() => runCheckTool(manifest, {})).toThrow(InvalidToolArgsError);
  });

  it("rejects non-object arguments", () => {
    expect(() => runCheckTool(manifest, "markup")).toThrow(InvalidToolArgsError);
    expect(() => runCheckTool(manifest, ["markup"])).toThrow(InvalidToolArgsError);
  });

  it("rejects a non-string filename", () => {
    expect(() => runCheckTool(manifest, { source: "<div></div>", filename: 3 })).toThrow(
      InvalidToolArgsError,
    );
  });

  it("rejects unknown argument keys, matching additionalProperties: false", () => {
    expect(() => runCheckTool(manifest, { source: "<div></div>", extra: true })).toThrow(
      InvalidToolArgsError,
    );
    expect(() => callTool(context, "stimeo_catalog", { id: "stimeo--tabs" })).toThrow(
      InvalidToolArgsError,
    );
  });
});

describe("runCatalogTool", () => {
  it("lists every controller with its API surface only", () => {
    const catalog = runCatalogTool(manifest);
    expect(catalog.packageVersion).toBe("0.0.0");
    expect(catalog.schemaVersion).toBe(manifest.schemaVersion);
    expect(catalog.controllerCount).toBe(Object.keys(manifest.controllers).length);
    const tabs = catalog.controllers["stimeo--tabs"];
    expect(tabs).toBeDefined();
    expect(tabs?.targets).toContain("tab");
    // Contract rules stay out of the catalog; they come from stimeo_controller.
    expect(tabs).not.toHaveProperty("a11y");
    expect(tabs).not.toHaveProperty("requiredTargets");
  });

  it("sorts controller ids", () => {
    const ids = Object.keys(runCatalogTool(manifest).controllers);
    expect(ids).toEqual([...ids].sort());
  });

  it("stores a hostile __proto__ manifest key as data instead of a prototype", () => {
    // Raw JSON on purpose: JSON.parse defines "__proto__" as an own property
    // (an object literal would treat it as the prototype setter). On a plain
    // {} dictionary the re-assignment in runCatalogTool would then rewrite
    // the prototype and silently drop the entry.
    const hostile = JSON.parse(
      '{"schemaVersion":4,"packageVersion":"0.0.0","controllers":{"__proto__":' +
        '{"targets":["x"],"values":[],"actions":[],"events":[],' +
        '"requiredTargets":[],"a11y":[],"keyboard":[],"managedAria":[]}}}',
    ) as Manifest;
    const catalog = runCatalogTool(hostile);
    expect(catalog.controllerCount).toBe(1);
    expect(Object.hasOwn(catalog.controllers, "__proto__")).toBe(true);
    const reparsed = JSON.parse(JSON.stringify(catalog.controllers)) as Record<string, unknown>;
    expect(Object.hasOwn(reparsed, "__proto__")).toBe(true);
  });
});

describe("runControllerTool", () => {
  it("returns the full contract including the accessibility rules", () => {
    const contract = runControllerTool(manifest, { id: "stimeo--menu" });
    expect(contract.id).toBe("stimeo--menu");
    expect(contract.targets).toContain("trigger");
    expect(contract.requiredTargets.length).toBeGreaterThan(0);
    expect(contract.a11y.length).toBeGreaterThan(0);
    expect(contract.a11y[0]).toHaveProperty("suggestion");
  });

  it("suggests the nearest identifier for an unknown id", () => {
    expect(() => runControllerTool(manifest, { id: "stimeo--tab" })).toThrow(
      /Unknown controller "stimeo--tab"\. Did you mean "stimeo--tabs"\?/,
    );
  });

  it("throws a tool execution error (not an args error) for unknown ids", () => {
    expect(() => runControllerTool(manifest, { id: "nope" })).toThrow(ToolExecutionError);
  });

  it("rejects prototype-inherited keys as unknown controllers", () => {
    // The manifest is parsed JSON: bare bracket access would resolve these to
    // Object.prototype members and fake a successful lookup.
    for (const id of ["constructor", "__proto__", "hasOwnProperty", "toString"]) {
      expect(() => runControllerTool(manifest, { id })).toThrow(ToolExecutionError);
    }
  });

  it("rejects a missing id argument", () => {
    expect(() => runControllerTool(manifest, {})).toThrow(InvalidToolArgsError);
  });
});

describe("runExampleTool", () => {
  it("returns the bundled example with its provenance and guidance", () => {
    const result = runExampleTool(examples, { id: "stimeo--menu" });
    expect(result.id).toBe("stimeo--menu");
    expect(result.file).toBe("playground/app/views/components/demos/menu/_demo.html.erb");
    expect(result.source).toContain('data-controller="stimeo--menu"');
    expect(result.guidance).toBe(EXAMPLE_GUIDANCE);
  });

  it("suggests the nearest identifier for an unknown id", () => {
    expect(() => runExampleTool(examples, { id: "stimeo--menuu" })).toThrow(
      /No example for controller "stimeo--menuu"\. Did you mean "stimeo--menu"\?/,
    );
  });

  it("throws a tool execution error (not an args error) for unknown ids", () => {
    expect(() => runExampleTool(examples, { id: "nope" })).toThrow(ToolExecutionError);
  });

  it("rejects prototype-inherited keys as unknown examples", () => {
    // examples.json is parsed JSON: same prototype-chain pitfall as the manifest.
    for (const id of ["constructor", "__proto__", "hasOwnProperty", "toString"]) {
      expect(() => runExampleTool(examples, { id })).toThrow(ToolExecutionError);
    }
  });

  it("rejects a missing id argument and unknown argument keys", () => {
    expect(() => runExampleTool(examples, {})).toThrow(InvalidToolArgsError);
    expect(() => runExampleTool(examples, { id: "stimeo--menu", extra: 1 })).toThrow(
      InvalidToolArgsError,
    );
  });
});

describe("callTool", () => {
  it("dispatches each advertised tool to its handler", () => {
    const check = callTool(context, "stimeo_check", { source: validMenu }) as { ok: boolean };
    expect(check.ok).toBe(true);
    const catalog = callTool(context, "stimeo_catalog", undefined) as { controllerCount: number };
    expect(catalog.controllerCount).toBeGreaterThan(0);
    const controller = callTool(context, "stimeo_controller", { id: "stimeo--tabs" }) as {
      id: string;
    };
    expect(controller.id).toBe("stimeo--tabs");
    const example = callTool(context, "stimeo_example", { id: "stimeo--menu" }) as { id: string };
    expect(example.id).toBe("stimeo--menu");
  });

  it("rejects unknown tool names", () => {
    expect(() => callTool(context, "stimeo_write", {})).toThrow(InvalidToolArgsError);
  });

  it("advertises exactly the dispatchable tools", () => {
    expect(TOOL_DESCRIPTORS.map((t) => t.name)).toEqual([
      "stimeo_check",
      "stimeo_catalog",
      "stimeo_controller",
      "stimeo_example",
    ]);
    for (const descriptor of TOOL_DESCRIPTORS) {
      expect(descriptor.inputSchema.type).toBe("object");
      expect(descriptor.description.length).toBeGreaterThan(0);
    }
  });

  it("declares read-only annotations and an object output schema on every tool", () => {
    for (const descriptor of TOOL_DESCRIPTORS) {
      expect(descriptor.annotations).toEqual({ readOnlyHint: true, openWorldHint: false });
      expect(descriptor.outputSchema).toMatchObject({ type: "object" });
    }
  });

  it("returns results shaped exactly as each advertised outputSchema", () => {
    // Locks the hand-written schemas to the handlers' real output: every
    // required key present, no undeclared top-level key returned.
    const results: Record<string, unknown> = {
      stimeo_check: callTool(context, "stimeo_check", { source: validMenu }),
      stimeo_catalog: callTool(context, "stimeo_catalog", undefined),
      stimeo_controller: callTool(context, "stimeo_controller", { id: "stimeo--menu" }),
      stimeo_example: callTool(context, "stimeo_example", { id: "stimeo--menu" }),
    };
    for (const descriptor of TOOL_DESCRIPTORS) {
      const schema = descriptor.outputSchema as {
        properties: Record<string, unknown>;
        required: readonly string[];
      };
      const declared = Object.keys(schema.properties);
      const actual = Object.keys(results[descriptor.name] as Record<string, unknown>);
      for (const key of schema.required) expect(actual).toContain(key);
      for (const key of actual) expect(declared).toContain(key);
    }
  });

  it("keeps the a11y item schema aligned with real contract entries", () => {
    // Representative nested check: the deepest structure a client would
    // validate. `stimeo--menu` carries at least one a11y requirement.
    const contract = callTool(context, "stimeo_controller", { id: "stimeo--menu" }) as {
      a11y: Record<string, unknown>[];
    };
    const outputSchema = TOOL_DESCRIPTORS.find((t) => t.name === "stimeo_controller")
      ?.outputSchema as {
      properties: {
        a11y: { items: { properties: Record<string, unknown>; required: string[] } };
      };
    };
    const itemSchema = outputSchema.properties.a11y.items;
    const declared = Object.keys(itemSchema.properties);
    for (const rule of contract.a11y) {
      for (const key of itemSchema.required) expect(Object.keys(rule)).toContain(key);
      for (const key of Object.keys(rule)) expect(declared).toContain(key);
    }
  });
});

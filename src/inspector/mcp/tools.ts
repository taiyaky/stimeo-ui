import { checkSource, didYouMean } from "../check";
import { buildCheckReport, sortedControllerEntries } from "../cli";
import type { ExamplesIndex } from "../examples";
import type { CheckReport, ControllerManifest, Manifest } from "../types";
import { DIAGNOSTIC_CODES } from "../types";

/**
 * Tool definitions and pure handlers for the `stimeo mcp` server.
 *
 * Each MCP tool wraps an existing pure engine function ({@link checkSource},
 * {@link buildCheckReport}, manifest lookups) so the server, the CLI, and the
 * project's own CI gate share exactly the same code path. Each handler takes
 * `args` plus the slice of {@link ToolContext} it needs (the manifest, the
 * example index, or both) and returns a plain JSON-serializable object; the
 * handlers perform no I/O, so they are unit-tested directly without a
 * protocol round-trip.
 *
 * All tools are read-only: `stimeo_check` inspects a source string passed by
 * the client (no filesystem traversal), the others only read the bundled
 * manifest and example index.
 */

/** Names of the tools exposed by the MCP server. */
export type ToolName = "stimeo_check" | "stimeo_catalog" | "stimeo_controller" | "stimeo_example";

/**
 * Everything the tool dispatcher needs: the reflected manifest plus the
 * bundled example index (both generated at build time next to the CLI).
 */
export interface ToolContext {
  readonly manifest: Manifest;
  readonly examples: ExamplesIndex;
}

/** Minimal JSON Schema subset used to describe tool inputs in `tools/list`. */
export interface ToolInputSchema {
  readonly type: "object";
  readonly properties: Readonly<
    Record<string, { readonly type: string; readonly description: string }>
  >;
  readonly required?: readonly string[];
  readonly additionalProperties: boolean;
}

/**
 * MCP tool annotations (protocol 2025-03-26+): machine-readable behavior hints.
 * Every v1 tool is read-only and closed-world (it only consults the bundled
 * manifest and the strings the client sends), so clients can skip destructive-
 * action confirmation UX.
 */
export interface ToolAnnotations {
  readonly readOnlyHint: boolean;
  readonly openWorldHint: boolean;
}

/**
 * JSON Schema for a tool result (`outputSchema` in `tools/list`). Typed as a
 * plain JSON object rather than a full JSON Schema model: the schemas below
 * are hand-written literals, and their conformance to what the handlers
 * actually return is locked by `mcp_tools.test.ts`.
 */
export type ToolOutputSchema = Readonly<Record<string, unknown>>;

/** One entry of the `tools/list` response. */
export interface ToolDescriptor {
  readonly name: ToolName;
  readonly title: string;
  readonly description: string;
  readonly annotations: ToolAnnotations;
  readonly inputSchema: ToolInputSchema;
  readonly outputSchema: ToolOutputSchema;
}

/** Shared annotations: every v1 tool is read-only over bundled data. */
const READ_ONLY_ANNOTATIONS: ToolAnnotations = { readOnlyHint: true, openWorldHint: false };

/** JSON Schema fragment for a `readonly string[]` field. */
const STRING_ARRAY = { type: "array", items: { type: "string" } } as const;

/** JSON Schema for one diagnostic inside a {@link CheckReport}. */
const DIAGNOSTIC_SCHEMA = {
  type: "object",
  properties: {
    code: { type: "string", enum: DIAGNOSTIC_CODES },
    severity: { type: "string", enum: ["error", "warning"] },
    message: { type: "string" },
    line: { type: "integer", description: "1-based line where the problem was detected." },
    column: { type: "integer", description: "1-based column where the problem was detected." },
    suggestion: { type: "string", description: "Fix suggestion (stage 4), when available." },
  },
  required: ["code", "severity", "message", "line", "column"],
} as const;

/** JSON Schema for the `stimeo_check` result (mirrors {@link CheckReport}). */
const CHECK_REPORT_SCHEMA: ToolOutputSchema = {
  type: "object",
  description: "Aggregated check result; same shape as `stimeo check --json`.",
  properties: {
    ok: { type: "boolean", description: "True when no error-severity diagnostics were found." },
    checkedFiles: { type: "integer" },
    errorCount: { type: "integer" },
    warningCount: { type: "integer" },
    files: {
      type: "array",
      description: "Only files that produced at least one diagnostic.",
      items: {
        type: "object",
        properties: {
          file: { type: "string" },
          diagnostics: { type: "array", items: DIAGNOSTIC_SCHEMA },
        },
        required: ["file", "diagnostics"],
      },
    },
  },
  required: ["ok", "checkedFiles", "errorCount", "warningCount", "files"],
};

/** JSON Schema for the `stimeo_catalog` result (mirrors {@link CatalogResult}). */
const CATALOG_RESULT_SCHEMA: ToolOutputSchema = {
  type: "object",
  properties: {
    schemaVersion: { type: "integer" },
    packageVersion: { type: "string" },
    controllerCount: { type: "integer" },
    controllers: {
      type: "object",
      description: 'Keyed by controller identifier, e.g. "stimeo--menu".',
      additionalProperties: {
        type: "object",
        properties: {
          targets: STRING_ARRAY,
          values: STRING_ARRAY,
          actions: STRING_ARRAY,
          events: STRING_ARRAY,
        },
        required: ["targets", "values", "actions", "events"],
      },
    },
  },
  required: ["schemaVersion", "packageVersion", "controllerCount", "controllers"],
};

/** JSON Schema for the `stimeo_example` result (mirrors {@link ExampleResult}). */
const EXAMPLE_RESULT_SCHEMA: ToolOutputSchema = {
  type: "object",
  properties: {
    id: { type: "string", description: 'Controller identifier, e.g. "stimeo--menu".' },
    file: {
      type: "string",
      description: "Repo-relative provenance of the example (the catalog demo sidecar).",
    },
    source: { type: "string", description: "The HTML/ERB example source." },
    guidance: { type: "string", description: "How to consume the example correctly." },
  },
  required: ["id", "file", "source", "guidance"],
};

/** JSON Schema for the `stimeo_controller` result (mirrors {@link ControllerContract}). */
const CONTROLLER_CONTRACT_SCHEMA: ToolOutputSchema = {
  type: "object",
  properties: {
    id: { type: "string", description: 'Controller identifier, e.g. "stimeo--tabs".' },
    targets: STRING_ARRAY,
    values: STRING_ARRAY,
    actions: STRING_ARRAY,
    events: STRING_ARRAY,
    requiredTargets: {
      ...STRING_ARRAY,
      description: "Targets that must be present at least once inside the controller scope.",
    },
    a11y: {
      type: "array",
      description: "Author-supplied ARIA the controller relies on but never sets itself.",
      items: {
        type: "object",
        properties: {
          target: {
            type: "string",
            description: 'Target name; "" means the data-controller element itself.',
          },
          attrs: { ...STRING_ARRAY, description: "At least one of these must be present." },
          values: { ...STRING_ARRAY, description: "Allowed values; absent = any value." },
          or: {
            type: "array",
            description: "Alternative attribute groups; satisfying any group satisfies the rule.",
            items: {
              type: "object",
              properties: { attrs: STRING_ARRAY, values: STRING_ARRAY },
              required: ["attrs"],
            },
          },
          suggestion: { type: "string" },
        },
        required: ["target", "attrs", "suggestion"],
      },
    },
    keyboard: {
      type: "array",
      description: "Targets whose keyboard focusability the author must provide.",
      items: {
        type: "object",
        properties: {
          target: { type: "string" },
          reach: {
            type: "string",
            enum: ["tab", "focus"],
            description: 'How focus arrives; defaults to "tab" (steady Tab stop).',
          },
          suggestion: { type: "string" },
        },
        required: ["target", "suggestion"],
      },
    },
    managedAria: {
      type: "array",
      description: "ARIA the controller recomputes at runtime; authoring it is a warning.",
      items: {
        type: "object",
        properties: {
          target: { type: "string" },
          attrs: STRING_ARRAY,
          suggestion: { type: "string" },
        },
        required: ["target", "attrs", "suggestion"],
      },
    },
    compositions: {
      type: "array",
      description:
        "Cross-controller value alignments: when the companion controller is co-located on " +
        "the named target, its value (authored or default) must be one of the allowed set.",
      items: {
        type: "object",
        properties: {
          target: {
            type: "string",
            description: 'Host target hosting the companion; "" means the data-controller element.',
          },
          fallbackToScope: {
            type: "boolean",
            description: "Check the scope element when the target is absent.",
          },
          coController: { type: "string", description: "Companion controller identifier." },
          when: {
            type: "object",
            description: "Host-value condition arming the rule; absent means unconditional.",
            properties: {
              value: { type: "string" },
              equals: STRING_ARRAY,
              default: { type: "string" },
            },
            required: ["value", "equals", "default"],
          },
          require: {
            type: "object",
            description: "Companion-value requirement (first allowed value is canonical).",
            properties: {
              value: { type: "string" },
              oneOf: STRING_ARRAY,
              default: { type: "string" },
            },
            required: ["value", "oneOf", "default"],
          },
          suggestion: { type: "string" },
        },
        required: ["target", "coController", "require", "suggestion"],
      },
    },
  },
  required: [
    "id",
    "targets",
    "values",
    "actions",
    "events",
    "requiredTargets",
    "a11y",
    "keyboard",
    "managedAria",
    "compositions",
  ],
};

/**
 * Raised when `tools/call` arguments fail validation. The server maps this to
 * a JSON-RPC "Invalid params" (-32602) protocol error, per the MCP spec's
 * distinction between protocol errors and tool execution errors.
 */
export class InvalidToolArgsError extends Error {}

/**
 * Raised when a tool runs but cannot produce a result (e.g. unknown controller
 * id). The server maps this to a tool result with `isError: true`, so the
 * calling model sees the message and can self-correct.
 */
export class ToolExecutionError extends Error {}

/** Report filename used by `stimeo_check` when the client does not send one. */
export const DEFAULT_CHECK_FILENAME = "source.erb";

/** Catalog view of one controller: the reflected `data-*` API surface only. */
export interface CatalogController {
  readonly targets: readonly string[];
  readonly values: readonly string[];
  readonly actions: readonly string[];
  readonly events: readonly string[];
}

/**
 * Result of `stimeo_catalog`: every controller's API surface, without the
 * per-controller contract rules (those come from `stimeo_controller`), keeping
 * the discovery payload small for model consumption.
 */
export interface CatalogResult {
  readonly schemaVersion: number;
  readonly packageVersion: string;
  readonly controllerCount: number;
  readonly controllers: Readonly<Record<string, CatalogController>>;
}

/** Result of `stimeo_controller`: the full manifest entry plus its id. */
export interface ControllerContract extends ControllerManifest {
  readonly id: string;
}

/** Result of `stimeo_example`: one controller's verified example markup. */
export interface ExampleResult {
  readonly id: string;
  /** Repo-relative provenance of the example (the catalog demo sidecar). */
  readonly file: string;
  /** The HTML/ERB source. */
  readonly source: string;
  /** How to consume the example correctly ({@link EXAMPLE_GUIDANCE}). */
  readonly guidance: string;
}

/**
 * Consumption note attached to every `stimeo_example` result. The examples are
 * headless-catalog demos: the `stimeo--*` data attributes are the contract;
 * class attributes are demo styling placeholders the consumer must replace.
 */
export const EXAMPLE_GUIDANCE =
  "Verified example from the official Stimeo UI catalog (it passes stimeo_check against the " +
  "bundled manifest). Behavior and accessibility come from the data-* attributes and any " +
  "role/aria-* attributes shown; keep those intact. class attributes are demo styling " +
  "placeholders — the library ships no CSS, so replace them with your own classes. ERB " +
  "helpers/comments illustrate Rails usage and can be adapted.";

/** Tool descriptors advertised via `tools/list`. */
export const TOOL_DESCRIPTORS: readonly ToolDescriptor[] = [
  {
    name: "stimeo_check",
    title: "Check Stimeo UI markup",
    description:
      "Statically check HTML or ERB source that uses Stimeo UI (stimeo--*) controllers. " +
      "Returns a CheckReport with diagnostics — unknown controllers/targets/values/action " +
      "methods, missing required targets, missing or invalid author-supplied ARIA, " +
      "keyboard-focusability prerequisites, and misaligned cross-controller composition " +
      "values — each with a fix suggestion when available. " +
      "Call this on generated markup before finalizing it; ok=true means no errors.",
    annotations: READ_ONLY_ANNOTATIONS,
    inputSchema: {
      type: "object",
      properties: {
        source: {
          type: "string",
          description: "The HTML or ERB source to check.",
        },
        filename: {
          type: "string",
          description:
            'Optional filename reported in diagnostics (e.g. "app/views/users/show.html.erb").',
        },
      },
      required: ["source"],
      additionalProperties: false,
    },
    outputSchema: CHECK_REPORT_SCHEMA,
  },
  {
    name: "stimeo_catalog",
    title: "List Stimeo UI controllers",
    description:
      "List every Stimeo UI controller with its targets, values, actions, and events. " +
      "Use this to discover which stimeo--* controllers exist and the data-* API each " +
      "accepts before writing markup.",
    annotations: READ_ONLY_ANNOTATIONS,
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    outputSchema: CATALOG_RESULT_SCHEMA,
  },
  {
    name: "stimeo_controller",
    title: "Get one controller's usage contract",
    description:
      "Fetch the full usage contract of one Stimeo UI controller by identifier " +
      '(e.g. "stimeo--tabs"): targets, values, actions, events, required targets, and the ' +
      "accessibility contract — author-supplied ARIA requirements, keyboard-focusability " +
      "prerequisites, the ARIA attributes the controller manages at runtime (which the " +
      "author must NOT hardcode), and cross-controller composition value alignments.",
    annotations: READ_ONLY_ANNOTATIONS,
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: 'Controller identifier, e.g. "stimeo--tabs".',
        },
      },
      required: ["id"],
      additionalProperties: false,
    },
    outputSchema: CONTROLLER_CONTRACT_SCHEMA,
  },
  {
    name: "stimeo_example",
    title: "Get one controller's verified example markup",
    description:
      "Fetch verified example markup for one Stimeo UI controller by identifier " +
      '(e.g. "stimeo--menu"). The example is the official catalog demo — it passes ' +
      "stimeo_check against the bundled manifest, so use it as the reference for correct " +
      "structure, required targets, and author-supplied ARIA. class attributes in it are " +
      "demo styling placeholders to replace; the stimeo--* data attributes and role/aria-* " +
      "attributes are the contract to keep.",
    annotations: READ_ONLY_ANNOTATIONS,
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: 'Controller identifier, e.g. "stimeo--menu".',
        },
      },
      required: ["id"],
      additionalProperties: false,
    },
    outputSchema: EXAMPLE_RESULT_SCHEMA,
  },
];

/**
 * Narrows unknown `tools/call` arguments to a record, treating absence as
 * empty. Unknown keys are rejected so behavior matches the advertised
 * `additionalProperties: false` in every tool's input schema.
 */
function asArgsRecord(args: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (args === undefined || args === null) return {};
  if (typeof args !== "object" || Array.isArray(args)) {
    throw new InvalidToolArgsError("Tool arguments must be an object.");
  }
  const record = args as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      throw new InvalidToolArgsError(`Unknown argument "${key}".`);
    }
  }
  return record;
}

/** Reads a required string property from tool arguments. */
function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") {
    throw new InvalidToolArgsError(`Argument "${key}" is required and must be a string.`);
  }
  return value;
}

/** Reads an optional string property from tool arguments. */
function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new InvalidToolArgsError(`Argument "${key}" must be a string when given.`);
  }
  return value;
}

/**
 * `stimeo_check`: runs the engine on one in-memory source and aggregates the
 * diagnostics into a {@link CheckReport}, exactly like `stimeo check --json`
 * does for files on disk.
 */
export function runCheckTool(manifest: Manifest, args: unknown): CheckReport {
  const record = asArgsRecord(args, ["source", "filename"]);
  const source = requireString(record, "source");
  const filename = optionalString(record, "filename") ?? DEFAULT_CHECK_FILENAME;
  return buildCheckReport([{ file: filename, diagnostics: checkSource(source, manifest) }], 1);
}

/** `stimeo_catalog`: the API surface of every controller, sorted by identifier. */
export function runCatalogTool(manifest: Manifest): CatalogResult {
  // Null-prototype dictionary: manifest keys come from parsed JSON, and
  // assigning a hostile "__proto__" key onto a plain object would silently
  // rewrite the dictionary's prototype instead of storing the entry.
  const controllers: Record<string, CatalogController> = Object.create(null);
  for (const [id, controller] of sortedControllerEntries(manifest)) {
    controllers[id] = {
      targets: controller.targets,
      values: controller.values,
      actions: controller.actions,
      events: controller.events,
    };
  }
  return {
    schemaVersion: manifest.schemaVersion,
    packageVersion: manifest.packageVersion,
    controllerCount: Object.keys(controllers).length,
    controllers,
  };
}

/**
 * Prototype-safe dictionary lookup. The manifest and example dictionaries are
 * parsed JSON, so bare bracket access would resolve prototype keys
 * ("constructor", "toString", "__proto__", …) to inherited members and fake a
 * successful lookup for a nonexistent id — a hostile key must read as absent.
 */
export function getOwn<T>(dict: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(dict, key) ? dict[key] : undefined;
}

/**
 * `stimeo_controller`: one controller's full contract (a11y and keyboard
 * requirements included). Unknown ids produce a tool execution error with a
 * "did you mean" hint so the calling model can self-correct.
 */
export function runControllerTool(manifest: Manifest, args: unknown): ControllerContract {
  const record = asArgsRecord(args, ["id"]);
  const id = requireString(record, "id");
  const controller = getOwn(manifest.controllers, id);
  if (!controller) {
    const hint = didYouMean(id, Object.keys(manifest.controllers));
    throw new ToolExecutionError(
      `Unknown controller "${id}".${hint ? ` ${hint}` : ""} Use stimeo_catalog to list available controllers.`,
    );
  }
  return { id, ...controller };
}

/**
 * `stimeo_example`: one controller's verified example markup, straight from
 * the bundled catalog-demo index. Unknown ids produce a tool execution error
 * with a "did you mean" hint so the calling model can self-correct.
 */
export function runExampleTool(examples: ExamplesIndex, args: unknown): ExampleResult {
  const record = asArgsRecord(args, ["id"]);
  const id = requireString(record, "id");
  const entry = getOwn(examples.examples, id);
  if (!entry) {
    const hint = didYouMean(id, Object.keys(examples.examples));
    throw new ToolExecutionError(
      `No example for controller "${id}".${hint ? ` ${hint}` : ""} Use stimeo_catalog to list available controllers.`,
    );
  }
  return { id, file: entry.file, source: entry.source, guidance: EXAMPLE_GUIDANCE };
}

/**
 * Dispatches one `tools/call` invocation to its handler.
 *
 * @throws InvalidToolArgsError for unknown tool names or malformed arguments
 *   (protocol error), {@link ToolExecutionError} for failures inside a tool
 *   (returned as an `isError` tool result).
 */
export function callTool(context: ToolContext, name: string, args: unknown): unknown {
  switch (name) {
    case "stimeo_check":
      return runCheckTool(context.manifest, args);
    case "stimeo_catalog":
      asArgsRecord(args, []);
      return runCatalogTool(context.manifest);
    case "stimeo_controller":
      return runControllerTool(context.manifest, args);
    case "stimeo_example":
      return runExampleTool(context.examples, args);
    default:
      throw new InvalidToolArgsError(`Unknown tool "${name}".`);
  }
}

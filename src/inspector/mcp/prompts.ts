/**
 * Prompt definitions for the `stimeo mcp` server (`prompts/list` /
 * `prompts/get`).
 *
 * Prompts are user-invokable workflow templates (clients commonly surface them
 * as slash commands) that bake in the correct tool sequence —
 * discover via `stimeo_catalog`, pull the contract via `stimeo_controller`,
 * reference `stimeo_example`, and validate with `stimeo_check` before
 * presenting — so the calling model does not have to rediscover the workflow
 * each time. They are static text with argument interpolation; all live data
 * still flows through the tools.
 *
 * Handlers are pure (`(name, args) → messages`) like the tool handlers, so
 * they are unit-tested without a protocol round-trip.
 */

/** One argument accepted by a prompt, as advertised in `prompts/list`. */
export interface PromptArgumentDescriptor {
  readonly name: string;
  readonly description: string;
  readonly required: boolean;
}

/** One entry of the `prompts/list` response. */
export interface PromptDescriptor {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly arguments: readonly PromptArgumentDescriptor[];
}

/** One message of a `prompts/get` result (this server emits text only). */
export interface PromptMessage {
  readonly role: "user";
  readonly content: { readonly type: "text"; readonly text: string };
}

/** The `prompts/get` result payload. */
export interface PromptResult {
  readonly description: string;
  readonly messages: readonly PromptMessage[];
}

/**
 * Raised when `prompts/get` names an unknown prompt or passes malformed
 * arguments. The server maps this to a JSON-RPC "Invalid params" (-32602)
 * protocol error, per the MCP prompts spec.
 */
export class InvalidPromptRequestError extends Error {}

/**
 * Narrows unknown `prompts/get` arguments to a string-valued record (the MCP
 * prompts spec allows string values only), treating absence as empty and
 * rejecting keys the prompt does not declare.
 */
function asPromptArgs(args: unknown, allowed: readonly string[]): Record<string, string> {
  if (args === undefined || args === null) return {};
  if (typeof args !== "object" || Array.isArray(args)) {
    throw new InvalidPromptRequestError("Prompt arguments must be an object.");
  }
  const record = args as Record<string, unknown>;
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    if (!allowed.includes(key)) {
      throw new InvalidPromptRequestError(`Unknown argument "${key}".`);
    }
    if (typeof value !== "string") {
      throw new InvalidPromptRequestError(`Argument "${key}" must be a string.`);
    }
    result[key] = value;
  }
  return result;
}

/** Reads a required argument, present and non-empty. */
function requireArg(record: Record<string, string>, key: string): string {
  const value = record[key];
  if (value === undefined || value.trim() === "") {
    throw new InvalidPromptRequestError(`Argument "${key}" is required.`);
  }
  return value;
}

/**
 * Reads an optional argument, trimmed; a blank value counts as absent so a
 * whitespace-only slash-command input cannot leak into the prompt text.
 */
function optionalArg(record: Record<string, string>, key: string): string | undefined {
  const value = record[key]?.trim();
  return value ? value : undefined;
}

/** Builds the `stimeo_build_ui` messages. */
function buildUiPrompt(args: Record<string, string>): PromptResult {
  const request = requireArg(args, "request");
  const controller = optionalArg(args, "controller");
  const start = controller
    ? `Start from the controller "${controller}" (verify it exists with stimeo_controller; ` +
      "if it does not, fall back to discovery via stimeo_catalog)."
    : "Call stimeo_catalog to find the controller(s) that fit the task.";
  const text =
    "You are building UI for a Rails app with Stimeo UI, a headless (behavior-only) Stimulus " +
    "framework driven by data-* attributes. It ships no CSS; styling is the app's own.\n\n" +
    `Task: ${request}\n\n` +
    "Follow this workflow with the stimeo MCP tools:\n" +
    `1. ${start}\n` +
    "2. Call stimeo_controller for each chosen controller to get its contract: required " +
    "targets, author-supplied ARIA, keyboard prerequisites, and the ARIA it manages at " +
    "runtime (never hardcode those managed attributes).\n" +
    "3. Call stimeo_example for each chosen controller and use the verified markup as your " +
    "structural reference.\n" +
    "4. Write the markup: keep every data-*, role, and aria-* attribute the contract and " +
    "example require; replace demo class attributes with the app's own styling.\n" +
    "5. Call stimeo_check on the markup you wrote and fix every diagnostic (each one carries " +
    "a fix suggestion when available). Repeat until ok is true — only then present the " +
    "result.";
  return {
    description: "Build Stimeo UI markup with the discover → contract → example → check workflow.",
    messages: [{ role: "user", content: { type: "text", text } }],
  };
}

/** Builds the `stimeo_fix_markup` messages. */
function fixMarkupPrompt(args: Record<string, string>): PromptResult {
  const source = requireArg(args, "source");
  const filename = optionalArg(args, "filename");
  const filenameClause = filename ? ` (filename: "${filename}")` : "";
  // The source is fenced so its own prose cannot read as workflow steps.
  const text =
    "You are reviewing existing markup that uses Stimeo UI (stimeo--*) controllers.\n\n" +
    `1. Call stimeo_check with the fenced source below${filenameClause}.\n` +
    "2. For each diagnostic, apply its fix suggestion; when a fix needs context, call " +
    "stimeo_controller for the affected controller's contract and stimeo_example for verified " +
    "reference markup.\n" +
    "3. Re-run stimeo_check on the corrected markup until ok is true.\n" +
    "4. Present the corrected markup and a short list of what changed and why.\n\n" +
    `Source:\n\n\`\`\`erb\n${source}\n\`\`\``;
  return {
    description: "Check the given markup and fix every diagnostic until stimeo_check passes.",
    messages: [{ role: "user", content: { type: "text", text } }],
  };
}

/** One prompt: its `prompts/list` descriptor plus its message builder. */
interface PromptDefinition {
  readonly descriptor: PromptDescriptor;
  readonly build: (args: Record<string, string>) => PromptResult;
}

/**
 * The prompts this server serves. Descriptor and builder live side by side so
 * a prompt cannot be advertised without being dispatchable (adding an entry
 * here is the whole registration).
 */
const PROMPTS: readonly PromptDefinition[] = [
  {
    descriptor: {
      name: "stimeo_build_ui",
      title: "Build UI with Stimeo UI",
      description:
        "Build Rails view markup for a requested UI using Stimeo UI controllers, following the " +
        "verified workflow: discover with stimeo_catalog, read the contract with " +
        "stimeo_controller, reference stimeo_example, and validate with stimeo_check before " +
        "presenting.",
      arguments: [
        {
          name: "request",
          description: 'What to build, e.g. "a confirmation dialog for deleting a project".',
          required: true,
        },
        {
          name: "controller",
          description:
            'Optional controller identifier to start from, e.g. "stimeo--dialog". ' +
            "Omit to let the workflow discover one via stimeo_catalog.",
          required: false,
        },
      ],
    },
    build: buildUiPrompt,
  },
  {
    descriptor: {
      name: "stimeo_fix_markup",
      title: "Check and fix Stimeo UI markup",
      description:
        "Check existing HTML/ERB that uses stimeo--* controllers with stimeo_check, fix every " +
        "diagnostic using the fix suggestions and the controller contracts, and re-check until " +
        "clean.",
      arguments: [
        {
          name: "source",
          description: "The HTML or ERB source to check and fix.",
          required: true,
        },
        {
          name: "filename",
          description: 'Optional filename for diagnostics, e.g. "app/views/users/show.html.erb".',
          required: false,
        },
      ],
    },
    build: fixMarkupPrompt,
  },
];

/** Prompt descriptors advertised via `prompts/list`. */
export const PROMPT_DESCRIPTORS: readonly PromptDescriptor[] = PROMPTS.map(
  (prompt) => prompt.descriptor,
);

/**
 * Dispatches one `prompts/get` invocation to its builder.
 *
 * @throws InvalidPromptRequestError for unknown prompt names or malformed
 *   arguments (mapped to JSON-RPC -32602 by the server).
 */
export function getPrompt(name: string, args: unknown): PromptResult {
  const prompt = PROMPTS.find((entry) => entry.descriptor.name === name);
  if (!prompt) {
    throw new InvalidPromptRequestError(`Unknown prompt "${name}".`);
  }
  const record = asPromptArgs(
    args,
    prompt.descriptor.arguments.map((argument) => argument.name),
  );
  return prompt.build(record);
}

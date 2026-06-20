import { neutralizeErb } from "./erb";
import {
  actionDescriptors,
  controllerIdentifiers,
  dasherize,
  isStimeoDataAttr,
  parseTargetAttr,
  parseValueAttr,
} from "./extract";
import { type ElementNode, type ParsedAttr, parseHtml, walk } from "./html_parser";
import type {
  A11yRequirement,
  Diagnostic,
  DiagnosticCode,
  DiagnosticSeverity,
  Manifest,
} from "./types";

/**
 * The core Inspector engine: checks a single HTML/ERB source string against the
 * manifest and returns diagnostics. It is **input-path agnostic** — the same
 * function backs both internal CI contract checks and the user-facing CLI.
 *
 * The check runs in three stages:
 * - **Stage 1 (names/spelling):** every `stimeo--*` controller, target, value,
 *   and `data-action` controller **and method** must exist in the manifest.
 * - **Stage 2 (structure):** required targets must be present within their
 *   controller scope, and targets must have an owning controller.
 * - **Stage 3 (accessibility):** ARIA the controller relies on but does not set
 *   itself (e.g. a dialog's `role`/`aria-modal`/name) must be present on the
 *   relevant target, with the expected value.
 * - **Stage 4 (fix suggestions):** diagnostics carry a `suggestion` — the
 *   nearest known name for a likely typo, or the exact ARIA to add.
 *
 * @remarks
 * Scope is resolved within a single source string. A controller and its targets
 * split across separate Rails partials cannot be correlated, so stage-2 checks
 * assume self-contained markup (Stimeo's recommended demo/partial structure).
 * ERB is neutralized first, so dynamically-generated attributes are skipped.
 *
 * @param source - Raw HTML/ERB source.
 * @param manifest - The bundled controller manifest to check against.
 * @returns Diagnostics sorted by line then column.
 */
export function checkSource(source: string, manifest: Manifest): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const tree = parseHtml(neutralizeErb(source));
  const known = manifest.controllers;
  const knownIdentifiers = Object.keys(known);

  /** Controller scope registrations: a node declaring `data-controller`. */
  const scopes: Array<{ node: ElementNode; identifier: string }> = [];
  /** Target names found within each scope, keyed by scope node then identifier. */
  const presence = new Map<ElementNode, Map<string, Set<string>>>();
  /** Target *elements* per scope/identifier/target name, for stage-3 ARIA checks. */
  const targetNodes = new Map<ElementNode, Map<string, Map<string, ElementNode[]>>>();

  const recordPresence = (owner: ElementNode, identifier: string, target: string): void => {
    let byId = presence.get(owner);
    if (!byId) {
      byId = new Map();
      presence.set(owner, byId);
    }
    let set = byId.get(identifier);
    if (!set) {
      set = new Set();
      byId.set(identifier, set);
    }
    set.add(target);
  };

  const recordTargetNode = (
    owner: ElementNode,
    identifier: string,
    target: string,
    el: ElementNode,
  ): void => {
    let byId = targetNodes.get(owner);
    if (!byId) {
      byId = new Map();
      targetNodes.set(owner, byId);
    }
    let byName = byId.get(identifier);
    if (!byName) {
      byName = new Map();
      byId.set(identifier, byName);
    }
    const found = byName.get(target);
    if (found) found.push(el);
    else byName.set(target, [el]);
  };

  walk(tree, (node) => {
    for (const attr of node.attrs) {
      // --- data-controller -------------------------------------------------
      if (attr.name === "data-controller") {
        for (const identifier of controllerIdentifiers(attr.value)) {
          if (identifier in known) {
            scopes.push({ node, identifier });
          } else {
            push(
              diagnostics,
              "unknown-controller",
              "error",
              `Unknown Stimeo controller "${identifier}".`,
              attr,
              didYouMean(identifier, knownIdentifiers),
            );
          }
        }
        continue;
      }

      // --- target attribute: data-{identifier}-target ----------------------
      const targetIdentifier = parseTargetAttr(attr.name);
      if (targetIdentifier) {
        const controller = known[targetIdentifier];
        if (!controller) {
          push(
            diagnostics,
            "unknown-controller",
            "error",
            `Target attribute "${attr.name}" references unknown Stimeo controller "${targetIdentifier}".`,
            attr,
            didYouMean(targetIdentifier, knownIdentifiers),
          );
          continue;
        }
        const targetName = attr.value.trim();
        if (targetName.length > 0 && !controller.targets.includes(targetName)) {
          push(
            diagnostics,
            "unknown-target",
            "error",
            `Unknown target "${targetName}" for "${targetIdentifier}". Known targets: ${list(controller.targets)}.`,
            attr,
            didYouMean(targetName, controller.targets),
          );
        }
        const owner = findOwner(node, targetIdentifier);
        if (owner) {
          if (targetName.length > 0) {
            recordPresence(owner, targetIdentifier, targetName);
            recordTargetNode(owner, targetIdentifier, targetName, node);
          }
        } else {
          push(
            diagnostics,
            "orphan-target",
            "error",
            `Target "${attr.name}" has no enclosing controller "${targetIdentifier}".`,
            attr,
          );
        }
        continue;
      }

      // --- value attribute: data-{identifier}-{value}-value ----------------
      if (isStimeoDataAttr(attr.name) && attr.name.endsWith("-value")) {
        const parsed = parseValueAttr(attr.name, knownIdentifiers);
        if (parsed) {
          if (parsed.identifier === null) {
            push(
              diagnostics,
              "unknown-controller",
              "error",
              `Value attribute "${attr.name}" references unknown Stimeo controller.`,
              attr,
            );
          } else {
            const controller = known[parsed.identifier];
            const valid =
              controller?.values.some((v) => dasherize(v) === parsed.valueToken) ?? false;
            if (!valid) {
              push(
                diagnostics,
                "unknown-value",
                "error",
                `Unknown value "${parsed.valueToken}" for "${parsed.identifier}". Known values: ${list((controller?.values ?? []).map(dasherize))}.`,
                attr,
                didYouMean(parsed.valueToken, (controller?.values ?? []).map(dasherize)),
              );
            }
          }
          continue;
        }
      }

      // --- data-action descriptors: controller + method --------------------
      if (attr.name === "data-action") {
        for (const { identifier, method } of actionDescriptors(attr.value)) {
          const controller = known[identifier];
          if (!controller) {
            push(
              diagnostics,
              "unknown-action-controller",
              "error",
              `Action references unknown Stimeo controller "${identifier}".`,
              attr,
              didYouMean(identifier, knownIdentifiers),
            );
          } else if (method.length > 0 && !controller.actions.includes(method)) {
            push(
              diagnostics,
              "unknown-action-method",
              "error",
              `Unknown action "${method}" for "${identifier}". Known actions: ${list(controller.actions)}.`,
              attr,
              didYouMean(method, controller.actions),
            );
          }
        }
      }
    }
  });

  // --- Stage 2: required targets per scope ---------------------------------
  for (const { node, identifier } of scopes) {
    const controller = known[identifier];
    if (!controller) continue;
    const present = presence.get(node)?.get(identifier) ?? new Set<string>();
    for (const required of controller.requiredTargets) {
      if (!present.has(required)) {
        push(
          diagnostics,
          "missing-required-target",
          "error",
          `"${identifier}" is missing required target "${required}".`,
          node,
        );
      }
    }
  }

  // --- Stage 3: accessibility (ARIA) per scope -----------------------------
  for (const { node, identifier } of scopes) {
    const controller = known[identifier];
    if (!controller) continue;
    for (const req of controller.a11y) {
      // The root scope ("") is the controller element; otherwise the target's
      // own element(s). Targets that are absent are stage 2's concern, not ours
      // — we only judge accessibility of markup that is actually present.
      const elements =
        req.target === ""
          ? [node]
          : (targetNodes.get(node)?.get(identifier)?.get(req.target) ?? []);
      for (const el of elements) {
        checkA11y(diagnostics, el, identifier, req);
      }
    }
  }

  diagnostics.sort((a, b) => a.line - b.line || a.column - b.column);
  return diagnostics;
}

/**
 * Checks one accessibility requirement against a present element: at least one
 * candidate attribute must exist, and (when constrained) carry an allowed value.
 */
function checkA11y(
  out: Diagnostic[],
  el: ElementNode,
  identifier: string,
  req: A11yRequirement,
): void {
  const present = req.attrs
    .map((name) => el.attrs.find((a) => a.name === name))
    .filter((a): a is ParsedAttr => a !== undefined);
  const where = req.target === "" ? "scope element" : `"${req.target}" target`;

  if (present.length === 0) {
    push(
      out,
      "missing-aria",
      "error",
      `"${identifier}" requires ${describeAttrs(req.attrs)} on its ${where}.`,
      el,
      req.suggestion,
    );
    return;
  }
  if (!req.values) return;
  for (const attr of present) {
    if (!req.values.includes(attr.value.trim())) {
      // The attribute exists but holds a wrong value, so the rule's "Add …"
      // suggestion would mislead — point at the value fix instead.
      push(
        out,
        "invalid-aria-value",
        "error",
        `${attr.name}="${attr.value}" is not valid on the ${where} of "${identifier}". Expected ${list(req.values)}.`,
        attr,
        `Set ${attr.name} to ${list(req.values)}.`,
      );
    }
  }
}

/** Climbs the ancestor chain (including `node`) for the nearest owning scope. */
function findOwner(node: ElementNode, identifier: string): ElementNode | null {
  let current: ElementNode | null = node;
  while (current && current.tag !== "#root") {
    const dataController = current.attrs.find((a) => a.name === "data-controller");
    if (dataController && controllerIdentifiers(dataController.value).includes(identifier)) {
      return current;
    }
    current = current.parent;
  }
  return null;
}

/** Appends a diagnostic positioned at the given source location. */
function push(
  out: Diagnostic[],
  code: DiagnosticCode,
  severity: DiagnosticSeverity,
  message: string,
  at: { line: number; column: number },
  suggestion?: string,
): void {
  out.push({ code, severity, message, line: at.line, column: at.column, suggestion });
}

/** Formats a name list for human-readable messages. */
function list(names: readonly string[]): string {
  return names.length > 0 ? names.map((n) => `"${n}"`).join(", ") : "(none)";
}

/** Describes a set of "any of" attributes, e.g. `aria-labelledby or aria-label`. */
function describeAttrs(attrs: readonly string[]): string {
  return attrs.length === 1 ? (attrs[0] as string) : attrs.join(" or ");
}

/**
 * Stage-4 typo suggestion: returns `Did you mean "x"?` for the nearest known
 * name when it is close enough to be a plausible misspelling, else undefined.
 * The threshold scales with name length but is capped, so unrelated names never
 * produce a misleading "did you mean".
 */
function didYouMean(name: string, candidates: readonly string[]): string | undefined {
  if (name.length === 0) return undefined;
  let best: string | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const distance = levenshtein(name, candidate);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  const threshold = Math.min(3, Math.floor(name.length / 2) + 1);
  return best !== undefined && bestDistance <= threshold ? `Did you mean "${best}"?` : undefined;
}

/** Classic dynamic-programming Levenshtein edit distance. */
function levenshtein(a: string, b: string): number {
  const rows = a.length;
  const cols = b.length;
  if (rows === 0) return cols;
  if (cols === 0) return rows;
  let prev = Array.from({ length: cols + 1 }, (_, j) => j);
  for (let i = 1; i <= rows; i++) {
    const curr = [i];
    for (let j = 1; j <= cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        (curr[j - 1] as number) + 1,
        (prev[j] as number) + 1,
        (prev[j - 1] as number) + cost,
      );
    }
    prev = curr;
  }
  return prev[cols] as number;
}

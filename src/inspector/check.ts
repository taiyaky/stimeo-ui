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
import {
  type A11yAlternative,
  type A11yRequirement,
  type ContentCondition,
  DIAGNOSTIC_CODES,
  type Diagnostic,
  type DiagnosticCode,
  type DiagnosticFix,
  type DiagnosticSeverity,
  type DocumentCondition,
  type ElementCondition,
  type Manifest,
  type ValueCondition,
} from "./types";

/**
 * The core Inspector engine: checks a single HTML/ERB source string against the
 * manifest and returns diagnostics. It is **input-path agnostic** — the same
 * function backs both the project's own contract checks and the user-facing CLI.
 *
 * The check runs in staged passes:
 * - **Stage 1 (names/spelling):** every `stimeo--*` controller, target, value,
 *   and `data-action` controller **and method** must exist in the manifest.
 * - **Stage 2 (structure):** required targets must be present within their
 *   controller scope, and targets must have an owning controller.
 * - **Stage 3 (accessibility):** ARIA the controller relies on but does not set
 *   itself (e.g. a dialog's `role`/`aria-modal`/name) must be present on the
 *   relevant target, with the expected value (alternative groups via `or`), and
 *   optionally only in one configuration of the controller's own value.
 *   Sibling passes extend it: **keyboard prerequisites** (declared targets must
 *   be focusable), **managed-aria** (author-futile attributes the controller
 *   owns draw warnings), **composition** (value alignment with a co-located
 *   companion), **required companions** (a delegated-to controller must be
 *   present at all), **target declarations** (markup carrying a pattern's role
 *   must be a declared target — the one rule family that reads
 *   attribute → target rather than the reverse), **cardinality** (set-level
 *   count bounds per scope or container), and **idref resolution** (ARIA
 *   reference attributes on scope/target elements must point at an id declared
 *   in the same file — a *warning*, since a reference may legitimately cross a
 *   partial boundary the checker cannot see).
 * - **Stage 4 (fix suggestions):** diagnostics carry a `suggestion` — the
 *   nearest known name for a likely typo, or the exact ARIA to add.
 *
 * Any element may opt out via {@link IGNORE_ATTR} (`data-stimeo-ignore`): an
 * empty value suppresses every diagnostic anchored at the element or its
 * descendants; a whitespace-separated {@link DiagnosticCode} list narrows the
 * suppression to those codes. Unknown codes in the list are themselves
 * reported (`unknown-ignore-code`, never suppressible).
 *
 * @remarks
 * Scope is resolved within a single source string. A controller and its targets
 * split across separate Rails partials cannot be correlated, so stage-2 checks
 * assume self-contained markup (Stimeo's recommended demo/partial structure).
 * Server-rendered **fragments** — markup a controller fetches and appends at
 * runtime (Turbo Streams, incrementally loaded list pages) — are the
 * legitimate exception:
 * declare the runtime host with {@link FRAGMENT_ATTR} on the fragment root and
 * `orphan-target` is suppressed for that identifier (names are still checked).
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

  /** `[start, end)` offsets of every ERB tag in the raw source. */
  const erbRanges = [...source.matchAll(/<%[\s\S]*?%>/g)].map(
    (m) => [m.index ?? 0, (m.index ?? 0) + m[0].length] as const,
  );

  /**
   * Whether the attribute's value text was (even partially) ERB-generated.
   * Neutralization preserves offsets, so the parser's value range maps 1:1
   * onto the raw source.
   */
  const isDynamicValue = (attr: ParsedAttr): boolean => {
    const { valueStart, valueEnd } = attr;
    if (valueStart === undefined || valueEnd === undefined) return false;
    return erbRanges.some(([start, end]) => start < valueEnd && end > valueStart);
  };

  /**
   * Whether a rule's self-value condition holds for this scope, reading the
   * host's **effective** value (the authored attribute, or the rule's declared
   * default when absent). An unconditional rule always holds.
   *
   * Returns `null` when the host value is ERB-generated: the condition is then
   * undecidable, and the caller skips the rule rather than guessing at which
   * configuration the page will render in.
   */
  const conditionHolds = (
    scope: ElementNode,
    identifier: string,
    when: ValueCondition | undefined,
  ): boolean | null => {
    if (!when) return true;
    const hostAttr = scope.attrs.find(
      (a) => a.name === `data-${identifier}-${dasherize(when.value)}-value`,
    );
    if (hostAttr && isDynamicValue(hostAttr)) return null;
    return when.equals.includes(hostAttr ? hostAttr.value.trim() : when.default);
  };

  /** True when `node` or an ancestor opts out of `code` via the ignore attr. */
  const suppressed = (node: ElementNode, code: DiagnosticCode): boolean => {
    if (code === "unknown-ignore-code") return false; // meta-diagnostic: never suppressible
    let current: ElementNode | null = node;
    while (current && current.tag !== "#root") {
      const ignore = current.attrs.find((a) => a.name === IGNORE_ATTR);
      if (ignore) {
        const codes = ignore.value.trim();
        if (codes.length === 0 || codes.split(/\s+/).includes(code)) return true;
      }
      current = current.parent;
    }
    return false;
  };

  /** Suppression-aware diagnostic sink; `owner` anchors the ignore lookup. */
  const report: Reporter = (owner, code, severity, message, at, suggestion, fix): void => {
    if (!suppressed(owner, code)) push(diagnostics, code, severity, message, at, suggestion, fix);
  };

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

  /**
   * Whether a rule's content condition holds for one element: how many of a
   * target the element itself holds. Unlike {@link conditionHolds} — which asks
   * about the scope's configuration — this is per element, so sibling targets
   * are judged independently. An unconditional rule always holds.
   *
   * Targets are counted from their declarations, so an ERB-generated target
   * *name* leaves an element uncounted. That biases the count downward, the
   * same direction the rest of the engine takes: the stage-2 required-target
   * check already reports such markup, so the miscount is not silent.
   */
  const contentHolds = (
    scope: ElementNode,
    identifier: string,
    element: ElementNode,
    condition: ContentCondition | undefined,
  ): boolean => {
    if (!condition) return true;
    const nodes = targetNodes.get(scope)?.get(identifier)?.get(condition.target) ?? [];
    let held = 0;
    for (const node of nodes) if (isWithin(node, element)) held += 1;
    if (condition.min !== undefined && held < condition.min) return false;
    if (condition.max !== undefined && held > condition.max) return false;
    return true;
  };

  /**
   * Whether the element's own tag leaves a requirement armed. A tag that names
   * the role natively — `<table>`/`<caption>`, `<fieldset>`/`<legend>`,
   * `<input>`/`<label for>` — disarms it, because the author has a correct
   * spelling that carries no ARIA at all and flagging it would be a false
   * positive. Unconditional requirements always hold.
   */
  const elementHolds = (element: ElementNode, condition: ElementCondition | undefined): boolean =>
    !condition?.exceptTags.includes(element.tag);

  /**
   * How many elements in this file carry each role, tallied during the walk
   * below. It backs {@link DocumentCondition}, whose question — "is there more
   * than one of these?" — no per-element or per-scope view can answer.
   *
   * ERB-generated role values are left out: `role="<%= … %>"` could render as
   * anything, and counting it would escalate a requirement on a guess. Missing
   * one therefore under-counts, which can only *fail* to escalate — never
   * escalate wrongly.
   */
  const roleTally = new Map<string, number>();

  /**
   * The same tally restricted to Tab-reachable elements, for the conditions
   * ARIA qualifies by focusability. Kept as a second map rather than a filter
   * at query time because the walk is the only place the elements are in hand.
   */
  const focusableRoleTally = new Map<string, number>();

  /** Whether a file-level condition holds; absent conditions never escalate. */
  const documentHolds = (condition: DocumentCondition | undefined): boolean => {
    if (condition === undefined) return false;
    const tally = condition.focusable ? focusableRoleTally : roleTally;
    return (tally.get(condition.role) ?? 0) >= condition.atLeast;
  };

  /**
   * Attribute names any target-declaration rule matches on (e.g. `role`).
   * Collected up front so the reverse-direction pass can work from a single
   * shortlist gathered during this walk, instead of re-walking the tree once
   * per scope and rule.
   */
  const declarationAttrs = new Set<string>();
  for (const controller of Object.values(known)) {
    for (const rule of controller.targetDeclarations) declarationAttrs.add(rule.attr);
  }
  /** Elements carrying at least one {@link declarationAttrs} attribute. */
  const declarationCandidates: ElementNode[] = [];

  walk(tree, (node) => {
    if (declarationAttrs.size > 0 && node.attrs.some((a) => declarationAttrs.has(a.name))) {
      declarationCandidates.push(node);
    }
    const roleAttr = node.attrs.find((a) => a.name === "role");
    if (roleAttr && !isDynamicValue(roleAttr)) {
      const role = roleAttr.value.trim();
      roleTally.set(role, (roleTally.get(role) ?? 0) + 1);
      if (isFocusable(node, "tab")) {
        focusableRoleTally.set(role, (focusableRoleTally.get(role) ?? 0) + 1);
      }
    }
    for (const attr of node.attrs) {
      // --- suppression declaration: data-stimeo-ignore ---------------------
      if (attr.name === IGNORE_ATTR) {
        // Spell-check the code list so a typo'd suppression cannot silently
        // fail open. Reported directly: this meta-diagnostic is unsuppressible.
        for (const token of attr.value.split(/\s+/).filter((t) => t.length > 0)) {
          if (!(DIAGNOSTIC_CODES as readonly string[]).includes(token)) {
            const best = nearestName(token, DIAGNOSTIC_CODES);
            push(
              diagnostics,
              "unknown-ignore-code",
              "warning",
              `Unknown diagnostic code "${token}" in ${IGNORE_ATTR}.`,
              attr,
              asDidYouMean(best),
              tokenFix(attr, token, best),
            );
          }
        }
        continue;
      }

      // --- fragment declaration: data-stimeo-fragment ----------------------
      if (attr.name === FRAGMENT_ATTR) {
        const identifiers = attr.value.split(/\s+/).filter((token) => token.length > 0);
        if (identifiers.length === 0) {
          report(
            node,
            "unknown-controller",
            "error",
            `"${FRAGMENT_ATTR}" must name the fragment's runtime host controller(s).`,
            attr,
          );
        }
        for (const identifier of identifiers) {
          if (!(identifier in known)) {
            const best = nearestName(identifier, knownIdentifiers);
            report(
              node,
              "unknown-controller",
              "error",
              `Fragment declaration references unknown Stimeo controller "${identifier}".`,
              attr,
              asDidYouMean(best),
              tokenFix(attr, identifier, best),
            );
          }
        }
        continue;
      }

      // --- data-controller -------------------------------------------------
      if (attr.name === "data-controller") {
        for (const identifier of controllerIdentifiers(attr.value)) {
          if (identifier in known) {
            scopes.push({ node, identifier });
          } else {
            const best = nearestName(identifier, knownIdentifiers);
            report(
              node,
              "unknown-controller",
              "error",
              `Unknown Stimeo controller "${identifier}".`,
              attr,
              asDidYouMean(best),
              tokenFix(attr, identifier, best),
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
          report(
            node,
            "unknown-controller",
            "error",
            `Target attribute "${attr.name}" references unknown Stimeo controller "${targetIdentifier}".`,
            attr,
            didYouMean(targetIdentifier, knownIdentifiers),
          );
          continue;
        }
        // Neutralization blanks the ERB tag in place, so a partly generated
        // name reads as its literal remnant (`<%= p %>item` → "item"). Taking
        // that reading would both silence the spelling check and register a
        // target the runtime never resolves — the same fabrication the
        // cardinality count avoids. Undecidable, exactly like a fully generated
        // name, whose blanked value already falls through the guards below.
        const targetName = isDynamicValue(attr) ? "" : attr.value.trim();
        if (targetName.length > 0 && !controller.targets.includes(targetName)) {
          const best = nearestName(targetName, controller.targets);
          report(
            node,
            "unknown-target",
            "error",
            `Unknown target "${targetName}" for "${targetIdentifier}". Known targets: ${list(controller.targets)}.`,
            attr,
            asDidYouMean(best),
            tokenFix(attr, targetName, best),
          );
        }
        const owner = findOwner(node, targetIdentifier);
        if (owner) {
          if (targetName.length > 0) {
            recordPresence(owner, targetIdentifier, targetName);
            recordTargetNode(owner, targetIdentifier, targetName, node);
          }
        } else if (!inDeclaredFragment(node, targetIdentifier)) {
          report(
            node,
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
            report(
              node,
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
              report(
                node,
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
            const best = nearestName(identifier, knownIdentifiers);
            report(
              node,
              "unknown-action-controller",
              "error",
              `Action references unknown Stimeo controller "${identifier}".`,
              attr,
              asDidYouMean(best),
              tokenFix(attr, identifier, best),
            );
          } else if (method.length > 0 && !controller.actions.includes(method)) {
            const best = nearestName(method, controller.actions);
            report(
              node,
              "unknown-action-method",
              "error",
              `Unknown action "${method}" for "${identifier}". Known actions: ${list(controller.actions)}.`,
              attr,
              asDidYouMean(best),
              tokenFix(attr, method, best),
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
        report(
          node,
          "missing-required-target",
          "error",
          `"${identifier}" is missing required target "${required}".`,
          node,
        );
      }
    }
  }

  // --- Stage 2: conditional targets per scope ------------------------------
  // A feature that is opt-in but incomplete without its whole set. Judged from the
  // *presence* set rather than the element set: the question is only whether the
  // author declared the target anywhere in this scope.
  for (const { node, identifier } of scopes) {
    const controller = known[identifier];
    if (!controller) continue;
    const present = presence.get(node)?.get(identifier) ?? new Set<string>();
    for (const rule of controller.conditionalTargets) {
      if (!present.has(rule.whenPresent)) continue;
      const missing = rule.require.filter((target) => !present.has(target));
      if (missing.length === 0) continue;
      report(
        node,
        "missing-conditional-target",
        "error",
        `"${identifier}" has a "${rule.whenPresent}" target, which also requires ${list(missing)}.`,
        node,
        rule.suggestion,
      );
    }
  }

  // --- Stage 3: accessibility (ARIA) per scope -----------------------------
  for (const { node, identifier } of scopes) {
    const controller = known[identifier];
    if (!controller) continue;
    for (const req of controller.a11y) {
      // A conditional requirement only exists in the configuration it names —
      // outside it the attribute is not merely optional but wrong, so an
      // undecidable or unmet condition must skip the requirement entirely.
      if (conditionHolds(node, identifier, req.when) !== true) continue;
      // The root scope ("") is the controller element; otherwise the target's
      // own element(s). Targets that are absent are stage 2's concern, not ours
      // — we only judge accessibility of markup that is actually present.
      const elements =
        req.target === ""
          ? [node]
          : (targetNodes.get(node)?.get(identifier)?.get(req.target) ?? []);
      // A file-level precondition arms the requirement at all; without it the
      // markup is complete as written, so nothing below should run.
      if (req.whenDocument && !documentHolds(req.whenDocument)) continue;
      // Escalation is a property of the file, not of any one element, so it is
      // resolved once per requirement rather than per element.
      const severity: DiagnosticSeverity = documentHolds(req.escalateWhen)
        ? "error"
        : (req.severity ?? "error");
      for (const el of elements) {
        // Contents are judged per element: two sibling menus of one menubar can
        // legitimately disagree about whether the requirement applies to them.
        if (!contentHolds(node, identifier, el, req.whenContains)) continue;
        // So is the tag: one file can spell the same role both natively and
        // with a div, and only the div needs the author to supply a name.
        if (!elementHolds(el, req.whenElement)) continue;
        checkA11y(report, el, identifier, req, severity);
      }
    }
  }

  // --- Stage 3: keyboard prerequisites per scope ---------------------------
  // Declared targets whose contract makes the author responsible for
  // focusability must be natively focusable or carry tabindex/contenteditable.
  for (const { node, identifier } of scopes) {
    const controller = known[identifier];
    if (!controller) continue;
    for (const req of controller.keyboard) {
      const reach = req.reach ?? "tab";
      const elements = targetNodes.get(node)?.get(identifier)?.get(req.target) ?? [];
      for (const el of elements) {
        if (!isFocusable(el, reach)) {
          const problem =
            reach === "tab"
              ? 'not in the Tab order (needs a native control or tabindex="0")'
              : "not focusable (needs a native control or tabindex)";
          report(
            el,
            "keyboard-inaccessible",
            "error",
            `The "${req.target}" target of "${identifier}" is ${problem}.`,
            el,
            req.suggestion,
          );
        }
      }
    }
  }

  // --- Stage 3: author-futile (controller-managed) attributes --------------
  for (const { node, identifier } of scopes) {
    const controller = known[identifier];
    if (!controller) continue;
    for (const rule of controller.managedAria) {
      const elements =
        rule.target === ""
          ? [node]
          : (targetNodes.get(node)?.get(identifier)?.get(rule.target) ?? []);
      const where = rule.target === "" ? "scope element" : `"${rule.target}" target`;
      for (const el of elements) {
        for (const name of rule.attrs) {
          const attr = el.attrs.find((a) => a.name === name);
          if (!attr) continue;
          report(
            el,
            "managed-aria",
            "warning",
            `${name} on the ${where} of "${identifier}" is managed by the controller at runtime.`,
            attr,
            rule.suggestion,
          );
        }
      }
    }
  }

  // --- Stage 3: attributes forbidden by the surrounding markup -------------
  // The pass above reports attributes the *controller* owns; this one reports
  // attributes the author owns that contradict what is around them — required
  // in one configuration of the element's contents and wrong in the other.
  // Warning severity, because one file at one instant cannot tell a stale
  // declaration from a genuinely in-progress one.
  for (const { node, identifier } of scopes) {
    const controller = known[identifier];
    if (!controller) continue;
    for (const rule of controller.forbiddenAria) {
      const elements =
        rule.target === ""
          ? [node]
          : (targetNodes.get(node)?.get(identifier)?.get(rule.target) ?? []);
      const where = rule.target === "" ? "scope element" : `"${rule.target}" target`;
      for (const el of elements) {
        if (!contentHolds(node, identifier, el, rule.whenContains)) continue;
        for (const name of rule.attrs) {
          const attr = el.attrs.find((a) => a.name === name);
          if (!attr) continue;
          // An ERB-generated value could render to anything, so a rule that
          // names specific values cannot decide it. A rule forbidding the
          // attribute outright still can: presence is static.
          if (rule.values && (isDynamicValue(attr) || !rule.values.includes(attr.value.trim()))) {
            continue;
          }
          report(
            el,
            "forbidden-aria",
            "warning",
            `${name} on the ${where} of "${identifier}" contradicts the markup around it.`,
            attr,
            rule.suggestion,
          );
        }
      }
    }
  }

  // --- Stage 3: cross-controller composition values ------------------------
  // Value-alignment contracts between a host controller and a co-located
  // companion (e.g. sortable's sort axis vs roving's orientation). Both sides
  // are judged by their *effective* value — the authored attribute, or the
  // rule's declared default when absent — because these contracts exist
  // precisely where the companion's default does not match the host's. An
  // ERB-generated value on either side makes the rule undecidable, so it is
  // skipped rather than guessed at.
  for (const { node, identifier } of scopes) {
    const controller = known[identifier];
    if (!controller) continue;
    for (const rule of controller.compositions) {
      const targeted = targetNodes.get(node)?.get(identifier)?.get(rule.target);
      // An absent optional container target falls back to the scope element
      // when the rule says the runtime does the same (e.g. sortable's `list`).
      const elements =
        rule.target === "" ? [node] : (targeted ?? (rule.fallbackToScope ? [node] : []));
      const where = rule.target === "" || !targeted ? "scope element" : `"${rule.target}" target`;
      const when = rule.when;
      if (conditionHolds(node, identifier, when) !== true) continue;
      const hostContext = when ? ` (${when.value} ${list(when.equals)})` : "";
      for (const el of elements) {
        const declared = el.attrs.find((a) => a.name === "data-controller");
        if (!declared || !controllerIdentifiers(declared.value).includes(rule.coController)) {
          continue;
        }
        const coAttrName = `data-${rule.coController}-${dasherize(rule.require.value)}-value`;
        const coAttr = el.attrs.find((a) => a.name === coAttrName);
        if (coAttr && isDynamicValue(coAttr)) continue;
        const effective = coAttr ? coAttr.value.trim() : rule.require.default;
        if (rule.require.oneOf.includes(effective)) continue;
        const [canonical] = rule.require.oneOf;
        if (!coAttr) {
          report(
            el,
            "composition-mismatch",
            "error",
            `"${identifier}"${hostContext} requires the co-located "${rule.coController}" on its ${where} to set ${coAttrName} to ${list(rule.require.oneOf)} (its default is "${rule.require.default}").`,
            el,
            rule.suggestion,
          );
        } else {
          report(
            el,
            "composition-mismatch",
            "error",
            `${coAttrName}="${coAttr.value}" on the ${where} of "${identifier}"${hostContext} must be ${list(rule.require.oneOf)}.`,
            coAttr,
            rule.suggestion,
            canonical !== undefined
              ? valueFix(coAttr, canonical, `Set ${coAttrName} to "${canonical}"`)
              : undefined,
          );
        }
      }
    }
  }

  // --- Stage 3: required companion controllers -----------------------------
  // The mirror image of the composition pass: that one guards *how* a
  // co-located companion is configured and stays silent when it was never
  // added, which is right for optional compositions and blind to the mandatory
  // ones. Here the companion carries behavior the host never implements, so its
  // absence is the failure — reported on the element that should have declared
  // it. An ERB-generated `data-controller` is undecidable and skipped.
  for (const { node, identifier } of scopes) {
    const controller = known[identifier];
    if (!controller) continue;
    for (const rule of controller.companions) {
      const elements =
        rule.target === ""
          ? [node]
          : (targetNodes.get(node)?.get(identifier)?.get(rule.target) ?? []);
      const where = rule.target === "" ? "scope element" : `"${rule.target}" target`;
      for (const el of elements) {
        const declared = el.attrs.find((a) => a.name === "data-controller");
        if (declared && isDynamicValue(declared)) continue;
        if (declared && controllerIdentifiers(declared.value).includes(rule.controller)) continue;
        report(
          el,
          "missing-companion",
          "error",
          `The ${where} of "${identifier}" must also declare "${rule.controller}" in data-controller.`,
          declared ?? el,
          rule.suggestion,
          // Appending to an existing list is unambiguous; creating the
          // attribute from nothing is an insertion the anchor cannot express.
          declared
            ? valueFix(
                declared,
                `${declared.value.trim()} ${rule.controller}`.trim(),
                `Add "${rule.controller}" to data-controller`,
              )
            : undefined,
        );
      }
    }
  }

  // --- Stage 3: reverse-direction target declarations ----------------------
  // Elements that wear the pattern's role but were never declared as a target.
  // Every forward rule reads the controller's target set, so this is the one
  // failure they structurally cannot see: to them the element does not exist,
  // while assistive technology announces it as part of the widget. Ownership
  // goes to the *nearest* enclosing controller of the same identifier, so
  // nested instances judge only their own subtree.
  for (const { node, identifier } of scopes) {
    const controller = known[identifier];
    if (!controller) continue;
    if (controller.targetDeclarations.length === 0) continue;
    const targetAttrName = `data-${identifier}-target`;
    for (const rule of controller.targetDeclarations) {
      for (const el of declarationCandidates) {
        const marker = el.attrs.find((a) => a.name === rule.attr);
        if (!marker || isDynamicValue(marker)) continue;
        const value = marker.value.trim();
        if (value.length === 0) continue;
        if (rule.values && !rule.values.includes(value)) continue;
        if (findOwner(el, identifier) !== node) continue;
        const declaredAs = el.attrs.find((a) => a.name === targetAttrName);
        if (declaredAs && !isDynamicValue(declaredAs) && declaredAs.value.trim() === rule.target) {
          continue;
        }
        if (declaredAs && isDynamicValue(declaredAs)) continue;
        report(
          el,
          "undeclared-target",
          "error",
          `${rule.attr}="${value}" inside "${identifier}" is not declared as its "${rule.target}" target, so the controller never manages it.`,
          marker,
          rule.suggestion,
        );
      }
    }
  }

  // --- Stage 3: set-level cardinality --------------------------------------
  // Counts, not per-element judgements: "exactly one trigger in this wrapper",
  // "at most one selected option". Both failures are silent at runtime — the
  // first extra element is either ignored forever or normalized away on connect
  // — so the authored source is the only place the mistake is still visible.
  // Counting follows the runtime's own ownership rule: the Stimulus target set.
  for (const { node, identifier } of scopes) {
    const controller = known[identifier];
    if (!controller) continue;
    for (const rule of controller.cardinality) {
      if (conditionHolds(node, identifier, rule.when) !== true) continue;
      const byName = targetNodes.get(node)?.get(identifier);
      const counted = byName?.get(rule.target) ?? [];
      const containers = rule.within === "" ? [node] : (byName?.get(rule.within) ?? []);
      const what = describeCounted(rule.target, rule.attr, rule.values);
      const where = rule.within === "" ? "controller scope" : `"${rule.within}" target`;
      for (const container of containers) {
        // Counted by their *literal* markup. A rule that pins specific values
        // skips any ERB-touched one: neutralization blanks the tag in place, so
        // reading what is left would take `<%= prefix %>true` for a literal
        // "true" and invent a match the rendering may never produce. Dropping
        // it under-counts instead, which can only hide a violation, never
        // fabricate one. A rule that merely requires the attribute counts it
        // either way, and correctly so: presence is static even when the value
        // is not. Either way the literal elements stand on their own, so a
        // definite over-count among them is still reported rather than waved
        // off as undecidable — `aria-selected="<%= … %>"` is ordinary Rails,
        // and letting one sibling switch the whole rule off would leave it
        // firing on almost no real markup.
        const matched: Array<{ el: ElementNode; at: Anchor }> = [];
        for (const el of counted) {
          if (!isWithin(el, container)) continue;
          if (rule.attr === undefined) {
            matched.push({ el, at: el });
            continue;
          }
          const attr = el.attrs.find((a) => a.name === rule.attr);
          if (!attr) continue;
          if (rule.values && (isDynamicValue(attr) || !rule.values.includes(attr.value.trim()))) {
            continue;
          }
          matched.push({ el, at: attr });
        }
        if (rule.max !== undefined && matched.length > rule.max) {
          // Anchored on the elements *past* the limit: the ones the runtime
          // drops. The first `max` are the selection the page will actually
          // show, so pointing at them would name the wrong markup.
          for (const { el, at } of matched.slice(rule.max)) {
            report(
              el,
              "cardinality-violation",
              "error",
              `"${identifier}" allows at most ${rule.max} ${what} per ${where}, but found ${matched.length}.`,
              at,
              rule.suggestion,
            );
          }
        }
        if (rule.min !== undefined && matched.length < rule.min) {
          // Nothing to point at when the count is short, so the container is
          // the anchor — it is also the element the author has to fix.
          report(
            container,
            "cardinality-violation",
            "error",
            `"${identifier}" requires at least ${rule.min} ${what} per ${where}, but found ${matched.length}.`,
            container,
            rule.suggestion,
          );
        }
      }
    }
  }

  // --- Stage 3: ARIA idref resolution --------------------------------------
  // Scope/target elements are where the rules above push authors to write
  // reference attributes; a token that resolves to no id in the same file is
  // (at best) split across partials and (at worst) a typo that silently
  // empties an accessible name. Warning severity: only this file is visible.
  const ids = new Set<string>();
  walk(tree, (node) => {
    const id = node.attrs.find((a) => a.name === "id");
    if (!id || isDynamicValue(id)) return;
    const value = id.value.trim();
    if (value.length > 0 && !/\s/.test(value)) ids.add(value);
  });

  const anchored = new Set<ElementNode>(scopes.map((scope) => scope.node));
  for (const byIdentifier of targetNodes.values()) {
    for (const byName of byIdentifier.values()) {
      for (const els of byName.values()) {
        for (const el of els) anchored.add(el);
      }
    }
  }
  for (const el of anchored) {
    for (const attr of el.attrs) {
      if (!IDREF_ATTRS.has(attr.name) || isDynamicValue(attr)) continue;
      for (const token of attr.value.split(/\s+/).filter((t) => t.length > 0)) {
        if (!ids.has(token)) {
          const best = nearestName(token, [...ids]);
          report(
            el,
            "unresolved-idref",
            "warning",
            `${attr.name} references id "${token}", but no element in this file declares it.`,
            attr,
            asDidYouMean(best),
            tokenFix(attr, token, best),
          );
        }
      }
    }
  }

  diagnostics.sort((a, b) => a.line - b.line || a.column - b.column);
  return diagnostics;
}

/**
 * Where a diagnostic is anchored in the source: an attribute (position of the
 * attribute name) or an element (position of the tag's `<`). Knowing which of
 * the two it is lets {@link push} derive the anchored token's length.
 */
type Anchor = ParsedAttr | ElementNode;

/** Suppression-aware diagnostic sink bound to a source's ignore declarations. */
type Reporter = (
  owner: ElementNode,
  code: DiagnosticCode,
  severity: DiagnosticSeverity,
  message: string,
  at: Anchor,
  suggestion?: string,
  fix?: DiagnosticFix,
) => void;

/**
 * Checks one accessibility requirement against a present element. The base
 * `attrs`/`values` pair and each `or` alternative are alternatives (OR): the
 * requirement is met when at least one candidate attribute is present.
 *
 * Value checking is resolved **per attribute name** by unioning the allowed
 * values across every group that lists that name — so a value valid in *any*
 * of its groups is accepted (a group without `values` accepts anything). This
 * matters when the same attribute appears in more than one group: a value
 * that is valid in one group must not be flagged just because another group
 * lists a different set. Distinct attributes still stand alone, so an authored
 * `aria-live="off"` is flagged even next to a valid `role="status"`.
 *
 * `severity` applies to the **missing** case only. A present attribute holding
 * a value the rule rejects stays an `error` whatever level the requirement
 * carries: the author demonstrably meant to satisfy the rule and got it wrong,
 * which is a definite defect, not the "could be clearer" the recommended level
 * describes. This is the same reasoning that reports an invalid value even when
 * another `or` group is already satisfied.
 */
function checkA11y(
  report: Reporter,
  el: ElementNode,
  identifier: string,
  req: A11yRequirement,
  severity: DiagnosticSeverity,
): void {
  const groups: readonly A11yAlternative[] = [
    { attrs: req.attrs, values: req.values },
    ...(req.or ?? []),
  ];
  const where = req.target === "" ? "scope element" : `"${req.target}" target`;

  // Per attribute name: the union of allowed values across the groups that
  // list it (`anyValue` when some group leaves the value unconstrained).
  const allowedByAttr = new Map<string, { anyValue: boolean; values: Set<string> }>();
  for (const group of groups) {
    for (const name of group.attrs) {
      let entry = allowedByAttr.get(name);
      if (!entry) {
        entry = { anyValue: false, values: new Set() };
        allowedByAttr.set(name, entry);
      }
      if (!group.values) entry.anyValue = true;
      else for (const value of group.values) entry.values.add(value);
    }
  }

  const invalid: Array<{ attr: ParsedAttr; values: readonly string[] }> = [];
  let anyPresent = false;
  for (const [name, allowed] of allowedByAttr) {
    const attr = el.attrs.find((a) => a.name === name);
    if (!attr) continue;
    anyPresent = true;
    if (!allowed.anyValue && !allowed.values.has(attr.value.trim())) {
      invalid.push({ attr, values: [...allowed.values] });
    }
  }

  if (!anyPresent) {
    // The verb tracks the level: saying "requires" for ARIA's *recommended*
    // names would misreport the contract in the one line most readers act on.
    const verb = severity === "warning" ? "recommends" : "requires";
    report(
      el,
      "missing-aria",
      severity,
      `"${identifier}" ${verb} ${describeAttrs([...allowedByAttr.keys()])} on its ${where}.`,
      el,
      req.suggestion,
    );
    return;
  }
  for (const { attr, values } of invalid) {
    // The attribute exists but holds a wrong value, so the rule's "Add …"
    // suggestion would mislead — point at the value fix instead. When exactly
    // one value is allowed the correction is unambiguous, so emit it as a
    // machine fix too; multi-valued rules stay a human decision.
    const [only] = values;
    report(
      el,
      "invalid-aria-value",
      "error",
      `${attr.name}="${attr.value}" is not valid on the ${where} of "${identifier}". Expected ${list(values)}.`,
      attr,
      `Set ${attr.name} to ${list(values)}.`,
      values.length === 1 && only !== undefined
        ? valueFix(attr, only, `Set ${attr.name} to "${only}"`)
        : undefined,
    );
  }
}

/** Whether `node` is `container` itself or lives inside it. */
function isWithin(node: ElementNode, container: ElementNode): boolean {
  let current: ElementNode | null = node;
  while (current) {
    if (current === container) return true;
    current = current.parent;
  }
  return false;
}

/**
 * Names what a cardinality rule counts, e.g. `"option" targets with
 * aria-selected="true"` — so the diagnostic says which subset the number
 * refers to rather than leaving the reader to infer it from the bound.
 */
function describeCounted(
  target: string,
  attr: string | undefined,
  values: readonly string[] | undefined,
): string {
  if (attr === undefined) return `"${target}" targets`;
  const constrained = values && values.length > 0 ? ` set to ${list(values)}` : "";
  return `"${target}" targets with ${attr}${constrained}`;
}

/** Tags focusable without an authored `tabindex` (input handled separately). */
const NATIVE_FOCUSABLE_TAGS = new Set(["button", "select", "textarea", "summary"]);

/**
 * Whether the tag is natively focusable **as authored**. `input` is focusable
 * *unless* `type="hidden"` (never rendered, never focusable); `a`/`area` are
 * focusable only with an `href`. Deliberately does **not** consider `disabled`,
 * `hidden`, or `inert`: those are usually intentional states, and — crucially —
 * this library's roving contracts keep items inside an ancestor-`hidden`
 * container until opened (a closed `<ul role="menu" hidden>`), so treating them
 * as non-focusable would false-positive on every correct menu.
 */
function isNativelyFocusable(el: ElementNode): boolean {
  if (NATIVE_FOCUSABLE_TAGS.has(el.tag)) return true;
  if (el.tag === "input") {
    const type = (el.attrs.find((a) => a.name === "type")?.value ?? "").trim().toLowerCase();
    return type !== "hidden";
  }
  if (el.tag === "a" || el.tag === "area") return el.attrs.some((a) => a.name === "href");
  return false;
}

/** Parsed integer `tabindex`, or `null` when absent or not a valid integer. */
function tabindexValue(el: ElementNode): number | null {
  const attr = el.attrs.find((a) => a.name === "tabindex");
  if (!attr) return null;
  const parsed = Number.parseInt(attr.value.trim(), 10);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Static focusability floor for the keyboard-prerequisite pass, per the rule's
 * {@link KeyboardRequirement.reach}:
 *
 * - `"tab"`: the element must be in the Tab order — natively focusable /
 *   `contenteditable` with no `tabindex`, or `tabindex >= 0`. A `tabindex="-1"`
 *   (or a present-but-invalid value) fails, catching the "removed from Tab
 *   order" bug a presence-only check would miss.
 * - `"focus"`: the controller focuses it programmatically, so any valid
 *   `tabindex` (including the roving `-1`), a natively focusable element, or
 *   `contenteditable` suffices.
 *
 * Presence-only otherwise — the set-level roving invariant is runtime state.
 */
function isFocusable(el: ElementNode, reach: "tab" | "focus"): boolean {
  const hasTabindex = el.attrs.some((a) => a.name === "tabindex");
  if (hasTabindex) {
    const value = tabindexValue(el);
    if (value === null) return false; // present but invalid → not reliably focusable
    return reach === "tab" ? value >= 0 : true;
  }
  return isNativelyFocusable(el) || isContentEditable(el);
}

/**
 * Whether `contenteditable` makes the element focusable. Bare `contenteditable`
 * / `="true"` / `="plaintext-only"` are editable (focusable); only the explicit
 * `="false"` opts out, so it must not count as focusable.
 */
function isContentEditable(el: ElementNode): boolean {
  const attr = el.attrs.find((a) => a.name === "contenteditable");
  return attr !== undefined && attr.value.trim().toLowerCase() !== "false";
}

/**
 * ARIA attributes whose value is an idref (list); the idref-resolution pass
 * checks each token against the ids declared in the same file.
 */
const IDREF_ATTRS = new Set([
  "aria-activedescendant",
  "aria-controls",
  "aria-describedby",
  "aria-details",
  "aria-errormessage",
  "aria-flowto",
  "aria-labelledby",
  "aria-owns",
]);

/**
 * Opts an element (and its subtree) out of diagnostics: an empty value
 * suppresses everything, a whitespace-separated {@link DiagnosticCode} list
 * suppresses exactly those codes. The escape hatch for the rare markup the
 * static rules cannot see well enough (a reference resolved in another
 * partial, an intentionally exotic composition) — each use is greppable and
 * reviewable. Single-dash namespace like {@link FRAGMENT_ATTR}, so it can
 * never collide with a controller's own attribute namespace.
 */
const IGNORE_ATTR = "data-stimeo-ignore";

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

/**
 * Declares a server-rendered **fragment**: markup a controller fetches and
 * appends at runtime inside its own scope (a Turbo Stream template, an
 * incrementally fetched page of list items). Its value is the runtime host —
 * whitespace-separated `stimeo--*` identifiers. Targets inside the declaration
 * are exempt from `orphan-target` for exactly those identifiers; every name is
 * still spell-checked against the manifest, including the declaration itself.
 * Deliberately single-dash (`data-stimeo-`, not `data-stimeo--`) so it can never
 * collide with a controller's own `data-stimeo--<id>-*` attribute namespace.
 */
const FRAGMENT_ATTR = "data-stimeo-fragment";

/** Whether `node` (or an ancestor) declares itself a fragment of `identifier`. */
function inDeclaredFragment(node: ElementNode, identifier: string): boolean {
  let current: ElementNode | null = node;
  while (current && current.tag !== "#root") {
    const declared = current.attrs.find((a) => a.name === FRAGMENT_ATTR);
    if (declared?.value.split(/\s+/).includes(identifier)) return true;
    current = current.parent;
  }
  return false;
}

/**
 * Length of the token an anchor points at: the attribute name, or the opening
 * `<tag` (the `<` plus the tag name) for element anchors.
 */
function anchorLength(at: Anchor): number {
  return "name" in at ? at.name.length : at.tag.length + 1;
}

/** Appends a diagnostic positioned at the given source location. */
function push(
  out: Diagnostic[],
  code: DiagnosticCode,
  severity: DiagnosticSeverity,
  message: string,
  at: Anchor,
  suggestion?: string,
  fix?: DiagnosticFix,
): void {
  out.push({
    code,
    severity,
    message,
    line: at.line,
    column: at.column,
    length: anchorLength(at),
    suggestion,
    fix,
  });
}

/**
 * Machine fix replacing one occurrence of `token` inside the attribute's
 * value with `replacement`. Returns undefined when there is no replacement,
 * the attribute is boolean (no value offsets), or the token cannot be located
 * verbatim. Uses the first occurrence — a value repeating the same broken
 * token is pathological enough that fixing the first is still the right edit.
 */
function tokenFix(
  attr: ParsedAttr,
  token: string,
  replacement: string | undefined,
): DiagnosticFix | undefined {
  if (replacement === undefined || attr.valueStart === undefined || token.length === 0) {
    return undefined;
  }
  const index = attr.value.indexOf(token);
  if (index < 0) return undefined;
  const start = attr.valueStart + index;
  return {
    start,
    end: start + token.length,
    text: replacement,
    title: `Replace with "${replacement}"`,
  };
}

/** Machine fix replacing the attribute's entire value. */
function valueFix(attr: ParsedAttr, replacement: string, title: string): DiagnosticFix | undefined {
  if (attr.valueStart === undefined || attr.valueEnd === undefined) return undefined;
  return { start: attr.valueStart, end: attr.valueEnd, text: replacement, title };
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
 * Stage-4 typo candidate: the nearest known name when it is close enough to
 * be a plausible misspelling, else undefined. The threshold scales with name
 * length but is capped, so unrelated names never produce a misleading match.
 * Feeds both the human suggestion ({@link didYouMean}) and the machine fix.
 */
function nearestName(name: string, candidates: readonly string[]): string | undefined {
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
  return best !== undefined && bestDistance <= threshold ? best : undefined;
}

/** Formats a {@link nearestName} candidate as the human-readable suggestion. */
function asDidYouMean(best: string | undefined): string | undefined {
  return best === undefined ? undefined : `Did you mean "${best}"?`;
}

/**
 * Stage-4 typo suggestion: `Did you mean "x"?`, or undefined when nothing is
 * close. Exported for the MCP server's `stimeo_controller` unknown-id hint.
 */
export function didYouMean(name: string, candidates: readonly string[]): string | undefined {
  return asDidYouMean(nearestName(name, candidates));
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

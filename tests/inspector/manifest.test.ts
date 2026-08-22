import { describe, expect, it } from "vitest";
import { cableControllers } from "../../src/cable";
import { stimeoControllers } from "../../src/index";
import { a11yRules } from "../../src/inspector/a11y_rules";
import { cardinalityRules } from "../../src/inspector/cardinality_rules";
import { companionRules } from "../../src/inspector/companion_rules";
import { compositionRules } from "../../src/inspector/composition_rules";
import { forbiddenAriaRules } from "../../src/inspector/forbidden_aria_rules";
import { hostRules } from "../../src/inspector/host_rules";
import { keyboardRules } from "../../src/inspector/keyboard_rules";
import { managedAriaRules } from "../../src/inspector/managed_aria_rules";
import { buildManifest, SCHEMA_VERSION } from "../../src/inspector/manifest";
import { isCompatibleManifest } from "../../src/inspector/manifest_io";
import { structureRules } from "../../src/inspector/structure_rules";
import { targetDeclarationRules } from "../../src/inspector/target_declaration_rules";
import type { ContentCondition, ValueCondition } from "../../src/inspector/types";
import { valueConstraintRules } from "../../src/inspector/value_constraint_rules";
import { valueRelationRules } from "../../src/inspector/value_relation_rules";
import { positioningControllers } from "../../src/positioning";

/** Tests for the reflection-based manifest generator. */
describe("buildManifest", () => {
  const manifest = buildManifest("1.2.3");
  // The manifest reflects the zero-dep core plus the opt-in positioning and
  // cable (server-bound) controllers (so `stimeo check` recognizes e.g.
  // stimeo--anchored and stimeo--typing-indicator).
  const allControllers = { ...stimeoControllers, ...positioningControllers, ...cableControllers };

  /** A controller's declared `static values` default, read without instantiating. */
  const valueDefault = (ctor: unknown, name: string): unknown =>
    (ctor as { values?: Record<string, { default?: unknown }> }).values?.[name]?.default;

  it("stamps schema and package versions", () => {
    expect(manifest.schemaVersion).toBe(SCHEMA_VERSION);
    expect(manifest.packageVersion).toBe("1.2.3");
  });

  it("rejects manifests missing the Value-constraint field consumed by the engine", () => {
    expect(isCompatibleManifest(manifest)).toBe(true);
    const legacy = structuredClone(manifest) as unknown as {
      controllers: Record<string, Record<string, unknown>>;
    };
    const slider = legacy.controllers["stimeo--slider"];
    if (slider) delete slider.valueConstraints;
    expect(isCompatibleManifest(legacy)).toBe(false);
  });

  it("requires the schema-v11 Value-relation field when loading a manifest", () => {
    const legacy = structuredClone(manifest) as unknown as {
      controllers: Record<string, Record<string, unknown>>;
    };
    const rangeSlider = legacy.controllers["stimeo--range-slider"];
    if (rangeSlider) delete rangeSlider.valueRelations;
    expect(isCompatibleManifest(legacy)).toBe(false);
  });

  it("requires the schema-v12 required-action field when loading a manifest", () => {
    const legacy = structuredClone(manifest) as unknown as {
      controllers: Record<string, Record<string, unknown>>;
    };
    const separator = legacy.controllers["stimeo--separator"];
    if (separator) delete separator.requiredActions;
    expect(isCompatibleManifest(legacy)).toBe(false);
  });

  it("requires the schema-v10 host-contract field when loading a manifest", () => {
    const legacy = structuredClone(manifest) as unknown as {
      controllers: Record<string, Record<string, unknown>>;
    };
    const switchContract = legacy.controllers["stimeo--switch"];
    if (switchContract) delete switchContract.hosts;
    expect(isCompatibleManifest(legacy)).toBe(false);
  });

  it("includes every core, positioning, and cable controller identifier", () => {
    // Combined builds may merge additional registries, so this shared suite asserts
    // the public registries as a required subset rather than an exact upper bound.
    expect(Object.keys(manifest.controllers)).toEqual(
      expect.arrayContaining(Object.keys(allControllers)),
    );
  });

  it("reflects the opt-in cable controllers (e.g. stimeo--typing-indicator)", () => {
    const typing = manifest.controllers["stimeo--typing-indicator"];
    expect(typing?.targets).toEqual(["input", "status"]);
    expect(typing?.events).toEqual(["change"]);
  });

  it("reflects the opt-in positioning controllers (e.g. stimeo--anchored)", () => {
    const anchored = manifest.controllers["stimeo--anchored"];
    expect(anchored?.targets).toEqual(["anchor", "floating"]);
    expect(anchored?.requiredTargets).toEqual(["anchor", "floating"]);
    expect(anchored?.events).toEqual(["position"]);
    expect(anchored?.actions).toEqual([]);
  });

  it("reflects static targets from the controller classes", () => {
    expect(manifest.controllers["stimeo--menu"]?.targets).toEqual(["trigger", "menu", "item"]);
    expect(manifest.controllers["stimeo--aspect-ratio"]?.targets).toEqual([]);
  });

  it("reflects static value names (camelCase keys)", () => {
    expect(manifest.controllers["stimeo--calendar"]?.values).toContain("weekStart");
    expect(manifest.controllers["stimeo--switch"]?.values).toEqual([]);
    expect(manifest.controllers["stimeo--separator"]?.values).toEqual([
      "orientation",
      "focusable",
      "min",
      "max",
      "step",
      "value",
    ]);
  });

  it("reflects Separator's conditional key binding", () => {
    expect(manifest.controllers["stimeo--separator"]?.requiredActions).toEqual([
      {
        target: "",
        action: "onKeydown",
        eventTypes: ["keydown"],
        when: { value: "focusable", type: "boolean", equals: ["true"], default: "false" },
        suggestion:
          'Add data-action="keydown->stimeo--separator#onKeydown" to the separator element.',
      },
    ]);
  });

  it("reflects the submit-once structured-label and completion contract", () => {
    const submitOnce = manifest.controllers["stimeo--submit-once"];
    expect(submitOnce?.targets).toEqual(["submit", "idle", "busy"]);
    expect(submitOnce?.values).toEqual([
      "announceText",
      "announceReadyText",
      "busyLabel",
      "timeout",
      "restoreFocus",
    ]);
    expect(submitOnce?.actions).toEqual(["cancel", "finish", "start"]);
    expect(submitOnce?.events).toEqual(["start", "end", "reconcile"]);
    const hosts = [{ tag: "button" }, { tag: "input", attr: "type", values: ["submit", "image"] }];
    expect(submitOnce?.conditionalTargets).toEqual([
      {
        whenPresent: "idle",
        require: ["busy"],
        requireSameHost: hosts,
        hostLabel: "submit control",
        suggestion:
          'Add a "busy" target inside the same submit button, or remove the "idle" target and use busyLabel for a plain-text button.',
      },
      {
        whenPresent: "busy",
        require: ["idle"],
        requireSameHost: hosts,
        hostLabel: "submit control",
        suggestion:
          'Add an "idle" target inside the same submit button, or remove the "busy" target and use busyLabel for a plain-text button.',
      },
    ]);
    expect(submitOnce?.actionCompletion).toEqual([
      {
        opens: "start",
        whenTriggeredBy: ["submit"],
        closedBy: ["finish", "cancel"],
        escapeValue: "timeout",
        suggestion:
          'Wire "finish" when the request settles and "cancel" when it never ran, or set a non-zero timeout Value. On a Turbo form drop the "start" action entirely — Turbo\'s own events already drive it.',
      },
    ]);
  });

  it("reflects the multi-select hidden-field and shared-announcement contract", () => {
    expect(manifest.controllers["stimeo--multi-select"]?.targets).toEqual([
      "input",
      "list",
      "option",
      "tags",
      "tag",
      "tagTemplate",
      "label",
      "remove",
      "fields",
    ]);
    expect(manifest.controllers["stimeo--multi-select"]?.values).toEqual([
      "max",
      "name",
      "form",
      "announceText",
      "announceRemovedText",
    ]);
    // Chips display the selection rather than holding it, so the template and
    // its parts are conditional on the author declaring one.
    expect(manifest.controllers["stimeo--multi-select"]?.requiredTargets).toEqual([
      "input",
      "list",
      "tags",
    ]);
    expect(manifest.controllers["stimeo--multi-select"]?.conditionalTargets).toEqual([
      {
        whenPresent: "tagTemplate",
        require: ["tag", "label", "remove"],
        requireInside: true,
        suggestion:
          'Complete the chip template: inside it, it needs a "tag" root, a "label" element for the option text, and a "remove" button. Parts declared outside the template never reach the clone, so no selection can commit.',
      },
    ]);
  });

  it("reflects the complete tags-input template and reconciliation contract", () => {
    expect(manifest.controllers["stimeo--tags-input"]?.targets).toEqual([
      "input",
      "tags",
      "tag",
      "tagTemplate",
      "label",
      "remove",
      "fields",
    ]);
    // The template is mandatory, and its parts are required *inside* it: a
    // clone only carries what the template contains.
    expect(manifest.controllers["stimeo--tags-input"]?.requiredTargets).toEqual([
      "input",
      "tags",
      "tagTemplate",
    ]);
    expect(manifest.controllers["stimeo--tags-input"]?.conditionalTargets).toEqual([
      {
        whenPresent: "tagTemplate",
        require: ["tag", "label", "remove"],
        requireInside: true,
        suggestion:
          'Complete the chip template: inside it, it needs a "tag" root, a "label" element for the entered text, and a "remove" button. Parts declared outside the template never reach the clone, so no tag can commit.',
      },
    ]);
    expect(manifest.controllers["stimeo--tags-input"]?.events).toEqual([
      "change",
      "reconcile",
      "reject",
    ]);
  });

  it("merges semantic Value constraints and keeps them on declared Values", () => {
    expect(manifest.controllers["stimeo--character-counter"]?.events).toEqual([
      "change",
      "reconcile",
    ]);
    expect(manifest.controllers["stimeo--character-counter"]?.valueConstraints).toEqual([
      {
        value: "max",
        type: "number",
        finite: true,
        greaterThan: -1,
        integer: true,
        suggestion: "Set max to a non-negative integer.",
      },
      {
        value: "warnAt",
        type: "number",
        finite: true,
        greaterThan: -1,
        integer: true,
        suggestion: "Set warnAt to a non-negative integer.",
      },
    ]);
    expect(manifest.controllers["stimeo--slider"]?.valueConstraints).toEqual([
      {
        value: "step",
        type: "number",
        finite: true,
        greaterThan: 0,
        suggestion: "Set step to a finite number greater than 0.",
      },
    ]);
    expect(manifest.controllers["stimeo--range-slider"]?.valueConstraints).toEqual([
      {
        value: "min",
        type: "number",
        finite: true,
        suggestion: "Set min to a finite number.",
      },
      {
        value: "max",
        type: "number",
        finite: true,
        suggestion: "Set max to a finite number.",
      },
      {
        value: "step",
        type: "number",
        finite: true,
        greaterThan: 0,
        suggestion: "Set step to a finite number greater than 0.",
      },
      {
        value: "start",
        type: "number",
        finite: true,
        suggestion: "Set start to a finite number.",
      },
      {
        value: "end",
        type: "number",
        finite: true,
        suggestion: "Set end to a finite number.",
      },
    ]);
    expect(manifest.controllers["stimeo--number-input"]?.valueConstraints).toEqual(
      manifest.controllers["stimeo--slider"]?.valueConstraints,
    );
    expect(manifest.controllers["stimeo--time-picker"]?.valueConstraints).toEqual([
      {
        value: "step",
        type: "number",
        finite: true,
        greaterThan: 0,
        integer: true,
        suggestion: "Set step to a positive integer.",
      },
    ]);
    expect(manifest.controllers["stimeo--separator"]?.valueConstraints).toEqual([
      {
        value: "orientation",
        type: "string",
        allowedValues: ["horizontal", "vertical"],
        suggestion: 'Set orientation to "horizontal" or "vertical".',
      },
      {
        value: "min",
        type: "number",
        finite: true,
        suggestion: "Set min to a finite number.",
      },
      {
        value: "max",
        type: "number",
        finite: true,
        suggestion: "Set max to a finite number.",
      },
      {
        value: "step",
        type: "number",
        finite: true,
        greaterThan: 0,
        suggestion: "Set step to a finite number greater than 0.",
      },
      {
        value: "value",
        type: "number",
        finite: true,
        suggestion: "Set value to a finite number.",
      },
    ]);
    expect(manifest.controllers["stimeo--switch"]?.valueConstraints).toEqual([]);

    for (const [identifier, rules] of Object.entries(valueConstraintRules)) {
      expect(allControllers).toHaveProperty(identifier);
      const values = manifest.controllers[identifier]?.values ?? [];
      for (const rule of rules) expect(values).toContain(rule.value);
    }
  });

  it("merges cross-Value relationships and keeps both sides on declared Values", () => {
    expect(manifest.controllers["stimeo--range-slider"]?.valueRelations).toEqual([
      {
        left: "min",
        operator: "less-than-or-equal",
        right: "max",
        leftDefault: 0,
        rightDefault: 100,
        suggestion: "Set min to a finite number less than or equal to max.",
      },
    ]);
    expect(manifest.controllers["stimeo--separator"]?.valueRelations).toEqual([
      {
        left: "min",
        operator: "less-than-or-equal",
        right: "max",
        leftDefault: 0,
        rightDefault: 100,
        suggestion: "Set min to a finite number less than or equal to max.",
      },
    ]);
    expect(manifest.controllers["stimeo--slider"]?.valueRelations).toEqual([]);

    for (const [identifier, rules] of Object.entries(valueRelationRules)) {
      expect(allControllers).toHaveProperty(identifier);
      const values = manifest.controllers[identifier]?.values ?? [];
      for (const rule of rules) {
        expect(values).toContain(rule.left);
        expect(values).toContain(rule.right);
        expect(Number.isFinite(rule.leftDefault)).toBe(true);
        expect(Number.isFinite(rule.rightDefault)).toBe(true);
      }
    }
  });

  it("reflects static actions, defaulting to [] when undeclared", () => {
    expect(manifest.controllers["stimeo--dialog"]?.actions).toEqual([
      "close",
      "closeOnBackdrop",
      "open",
    ]);
    // aspect-ratio is a passive controller with no public actions.
    expect(manifest.controllers["stimeo--aspect-ratio"]?.actions).toEqual([]);
  });

  it("reflects static events, defaulting to [] when undeclared", () => {
    expect(manifest.controllers["stimeo--switch"]?.events).toEqual(["changed"]);
    // dialog dispatches nothing, so its event surface is empty.
    expect(manifest.controllers["stimeo--dialog"]?.events).toEqual([]);
  });

  it("merges hand-written required targets", () => {
    expect(manifest.controllers["stimeo--menu"]?.requiredTargets).toEqual(["trigger", "menu"]);
    expect(manifest.controllers["stimeo--tabs"]?.requiredTargets).toEqual(["tab", "panel", "list"]);
    expect(manifest.controllers["stimeo--switch"]?.requiredTargets).toEqual([]);
    expect(manifest.controllers["stimeo--avatar"]?.requiredTargets).toEqual([]);
  });

  it("defines exactly one structure rule for every public controller", () => {
    expect(Object.keys(structureRules).sort()).toEqual(Object.keys(allControllers).sort());
  });

  it("declares required targets that the controller actually understands", () => {
    for (const entry of Object.values(manifest.controllers)) {
      for (const required of entry.requiredTargets) {
        expect(entry.targets).toContain(required);
      }
    }
  });

  it("merges hand-written a11y rules, defaulting to [] when undeclared", () => {
    const dialog = manifest.controllers["stimeo--dialog"]?.a11y ?? [];
    expect(dialog.map((r) => r.attrs.join("/"))).toEqual([
      "role",
      "aria-modal",
      "aria-labelledby/aria-label",
    ]);
    expect(dialog[0]?.values).toEqual(["dialog"]);
    expect(
      manifest.controllers["stimeo--tabs"]?.a11y.map(
        (requirement) => `${requirement.target}:${requirement.attrs.join("/")}`,
      ),
    ).toEqual([
      "tab:role",
      "panel:role",
      "list:role",
      "list:aria-labelledby/aria-label",
      "panel:aria-labelledby/aria-label",
    ]);
    // switch sets its own ARIA, so it carries no authoring requirements.
    expect(manifest.controllers["stimeo--switch"]?.a11y).toEqual([]);
    expect(
      manifest.controllers["stimeo--toggle-group"]?.a11y.map(
        (requirement) => `${requirement.target}:${requirement.attrs.join("/")}`,
      ),
    ).toEqual([":role", "item:role", ":aria-labelledby/aria-label"]);
  });

  it("only writes a11y rules for known controllers", () => {
    // Cable controllers carry a11y rules too (e.g. typing-indicator's status
    // live region), so the domain is core + opt-ins, not the core alone.
    for (const id of Object.keys(a11yRules)) {
      expect(allControllers).toHaveProperty(id);
    }
  });

  it("declares a11y requirements on targets the controller actually understands", () => {
    for (const entry of Object.values(manifest.controllers)) {
      for (const req of entry.a11y) {
        // "" is the controller scope element; any other target must be real.
        if (req.target !== "") expect(entry.targets).toContain(req.target);
        expect(req.attrs.length).toBeGreaterThan(0);
        expect(req.suggestion.length).toBeGreaterThan(0);
      }
    }
  });

  it("merges hand-written keyboard rules, defaulting to [] when undeclared", () => {
    const slider = manifest.controllers["stimeo--slider"]?.keyboard ?? [];
    expect(slider.map((req) => `${req.target}:${req.reach}`)).toEqual(["thumb:tab"]);
    // Roving menu items are reached via programmatic focus (reach:"focus").
    const menu = manifest.controllers["stimeo--menu"]?.keyboard ?? [];
    expect(menu.map((req) => `${req.target}:${req.reach}`)).toEqual(["item:focus"]);
    // Roving composites initialize tabindex on connect, so they carry no rule.
    expect(manifest.controllers["stimeo--tabs"]?.keyboard).toEqual([]);
  });

  it("merges hand-written host contracts, defaulting to [] when undeclared", () => {
    expect(manifest.controllers["stimeo--switch"]?.hosts).toEqual([
      {
        target: "",
        mode: "non-interactive-or-button",
        buttonTypes: ["button"],
        suggestion:
          'Use <button type="button">, or move stimeo--switch to a non-interactive host such as <div>.',
      },
    ]);
    expect(manifest.controllers["stimeo--tree-view"]?.hosts).toEqual([
      {
        target: "item",
        mode: "non-interactive",
        suggestion:
          'Place the "item" target on a non-interactive element such as <li> or <div>; put links and buttons inside it.',
      },
    ]);
    expect(manifest.controllers["stimeo--toggle-group"]?.hosts).toEqual([
      {
        target: "item",
        mode: "non-interactive-or-button",
        buttonTypes: ["button"],
        suggestion:
          'Use <button type="button">, or place the "item" target on a non-interactive host such as <div role="button">.',
      },
    ]);
    expect(manifest.controllers["stimeo--radio-group"]?.hosts).toEqual([
      {
        target: "radio",
        mode: "non-interactive-or-button",
        buttonTypes: ["button"],
        suggestion:
          'Use <button type="button">, or place the "radio" target on a non-interactive host such as <div role="radio">.',
      },
    ]);
    expect(manifest.controllers["stimeo--menu"]?.hosts).toEqual([]);
  });

  it("merges hand-written managed-aria rules, defaulting to [] when undeclared", () => {
    const combobox = manifest.controllers["stimeo--combobox"]?.managedAria ?? [];
    expect(combobox.map((rule) => `${rule.target}:${rule.attrs.join("/")}`)).toEqual([
      "input:aria-activedescendant",
      // On a combobox `aria-selected` marks the *active candidate*, which the
      // controller overwrites on connect — the committed value lives in the input.
      "option:aria-selected",
    ]);
    expect(manifest.controllers["stimeo--switch"]?.managedAria).toEqual([]);
  });

  it("declares keyboard / host / managed-aria rules on targets the controller understands", () => {
    for (const entry of Object.values(manifest.controllers)) {
      for (const req of entry.keyboard) {
        expect(entry.targets).toContain(req.target);
        expect(req.suggestion.length).toBeGreaterThan(0);
      }
      for (const rule of entry.hosts) {
        if (rule.target !== "") expect(entry.targets).toContain(rule.target);
        expect(rule.suggestion.length).toBeGreaterThan(0);
        if (rule.mode === "non-interactive-or-button") {
          expect(rule.buttonTypes?.length).toBeGreaterThan(0);
          for (const type of rule.buttonTypes ?? []) expect(type).toBe(type.toLowerCase());
        } else {
          expect(rule.buttonTypes).toBeUndefined();
        }
      }
      for (const rule of entry.managedAria) {
        if (rule.target !== "") expect(entry.targets).toContain(rule.target);
        expect(rule.attrs.length).toBeGreaterThan(0);
        expect(rule.suggestion.length).toBeGreaterThan(0);
      }
    }
  });

  it("only writes keyboard / host / managed-aria / composition rules for known controllers", () => {
    for (const id of [
      ...Object.keys(keyboardRules),
      ...Object.keys(hostRules),
      ...Object.keys(managedAriaRules),
      ...Object.keys(compositionRules),
    ]) {
      expect(stimeoControllers).toHaveProperty(id);
    }
  });

  it("merges hand-written composition rules, defaulting to [] when undeclared", () => {
    const sortable = manifest.controllers["stimeo--sortable"]?.compositions ?? [];
    expect(sortable.map((r) => `${r.target}:${r.coController}:${r.require.value}`)).toEqual([
      "list:stimeo--roving:orientation",
      "list:stimeo--roving:orientation",
      "item:stimeo--pointer-drag:axis",
      "item:stimeo--pointer-drag:axis",
    ]);
    expect(manifest.controllers["stimeo--switch"]?.compositions).toEqual([]);
  });

  it("declares composition rules both sides actually understand", () => {
    for (const entry of Object.values(manifest.controllers)) {
      for (const rule of entry.compositions) {
        if (rule.target !== "") expect(entry.targets).toContain(rule.target);
        expect(manifest.controllers).toHaveProperty(rule.coController);
        if (rule.when) expect(entry.values).toContain(rule.when.value);
        expect(manifest.controllers[rule.coController]?.values).toContain(rule.require.value);
        expect(rule.require.oneOf.length).toBeGreaterThan(0);
        expect(rule.suggestion.length).toBeGreaterThan(0);
      }
    }
  });

  it("keeps composition-rule defaults in sync with the controllers' static values", () => {
    // Composition rules duplicate each side's `static values` default (the
    // engine needs them to judge *absent* attributes); this pins them to the
    // implementation so a changed controller default cannot silently rot the
    // rule — the drift the rules exist to prevent.
    for (const [hostId, rules] of Object.entries(compositionRules)) {
      const host = allControllers[hostId as keyof typeof allControllers];
      expect(host, `unknown host ${hostId}`).toBeDefined();
      for (const rule of rules) {
        const companion = allControllers[rule.coController as keyof typeof allControllers];
        expect(companion, `unknown companion ${rule.coController}`).toBeDefined();
        if (rule.when) expect(valueDefault(host, rule.when.value)).toBe(rule.when.default);
        expect(valueDefault(companion, rule.require.value)).toBe(rule.require.default);
      }
    }
  });

  it("merges hand-written companion rules, defaulting to [] when undeclared", () => {
    const overflow = manifest.controllers["stimeo--overflow-menu"]?.companions ?? [];
    expect(overflow.map((rule) => `${rule.target}:${rule.controller}`)).toEqual([
      "more:stimeo--menu",
    ]);
    expect(manifest.controllers["stimeo--switch"]?.companions).toEqual([]);
  });

  it("merges hand-written target-declaration rules, defaulting to [] when undeclared", () => {
    const tree = manifest.controllers["stimeo--tree-view"]?.targetDeclarations ?? [];
    expect(tree.map((rule) => `${rule.attr}=${rule.values?.join("|")}→${rule.target}`)).toEqual([
      "role=treeitem→item",
    ]);
    expect(manifest.controllers["stimeo--switch"]?.targetDeclarations).toEqual([]);
  });

  it("merges hand-written cardinality rules, defaulting to [] when undeclared", () => {
    const checkbox = manifest.controllers["stimeo--checkbox"]?.cardinality ?? [];
    expect(checkbox.map((rule) => `${rule.target}:${rule.min}-${rule.max}`)).toEqual([
      "parent:undefined-1",
    ]);
    const formField = manifest.controllers["stimeo--form-field"]?.cardinality ?? [];
    expect(formField.map((rule) => `${rule.target}:${rule.min}-${rule.max}`)).toEqual([
      "control:undefined-1",
    ]);
    const nav = manifest.controllers["stimeo--navigation-menu"]?.cardinality ?? [];
    expect(nav.map((rule) => `${rule.within}:${rule.target}:${rule.min}-${rule.max}`)).toEqual([
      "hoverArea:trigger:1-1",
    ]);
    const listbox = manifest.controllers["stimeo--listbox"]?.cardinality ?? [];
    expect(listbox.map((rule) => `${rule.target}:${rule.attr}:${rule.max}`)).toEqual([
      "option:aria-selected:1",
    ]);
    const radioGroup = manifest.controllers["stimeo--radio-group"]?.cardinality ?? [];
    expect(radioGroup.map((rule) => `${rule.target}:${rule.attr}:${rule.max}`)).toEqual([
      "radio:aria-checked:1",
    ]);
    expect(manifest.controllers["stimeo--switch"]?.cardinality).toEqual([]);
  });

  it("keeps the checkbox parent optional while bounding it to one", () => {
    expect(manifest.controllers["stimeo--checkbox"]?.requiredTargets).toEqual([]);
    expect(manifest.controllers["stimeo--checkbox"]?.targets).toEqual(["parent", "child"]);
  });

  it("requires exactly one form-field control across structure and cardinality", () => {
    expect(manifest.controllers["stimeo--form-field"]?.requiredTargets).toEqual(["control"]);
    expect(manifest.controllers["stimeo--form-field"]?.cardinality).toEqual([
      expect.objectContaining({ target: "control", max: 1 }),
    ]);
  });

  it("only writes companion / target-declaration / cardinality rules for known controllers", () => {
    for (const id of [
      ...Object.keys(companionRules),
      ...Object.keys(targetDeclarationRules),
      ...Object.keys(cardinalityRules),
    ]) {
      expect(stimeoControllers).toHaveProperty(id);
    }
  });

  it("declares companion / target-declaration / cardinality rules both sides understand", () => {
    for (const entry of Object.values(manifest.controllers)) {
      for (const rule of entry.companions) {
        if (rule.target !== "") expect(entry.targets).toContain(rule.target);
        expect(manifest.controllers).toHaveProperty(rule.controller);
        expect(rule.suggestion.length).toBeGreaterThan(0);
      }
      for (const rule of entry.targetDeclarations) {
        expect(entry.targets).toContain(rule.target);
        expect(rule.attr.length).toBeGreaterThan(0);
        expect(rule.suggestion.length).toBeGreaterThan(0);
      }
      for (const rule of entry.cardinality) {
        expect(entry.targets).toContain(rule.target);
        if (rule.within !== "") expect(entry.targets).toContain(rule.within);
        // A bound-less rule would parse and evaluate to nothing at all, so the
        // schema's independently-optional min/max needs this floor.
        expect(rule.min !== undefined || rule.max !== undefined).toBe(true);
        expect(rule.suggestion.length).toBeGreaterThan(0);
      }
    }
  });

  it("keeps every value condition's default in sync with the controllers' static values", () => {
    // Conditions duplicate the host's `static values` default because the engine
    // needs it to judge an *absent* attribute. A changed controller default
    // would otherwise silently arm the rule against the configuration it was
    // written to exempt — the same drift the composition guard above prevents,
    // now that three rule families carry conditions.
    const conditions: Array<[string, ValueCondition]> = [];
    for (const [id, rules] of Object.entries(a11yRules)) {
      for (const rule of rules) if (rule.when) conditions.push([id, rule.when]);
    }
    for (const [id, rules] of Object.entries(cardinalityRules)) {
      for (const rule of rules) if (rule.when) conditions.push([id, rule.when]);
    }
    for (const [id, rules] of Object.entries(structureRules)) {
      for (const rule of rules.requiredActions ?? []) {
        if (rule.when) conditions.push([id, rule.when]);
      }
    }
    expect(conditions.length).toBeGreaterThan(0);
    for (const [id, when] of conditions) {
      const host = allControllers[id as keyof typeof allControllers];
      expect(host, `unknown host ${id}`).toBeDefined();
      expect(manifest.controllers[id]?.values).toContain(when.value);
      expect(when.equals.length).toBeGreaterThan(0);
      expect(String(valueDefault(host, when.value))).toBe(when.default);
    }
  });

  it("declares required actions on known methods, events, targets, and Values", () => {
    for (const entry of Object.values(manifest.controllers)) {
      for (const rule of entry.requiredActions) {
        if (rule.target !== "") expect(entry.targets).toContain(rule.target);
        expect(entry.actions).toContain(rule.action);
        expect(rule.eventTypes.length).toBeGreaterThan(0);
        if (rule.when) expect(entry.values).toContain(rule.when.value);
        expect(rule.suggestion.length).toBeGreaterThan(0);
      }
    }
  });

  it("merges hand-written forbidden-aria rules, defaulting to [] when undeclared", () => {
    const menubar = manifest.controllers["stimeo--menubar"]?.forbiddenAria ?? [];
    expect(
      menubar.map((rule) => `${rule.target}:${rule.attrs.join("/")}=${rule.values?.join("|")}`),
    ).toEqual(["menu:aria-busy=true"]);
    expect(manifest.controllers["stimeo--switch"]?.forbiddenAria).toEqual([]);
  });

  it("only writes forbidden-aria rules for known controllers", () => {
    for (const id of Object.keys(forbiddenAriaRules)) {
      expect(stimeoControllers).toHaveProperty(id);
    }
  });

  it("keeps forbidden-aria out of the attributes the controller manages itself", () => {
    // The two families are opposites in *why* the attribute should go, so an
    // attribute in both would be self-contradictory: managed means the author
    // can never usefully write it, forbidden means the author owns it and it is
    // required in the other configuration.
    for (const entry of Object.values(manifest.controllers)) {
      const managed = new Set(entry.managedAria.flatMap((rule) => rule.attrs));
      for (const rule of entry.forbiddenAria) {
        if (rule.target !== "") expect(entry.targets).toContain(rule.target);
        expect(rule.attrs.length).toBeGreaterThan(0);
        expect(rule.suggestion.length).toBeGreaterThan(0);
        for (const attr of rule.attrs) expect(managed.has(attr)).toBe(false);
      }
    }
  });

  it("declares content conditions on targets the controller understands", () => {
    // Content conditions count a target *inside* the element the rule applies
    // to, so a stale target name would silently arm the rule on every element
    // (the count would always be 0) instead of failing loudly.
    const conditions: Array<[string, ContentCondition]> = [];
    for (const [id, entry] of Object.entries(manifest.controllers)) {
      for (const rule of entry.a11y)
        if (rule.whenContains) conditions.push([id, rule.whenContains]);
      for (const rule of entry.forbiddenAria) {
        if (rule.whenContains) conditions.push([id, rule.whenContains]);
      }
    }
    expect(conditions.length).toBeGreaterThan(0);
    for (const [id, condition] of conditions) {
      expect(manifest.controllers[id]?.targets).toContain(condition.target);
      // A bound-less condition would hold for every element, arming the rule
      // unconditionally — which is a different family's job.
      expect(condition.min !== undefined || condition.max !== undefined).toBe(true);
    }
  });

  it("spells the requirement level only where it differs from the default", () => {
    // `severity` defaults to "error", so an explicit "error" is a no-op that
    // would drift out of sync with the default the day it changed. Only the
    // recommended level is ever written out.
    const levelled = Object.values(manifest.controllers).flatMap((entry) =>
      entry.a11y.filter((rule) => rule.severity !== undefined),
    );
    expect(levelled.length).toBeGreaterThan(0);
    for (const rule of levelled) expect(rule.severity).toBe("warning");
  });

  it("declares element conditions with lowercase tags and no empty exemption", () => {
    // The engine compares against the parser's lowercased tag, so an uppercase
    // entry would silently never match and quietly disarm nothing.
    const conditions = Object.values(manifest.controllers).flatMap((entry) =>
      entry.a11y.flatMap((rule) => (rule.whenElement ? [rule.whenElement] : [])),
    );
    expect(conditions.length).toBeGreaterThan(0);
    for (const condition of conditions) {
      expect(condition.exceptTags.length).toBeGreaterThan(0);
      for (const tag of condition.exceptTags) expect(tag).toBe(tag.toLowerCase());
    }
  });

  it("declares file-level conditions that a single element cannot already satisfy", () => {
    // `atLeast: 1` is met by the very element under test, so the condition
    // would be unconditional — a rule wanting that should simply omit it.
    // A rule carrying both would also be incoherent: one arms, one escalates.
    const rules = Object.values(manifest.controllers).flatMap((entry) => entry.a11y);
    const conditions = rules.flatMap((rule) =>
      [rule.whenDocument, rule.escalateWhen].filter((c) => c !== undefined),
    );
    expect(conditions.length).toBeGreaterThan(0);
    for (const condition of conditions) expect(condition.atLeast).toBeGreaterThanOrEqual(2);
    for (const rule of rules) {
      expect(rule.whenDocument !== undefined && rule.escalateWhen !== undefined).toBe(false);
    }
  });

  it("names every target it requires an ARIA-name-required role on", () => {
    // The rules are a hand-written table, so a gap — a role whose name ARIA
    // requires, demanded without the name — appears the moment someone adds a
    // controller and copies only the role rule. This pins the pairing itself
    // rather than one controller at a time.
    const NAME_REQUIRED = new Set([
      "alertdialog",
      "combobox",
      "dialog",
      "grid",
      "listbox",
      "meter",
      "progressbar",
      "radiogroup",
      "slider",
      "spinbutton",
      "tabpanel",
      "tree",
    ]);
    const gaps: string[] = [];
    for (const [id, entry] of Object.entries(manifest.controllers)) {
      for (const rule of entry.a11y) {
        const requiresNamedRole =
          rule.attrs.includes("role") && (rule.values ?? []).some((v) => NAME_REQUIRED.has(v));
        if (!requiresNamedRole) continue;
        const named = entry.a11y.some(
          (other) =>
            other.target === rule.target &&
            other.attrs.some((attr) => attr === "aria-label" || attr === "aria-labelledby"),
        );
        if (!named) gaps.push(`${id} → ${rule.target || "(scope)"}: ${rule.values?.join("/")}`);
      }
    }
    expect(gaps).toEqual([]);
  });

  it("declares conditional targets that name real targets", () => {
    // Both halves have to be targets the controller actually understands. A
    // presence rule also needs an *optional* trigger — with a required one it
    // would fire unconditionally, which is the thing `requiredTargets` already
    // does. A placement rule is exempt: "inside this element" is something
    // `requiredTargets` cannot say, so a mandatory trigger still adds a check.
    for (const [id, entry] of Object.entries(manifest.controllers)) {
      for (const rule of entry.conditionalTargets) {
        expect(entry.targets, `${id}: whenPresent`).toContain(rule.whenPresent);
        if (!rule.requireInside) {
          expect(entry.requiredTargets, `${id}: whenPresent must be optional`).not.toContain(
            rule.whenPresent,
          );
        }
        expect(rule.require.length, `${id}: require must not be empty`).toBeGreaterThan(0);
        for (const target of rule.require) {
          expect(entry.targets, `${id}: require`).toContain(target);
          expect(entry.requiredTargets, `${id}: require must be optional`).not.toContain(target);
          expect(target, `${id}: must not require itself`).not.toBe(rule.whenPresent);
        }
      }
    }
  });

  it("escalates only rules that start below the level they escalate to", () => {
    // Escalation raises the level to "error"; a rule already at "error" would
    // gain nothing and the condition would be dead weight the reader has to
    // reason about.
    for (const entry of Object.values(manifest.controllers)) {
      for (const rule of entry.a11y) {
        if (rule.escalateWhen) expect(rule.severity).toBe("warning");
      }
    }
  });
});

import { describe, expect, it } from "vitest";
import { cableControllers } from "../../src/cable";
import { stimeoControllers } from "../../src/index";
import { a11yRules } from "../../src/inspector/a11y_rules";
import { compositionRules } from "../../src/inspector/composition_rules";
import { keyboardRules } from "../../src/inspector/keyboard_rules";
import { managedAriaRules } from "../../src/inspector/managed_aria_rules";
import { buildManifest, SCHEMA_VERSION } from "../../src/inspector/manifest";
import { structureRules } from "../../src/inspector/structure_rules";
import { positioningControllers } from "../../src/positioning";

/** Tests for the reflection-based manifest generator. */
describe("buildManifest", () => {
  const manifest = buildManifest("1.2.3");
  // The manifest reflects the zero-dep core plus the opt-in positioning and
  // cable (server-bound) controllers (so `stimeo check` recognizes e.g.
  // stimeo--anchored and stimeo--typing-indicator).
  const allControllers = { ...stimeoControllers, ...positioningControllers, ...cableControllers };

  it("stamps schema and package versions", () => {
    expect(manifest.schemaVersion).toBe(SCHEMA_VERSION);
    expect(manifest.packageVersion).toBe("1.2.3");
  });

  it("includes every official core + opt-in positioning controller identifier", () => {
    // The private build may reflect additional opt-in controllers that the public npm
    // mirror strips, so assert the manifest is a *superset* of core + positioning here
    // rather than an exact match.
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
  });

  it("reflects static value names (camelCase keys)", () => {
    expect(manifest.controllers["stimeo--calendar"]?.values).toContain("weekStart");
    expect(manifest.controllers["stimeo--switch"]?.values).toEqual([]);
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
    expect(manifest.controllers["stimeo--switch"]?.requiredTargets).toEqual([]);
  });

  it("only writes structure rules for known controllers", () => {
    for (const id of Object.keys(structureRules)) {
      expect(allControllers).toHaveProperty(id);
    }
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
    // switch sets its own ARIA, so it carries no authoring requirements.
    expect(manifest.controllers["stimeo--switch"]?.a11y).toEqual([]);
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

  it("merges hand-written managed-aria rules, defaulting to [] when undeclared", () => {
    const combobox = manifest.controllers["stimeo--combobox"]?.managedAria ?? [];
    expect(combobox.map((rule) => `${rule.target}:${rule.attrs.join("/")}`)).toEqual([
      "input:aria-activedescendant",
    ]);
    expect(manifest.controllers["stimeo--switch"]?.managedAria).toEqual([]);
  });

  it("declares keyboard / managed-aria rules on targets the controller understands", () => {
    for (const entry of Object.values(manifest.controllers)) {
      for (const req of entry.keyboard) {
        expect(entry.targets).toContain(req.target);
        expect(req.suggestion.length).toBeGreaterThan(0);
      }
      for (const rule of entry.managedAria) {
        if (rule.target !== "") expect(entry.targets).toContain(rule.target);
        expect(rule.attrs.length).toBeGreaterThan(0);
        expect(rule.suggestion.length).toBeGreaterThan(0);
      }
    }
  });

  it("only writes keyboard / managed-aria / composition rules for known controllers", () => {
    for (const id of [
      ...Object.keys(keyboardRules),
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
    const valueDefault = (ctor: unknown, name: string): unknown =>
      (ctor as { values?: Record<string, { default?: unknown }> }).values?.[name]?.default;
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
});

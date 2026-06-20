import { describe, expect, it } from "vitest";
import { stimeoControllers } from "../../src/index";
import { a11yRules } from "../../src/inspector/a11y_rules";
import { buildManifest, SCHEMA_VERSION } from "../../src/inspector/manifest";
import { structureRules } from "../../src/inspector/structure_rules";
import { positioningControllers } from "../../src/positioning";

/** Tests for the reflection-based manifest generator. */
describe("buildManifest", () => {
  const manifest = buildManifest("1.2.3");
  // The manifest reflects both the zero-dep core and the opt-in positioning
  // controllers (so `stimeo check` recognizes e.g. stimeo--anchored).
  const allControllers = { ...stimeoControllers, ...positioningControllers };

  it("stamps schema and package versions", () => {
    expect(manifest.schemaVersion).toBe(SCHEMA_VERSION);
    expect(manifest.packageVersion).toBe("1.2.3");
  });

  it("includes every official controller identifier (core + opt-in positioning)", () => {
    expect(Object.keys(manifest.controllers).sort()).toEqual(Object.keys(allControllers).sort());
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
    for (const id of Object.keys(a11yRules)) {
      expect(stimeoControllers).toHaveProperty(id);
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
});

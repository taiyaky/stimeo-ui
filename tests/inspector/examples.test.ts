import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { collectDemoSources } from "../../scripts/demo_sources";
import type { DemoSource } from "../../src/inspector/examples";
import {
  buildExamplesIndex,
  demoDirToControllerId,
  EXAMPLES_SCHEMA_VERSION,
  PENDING_DEMO_CONTROLLERS,
} from "../../src/inspector/examples";
import { buildManifest } from "../../src/inspector/manifest";
import type { Manifest } from "../../src/inspector/types";

/** A tiny manifest for the unit cases (the integration case uses the real one). */
const miniManifest: Manifest = {
  schemaVersion: 5,
  packageVersion: "0.0.0",
  controllers: {
    "stimeo--demo": {
      targets: ["panel"],
      values: [],
      actions: [],
      events: [],
      requiredTargets: ["panel"],
      a11y: [],
      keyboard: [],
      managedAria: [],
      compositions: [],
    },
  },
};

const cleanDemo: DemoSource = {
  dir: "demo",
  file: "playground/app/views/components/demos/demo/_demo.html.erb",
  source: '<div data-controller="stimeo--demo"><p data-stimeo--demo-target="panel"></p></div>',
};

describe("demoDirToControllerId", () => {
  it("maps snake_case demo dirs to kebab-case stimeo-- identifiers", () => {
    expect(demoDirToControllerId("menu")).toBe("stimeo--menu");
    expect(demoDirToControllerId("inline_combobox")).toBe("stimeo--inline-combobox");
    expect(demoDirToControllerId("date_range_picker")).toBe("stimeo--date-range-picker");
  });
});

describe("buildExamplesIndex", () => {
  it("indexes check-clean demos by controller id", () => {
    const index = buildExamplesIndex([cleanDemo], miniManifest);
    expect(index.schemaVersion).toBe(EXAMPLES_SCHEMA_VERSION);
    expect(index.examples["stimeo--demo"]).toEqual({
      file: cleanDemo.file,
      source: cleanDemo.source,
    });
  });

  it("fails when a demo dir maps to no known controller", () => {
    expect(() =>
      buildExamplesIndex([cleanDemo, { ...cleanDemo, dir: "ghost" }], miniManifest),
    ).toThrow(/demo "ghost" maps to unknown controller "stimeo--ghost"/);
  });

  it("fails when a controller has no demo", () => {
    expect(() => buildExamplesIndex([], miniManifest)).toThrow(
      /controller "stimeo--demo" has no demo example/,
    );
  });

  it("fails when a controller has more than one demo source", () => {
    expect(() => buildExamplesIndex([cleanDemo, cleanDemo], miniManifest)).toThrow(
      /more than one demo source/,
    );
  });

  it("fails when an example stops passing the checker", () => {
    const broken: DemoSource = {
      ...cleanDemo,
      source: '<div data-controller="stimeo--demo"></div>',
    };
    expect(() => buildExamplesIndex([broken], miniManifest)).toThrow(
      /example for "stimeo--demo" fails check/,
    );
  });

  it("exempts allowlisted pending-demo controllers from the bijection", () => {
    const index = buildExamplesIndex([], miniManifest, new Set(["stimeo--demo"]));
    expect(index.examples).toEqual({});
  });

  it("fails when an allowlisted controller acquires a demo (stale entry)", () => {
    expect(() => buildExamplesIndex([cleanDemo], miniManifest, new Set(["stimeo--demo"]))).toThrow(
      /allowlisted as pending but now has a demo/,
    );
  });
});

/**
 * Integration contract with the real repo: the bundled example index must be
 * buildable from the actual demo sidecars against the actual reflected
 * manifest — the exact operation `scripts/postbuild.ts` performs at build
 * time, sharing its `collectDemoSources` walk. A drift (new controller
 * without demo, renamed demo dir, or a demo breaking the checker) fails here
 * before it fails the build. The walk resolves the supply for the current
 * tree, so this contract also holds in the public mirror (core demos under
 * `examples/`, premium-stripped manifest).
 */
describe("buildExamplesIndex (real demo sidecars)", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const root = join(here, "..", "..");

  it("covers every controller with a check-clean example", () => {
    const manifest = buildManifest("0.0.0");
    const index = buildExamplesIndex(collectDemoSources(root), manifest);
    const ids = Object.keys(index.examples);
    // The pending-demo allowlist (#266 server-bound set awaiting the cable
    // infrastructure) is the one documented gap in the bijection.
    const expected = Object.keys(manifest.controllers)
      .filter((id) => !PENDING_DEMO_CONTROLLERS.has(id))
      .sort();
    expect(ids).toEqual(expected);
    expect(ids.length).toBeGreaterThan(0);
  });
});

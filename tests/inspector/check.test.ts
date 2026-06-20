import { describe, expect, it } from "vitest";
import { checkSource } from "../../src/inspector/check";
import { buildManifest } from "../../src/inspector/manifest";
import type { DiagnosticCode } from "../../src/inspector/types";

const manifest = buildManifest("0.0.0");

/** Runs the engine and returns the diagnostic codes it produced. */
function codes(source: string): DiagnosticCode[] {
  return checkSource(source, manifest).map((d) => d.code);
}

/**
 * End-to-end tests for the Inspector engine (stage 1 names + stage 2 structure),
 * exercising the full pipeline: ERB neutralization → parse → extract → check.
 */
describe("checkSource", () => {
  const validMenu = `
    <div data-controller="stimeo--menu">
      <button data-stimeo--menu-target="trigger"
              data-action="click->stimeo--menu#toggle">Actions</button>
      <ul data-stimeo--menu-target="menu" hidden>
        <li><button data-stimeo--menu-target="item"
                    data-action="click->stimeo--menu#activate">Edit</button></li>
      </ul>
    </div>`;

  it("reports no problems for well-formed markup", () => {
    expect(checkSource(validMenu, manifest)).toEqual([]);
  });

  describe("stage 1 — names & spelling", () => {
    it("flags an unknown controller identifier", () => {
      expect(codes(`<div data-controller="stimeo--menoo"></div>`)).toContain("unknown-controller");
    });

    it("ignores non-stimeo controllers (namespace scope)", () => {
      expect(codes(`<div data-controller="hello clipboard--copy"></div>`)).toEqual([]);
    });

    it("flags a misspelled target name", () => {
      const codeList = codes(`
        <div data-controller="stimeo--menu">
          <button data-stimeo--menu-target="triger"></button>
          <ul data-stimeo--menu-target="menu"></ul>
        </div>`);
      expect(codeList).toContain("unknown-target");
    });

    it("flags an unknown value attribute", () => {
      const codeList = codes(
        `<div data-controller="stimeo--otp" data-stimeo--otp-bogus-value="1"><input data-stimeo--otp-target="field"></div>`,
      );
      expect(codeList).toContain("unknown-value");
    });

    it("accepts dasherized multi-word value names", () => {
      const codeList = codes(
        `<nav data-controller="stimeo--scrollspy" data-stimeo--scrollspy-root-margin-value="0px"><a data-stimeo--scrollspy-target="link"></a></nav>`,
      );
      expect(codeList).not.toContain("unknown-value");
    });

    it("flags an unknown controller referenced from data-action", () => {
      const codeList = codes(
        `<div data-controller="stimeo--menu"><button data-stimeo--menu-target="trigger" data-action="click->stimeo--menoo#toggle"></button><ul data-stimeo--menu-target="menu"></ul></div>`,
      );
      expect(codeList).toContain("unknown-action-controller");
    });

    it("flags an unknown action method on a known controller", () => {
      const codeList = codes(
        `<div data-controller="stimeo--menu"><button data-stimeo--menu-target="trigger" data-action="click->stimeo--menu#frobnicate"></button><ul data-stimeo--menu-target="menu"></ul></div>`,
      );
      expect(codeList).toContain("unknown-action-method");
    });

    it("accepts a declared action method", () => {
      const codeList = codes(
        `<div data-controller="stimeo--menu"><button data-stimeo--menu-target="trigger" data-action="click->stimeo--menu#toggle"></button><ul data-stimeo--menu-target="menu"></ul></div>`,
      );
      expect(codeList).not.toContain("unknown-action-method");
    });
  });

  describe("stage 2 — structure", () => {
    it("flags a missing required target", () => {
      const codeList = codes(`
        <div data-controller="stimeo--menu">
          <button data-stimeo--menu-target="trigger"></button>
        </div>`);
      expect(codeList).toContain("missing-required-target");
    });

    it("flags a target with no enclosing controller", () => {
      expect(codes(`<button data-stimeo--menu-target="trigger"></button>`)).toContain(
        "orphan-target",
      );
    });

    it("resolves targets to the nearest ancestor controller scope", () => {
      // Inner menu is complete; outer menu lacks its own trigger/menu.
      const codeList = codes(`
        <div data-controller="stimeo--menu">
          <div data-controller="stimeo--menu">
            <button data-stimeo--menu-target="trigger"></button>
            <ul data-stimeo--menu-target="menu"></ul>
          </div>
        </div>`);
      // The outer scope is missing both required targets (they belong to the inner scope).
      expect(codeList.filter((c) => c === "missing-required-target")).toHaveLength(2);
    });

    it("does not double-report when an identifier is repeated in data-controller", () => {
      // A duplicated identifier still connects one Stimulus scope, so the missing
      // required targets must be reported once, not once per repetition.
      const codeList = codes(`<div data-controller="stimeo--menu stimeo--menu"></div>`);
      expect(codeList.filter((c) => c === "missing-required-target")).toHaveLength(2);
    });
  });

  describe("stage 3 — accessibility (ARIA)", () => {
    const validDialog = `
      <div data-controller="stimeo--dialog">
        <button data-stimeo--dialog-target="trigger"
                data-action="stimeo--dialog#open">Open</button>
        <div data-stimeo--dialog-target="dialog" role="dialog"
             aria-modal="true" aria-labelledby="t" hidden>
          <h2 id="t">Title</h2>
        </div>
      </div>`;

    it("accepts a dialog that authors its required ARIA", () => {
      expect(codes(validDialog)).toEqual([]);
    });

    it("accepts aria-label as an alternative accessible name", () => {
      const source = validDialog.replace('aria-labelledby="t"', 'aria-label="Confirm"');
      expect(codes(source)).not.toContain("missing-aria");
    });

    it("flags a dialog target missing role/aria-modal/name", () => {
      const codeList = codes(`
        <div data-controller="stimeo--dialog">
          <button data-stimeo--dialog-target="trigger"
                  data-action="stimeo--dialog#open">Open</button>
          <div data-stimeo--dialog-target="dialog" hidden></div>
        </div>`);
      expect(codeList.filter((c) => c === "missing-aria")).toHaveLength(3);
    });

    it("flags an incorrect role value on the dialog target", () => {
      const source = validDialog.replace('role="dialog"', 'role="banner"');
      const list = checkSource(source, manifest);
      const invalid = list.find((d) => d.code === "invalid-aria-value");
      expect(invalid?.message).toContain('Expected "dialog"');
      // The attribute exists, so the fix points at the value, not "Add …".
      expect(invalid?.suggestion).toBe('Set role to "dialog".');
    });

    it("flags each tab target missing its role", () => {
      const codeList = codes(`
        <div data-controller="stimeo--tabs">
          <div role="tablist">
            <button data-stimeo--tabs-target="tab">A</button>
            <button data-stimeo--tabs-target="tab">B</button>
          </div>
          <div data-stimeo--tabs-target="panel" role="tabpanel">A</div>
        </div>`);
      expect(codeList.filter((c) => c === "missing-aria")).toHaveLength(2);
    });

    it("does not require ARIA the controller sets itself (no aria-selected)", () => {
      const source = `
        <div data-controller="stimeo--tabs">
          <div role="tablist">
            <button data-stimeo--tabs-target="tab" role="tab">A</button>
          </div>
          <div data-stimeo--tabs-target="panel" role="tabpanel">A</div>
        </div>`;
      expect(codes(source)).toEqual([]);
    });
  });

  describe("stage 4 — fix suggestions", () => {
    it("suggests the nearest target name for a likely typo", () => {
      const diagnostics = checkSource(
        `<div data-controller="stimeo--menu">
           <button data-stimeo--menu-target="triger"></button>
           <ul data-stimeo--menu-target="menu"></ul>
         </div>`,
        manifest,
      );
      const d = diagnostics.find((x) => x.code === "unknown-target");
      expect(d?.suggestion).toBe('Did you mean "trigger"?');
    });

    it("suggests the nearest action method for a likely typo", () => {
      const diagnostics = checkSource(
        `<div data-controller="stimeo--menu"><button data-stimeo--menu-target="trigger" data-action="click->stimeo--menu#tggle"></button><ul data-stimeo--menu-target="menu"></ul></div>`,
        manifest,
      );
      const d = diagnostics.find((x) => x.code === "unknown-action-method");
      expect(d?.suggestion).toBe('Did you mean "toggle"?');
    });

    it("omits a suggestion when nothing is close enough", () => {
      const diagnostics = checkSource(
        `<div data-controller="stimeo--menu">
           <button data-stimeo--menu-target="xyzzyplughxyzzy"></button>
           <ul data-stimeo--menu-target="menu"></ul>
         </div>`,
        manifest,
      );
      const d = diagnostics.find((x) => x.code === "unknown-target");
      expect(d?.suggestion).toBeUndefined();
    });

    it("suggests the nearest controller for a target attribute typo", () => {
      const diagnostics = checkSource(`<div data-stimeo--menoo-target="trigger"></div>`, manifest);
      const d = diagnostics.find((x) => x.code === "unknown-controller");
      expect(d?.suggestion).toBe('Did you mean "stimeo--menu"?');
    });

    it("suggests the nearest controller for a data-action typo", () => {
      const diagnostics = checkSource(
        `<div data-controller="stimeo--menu"><button data-stimeo--menu-target="trigger" data-action="click->stimeo--menoo#toggle"></button><ul data-stimeo--menu-target="menu"></ul></div>`,
        manifest,
      );
      const d = diagnostics.find((x) => x.code === "unknown-action-controller");
      expect(d?.suggestion).toBe('Did you mean "stimeo--menu"?');
    });

    it("attaches the concrete ARIA fix to a missing-aria diagnostic", () => {
      const diagnostics = checkSource(
        `<div data-controller="stimeo--dialog">
           <button data-stimeo--dialog-target="trigger" data-action="stimeo--dialog#open"></button>
           <div data-stimeo--dialog-target="dialog" hidden></div>
         </div>`,
        manifest,
      );
      const d = diagnostics.find((x) => x.code === "missing-aria");
      expect(d?.suggestion).toBe('Add role="dialog" to the dialog target.');
    });
  });

  describe("ERB resilience", () => {
    it("skips dynamically-generated controller identifiers", () => {
      expect(codes(`<div data-controller="<%= controller_id %>"></div>`)).toEqual([]);
    });

    it("skips dynamically-named attributes", () => {
      expect(codes(`<div data-<%= id %>-target="trigger"></div>`)).toEqual([]);
    });

    it("does not treat event names inside <script> as attributes", () => {
      const source = `
        <div data-controller="stimeo--otp" id="x">
          <input data-stimeo--otp-target="field">
        </div>
        <script>document.getElementById('x').addEventListener('stimeo--otp:complete', () => {});</script>`;
      expect(checkSource(source, manifest)).toEqual([]);
    });
  });

  it("sorts diagnostics by line then column", () => {
    const source = `<div data-controller="stimeo--menu">
  <button data-stimeo--menu-target="triger"></button>
  <ul data-stimeo--menu-target="menu"></ul>
  <button data-stimeo--menu-target="nope2"></button>
</div>`;
    const diagnostics = checkSource(source, manifest);
    for (let i = 1; i < diagnostics.length; i++) {
      const prev = diagnostics[i - 1];
      const curr = diagnostics[i];
      if (!prev || !curr) continue;
      const ordered =
        prev.line < curr.line || (prev.line === curr.line && prev.column <= curr.column);
      expect(ordered).toBe(true);
    }
  });
});

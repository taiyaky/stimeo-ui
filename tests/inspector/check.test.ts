import { describe, expect, it } from "vitest";
import { checkSource } from "../../src/inspector/check";
import { buildManifest } from "../../src/inspector/manifest";
import type { Diagnostic, DiagnosticCode, Manifest } from "../../src/inspector/types";

const manifest = buildManifest("0.0.0");

/** Runs the engine and returns the diagnostic codes it produced. */
function codes(source: string): DiagnosticCode[] {
  return checkSource(source, manifest).map((d) => d.code);
}

/**
 * End-to-end tests for the complete Inspector pipeline: ERB neutralization,
 * parsing, extraction, stage 1–3 diagnostics, and stage 4 suggestions/fixes.
 */
describe("checkSource", () => {
  const validMenu = `
    <div data-controller="stimeo--menu">
      <button id="menu-trigger" aria-haspopup="menu" data-stimeo--menu-target="trigger"
              data-action="click->stimeo--menu#toggle">Actions</button>
      <ul role="menu" aria-labelledby="menu-trigger" data-stimeo--menu-target="menu" hidden>
        <li role="none"><button role="menuitem" data-stimeo--menu-target="item"
                    data-action="click->stimeo--menu#activate">Edit</button></li>
      </ul>
    </div>`;

  const validTabs = `
    <div data-controller="stimeo--tabs">
      <h2 id="tabs-title">Sections</h2>
      <div role="tablist" aria-labelledby="tabs-title" data-stimeo--tabs-target="list">
        <button id="tabs-tab-a" role="tab" data-stimeo--tabs-target="tab">A</button>
      </div>
      <div role="tabpanel" aria-labelledby="tabs-tab-a" data-stimeo--tabs-target="panel">A</div>
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

    // A feature that is opt-in but incomplete without its whole set (schema v8).
    // Every other check passes and the page loads — the feature just silently does
    // nothing — so a static rule is the only layer that can say anything.
    describe("conditional targets", () => {
      const trail = (extra: string) => `
        <nav data-controller="stimeo--breadcrumb">
          <ol data-stimeo--breadcrumb-target="list">
            <li><a href="/">Home</a></li>
            ${extra}
            <li id="bc-a" data-stimeo--breadcrumb-target="collapsible"><a href="/a">A</a></li>
            <li><a href="/a/b" aria-current="page">B</a></li>
          </ol>
        </nav>`;

      it("requires the disclosure once an item is marked collapsible", () => {
        const found = checkSource(trail(""), manifest).filter(
          (d) => d.code === "missing-conditional-target",
        );
        expect(found).toHaveLength(1);
        expect(found[0]?.message).toContain('"ellipsis"');
        expect(found[0]?.message).toContain('"trigger"');
      });

      it("names only the half that is missing", () => {
        const found = checkSource(
          trail('<li data-stimeo--breadcrumb-target="ellipsis"></li>'),
          manifest,
        ).filter((d) => d.code === "missing-conditional-target");
        expect(found).toHaveLength(1);
        expect(found[0]?.message).toContain('"trigger"');
        expect(found[0]?.message).not.toContain('"ellipsis"');
      });

      it("says nothing once the set is complete", () => {
        const complete = trail(
          '<li data-stimeo--breadcrumb-target="ellipsis"><button data-stimeo--breadcrumb-target="trigger">…</button></li>',
        );
        expect(codes(complete)).not.toContain("missing-conditional-target");
      });

      it("says nothing about a plain trail that opts out entirely", () => {
        // The whole point: `collapsible` is optional, and a trail without it is
        // the common spelling. Making the disclosure unconditionally required
        // would reject this.
        const plain = `
          <nav data-controller="stimeo--breadcrumb">
            <ol data-stimeo--breadcrumb-target="list">
              <li><a href="/">Home</a></li>
              <li><a href="/a" aria-current="page">A</a></li>
            </ol>
          </nav>`;
        expect(codes(plain)).toEqual([]);
      });

      it("holds in both directions when the rule is declared both ways", () => {
        // file-dropzone needs the template *and* the list: either one alone
        // renders nothing.
        const dropzone = (target: string) => `
          <div data-controller="stimeo--file-dropzone">
            <input type="file" data-stimeo--file-dropzone-target="input">
            <button data-stimeo--file-dropzone-target="trigger">Choose</button>
            <div data-stimeo--file-dropzone-target="${target}"></div>
          </div>`;
        const withTemplate = checkSource(dropzone("itemTemplate"), manifest).filter(
          (d) => d.code === "missing-conditional-target",
        );
        const withList = checkSource(dropzone("list"), manifest).filter(
          (d) => d.code === "missing-conditional-target",
        );
        expect(withTemplate[0]?.message).toContain('"list"');
        expect(withList[0]?.message).toContain('"itemTemplate"');
      });
    });

    it("flags a target with no enclosing controller", () => {
      expect(codes(`<button data-stimeo--menu-target="trigger"></button>`)).toContain(
        "orphan-target",
      );
    });

    describe("fragment declarations (data-stimeo-fragment)", () => {
      it("suppresses orphan-target inside a declared fragment of that controller", () => {
        // A server-rendered fragment (Turbo Stream / feed page) is appended inside
        // its controller at runtime, so its own file has no data-controller.
        expect(
          codes(`
            <li data-stimeo-fragment="stimeo--menu">
              <button data-stimeo--menu-target="item"></button>
            </li>`),
        ).toEqual([]);
      });

      it("keeps orphan-target for targets of a controller the fragment does not declare", () => {
        expect(
          codes(`
            <li data-stimeo-fragment="stimeo--menu">
              <button data-stimeo--tabs-target="tab"></button>
            </li>`),
        ).toContain("orphan-target");
      });

      it("still spell-checks target names inside a declared fragment", () => {
        expect(
          codes(`
            <li data-stimeo-fragment="stimeo--menu">
              <button data-stimeo--menu-target="itemm"></button>
            </li>`),
        ).toContain("unknown-target");
      });

      it("flags an unknown controller in the declaration itself", () => {
        expect(codes(`<li data-stimeo-fragment="stimeo--menoo"></li>`)).toContain(
          "unknown-controller",
        );
      });

      it("flags an empty declaration", () => {
        expect(codes(`<li data-stimeo-fragment=""></li>`)).toContain("unknown-controller");
      });
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

    it("requires a menu name and accepts aria-label as an alternative", () => {
      const unnamed = validMenu.replace(' aria-labelledby="menu-trigger"', "");
      const missing = checkSource(unnamed, manifest).filter((d) => d.code === "missing-aria");
      expect(missing).toHaveLength(1);
      expect(missing[0]?.suggestion).toBe(
        "Name the menu via aria-labelledby (the trigger's id) or aria-label.",
      );

      const labelled = validMenu.replace('aria-labelledby="menu-trigger"', 'aria-label="Actions"');
      expect(codes(labelled)).not.toContain("missing-aria");
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
          <div role="tablist" aria-label="Sections" data-stimeo--tabs-target="list">
            <button data-stimeo--tabs-target="tab">A</button>
            <button data-stimeo--tabs-target="tab">B</button>
          </div>
          <div data-stimeo--tabs-target="panel" role="tabpanel" aria-label="A">A</div>
        </div>`);
      expect(codeList.filter((c) => c === "missing-aria")).toHaveLength(2);
    });

    it("requires a tablist name and accepts aria-label as an alternative", () => {
      const unnamed = validTabs.replace(' aria-labelledby="tabs-title"', "");
      const missing = checkSource(unnamed, manifest).filter((d) => d.code === "missing-aria");
      expect(missing).toHaveLength(1);
      expect(missing[0]?.suggestion).toBe("Name the tablist via aria-labelledby or aria-label.");
      // ARIA recommends this name rather than requiring it, so it is a warning:
      // an unnamed tablist is still a working tab set.
      expect(missing[0]?.severity).toBe("warning");

      const labelled = validTabs.replace('aria-labelledby="tabs-title"', 'aria-label="Sections"');
      expect(codes(labelled)).not.toContain("missing-aria");
    });

    it("does not require ARIA the controller sets itself (no aria-selected)", () => {
      expect(codes(validTabs)).toEqual([]);
    });

    it("requires an id on every command palette option target", () => {
      const diagnostics = checkSource(
        `
          <div data-controller="stimeo--command-palette">
            <div role="dialog" aria-modal="true" aria-label="Commands"
                 data-stimeo--command-palette-target="dialog">
              <input role="combobox" aria-autocomplete="list"
                     data-stimeo--command-palette-target="input">
              <ul role="listbox" data-stimeo--command-palette-target="list">
                <li id="command-one" role="option"
                    data-stimeo--command-palette-target="option">One</li>
                <li role="option" data-stimeo--command-palette-target="option">Two</li>
              </ul>
            </div>
          </div>`,
        manifest,
      );
      const missingId = diagnostics.filter(
        (diagnostic) =>
          diagnostic.code === "missing-aria" && diagnostic.suggestion?.includes("unique id"),
      );

      expect(missingId).toHaveLength(1);
    });

    it('checks scope-element rules (target: "") on the data-controller element', () => {
      const bare = `
        <div data-controller="stimeo--toolbar" aria-label="Format">
          <button data-stimeo--toolbar-target="control">Bold</button>
        </div>`;
      expect(codes(bare).filter((c) => c === "missing-aria")).toHaveLength(1);
      expect(
        codes(
          bare.replace(
            'data-controller="stimeo--toolbar"',
            'role="toolbar" data-controller="stimeo--toolbar"',
          ),
        ),
      ).toEqual([]);
    });

    it("checks presence-only requirements (tooltip trigger's aria-describedby)", () => {
      const bare = `
        <span data-controller="stimeo--tooltip">
          <button data-stimeo--tooltip-target="trigger">?</button>
          <span id="tip" role="tooltip" data-stimeo--tooltip-target="content" hidden>Help</span>
        </span>`;
      const diagnostics = checkSource(bare, manifest);
      const missing = diagnostics.filter((d) => d.code === "missing-aria");
      expect(missing).toHaveLength(1);
      expect(missing[0]?.suggestion).toBe(
        "Point the trigger at the tooltip via aria-describedby (the content target's id).",
      );
      expect(
        codes(
          bare.replace(
            'data-stimeo--tooltip-target="trigger"',
            'aria-describedby="tip" data-stimeo--tooltip-target="trigger"',
          ),
        ),
      ).toEqual([]);
    });

    it("flags a wrong aria-roledescription value on the carousel scope", () => {
      const source = `
        <section data-controller="stimeo--carousel" aria-roledescription="gallery" aria-label="Tours">
          <div data-stimeo--carousel-target="slide" role="tabpanel" aria-roledescription="slide">A</div>
          <button data-stimeo--carousel-target="picker" role="tab">1</button>
        </section>`;
      const invalid = checkSource(source, manifest).find((d) => d.code === "invalid-aria-value");
      expect(invalid?.message).toContain('Expected "carousel"');
    });

    it("accepts a select-only listbox without its controller-managed ARIA", () => {
      // No aria-expanded / aria-activedescendant / aria-selected authored: the
      // controller owns those, so fully-authored roles + name must be enough.
      const source = `
        <div data-controller="stimeo--listbox">
          <span id="l">Fruit</span>
          <button role="combobox" aria-labelledby="l v" data-stimeo--listbox-target="trigger">
            <span id="v" data-stimeo--listbox-target="value">Apple</span>
          </button>
          <ul role="listbox" aria-labelledby="l" data-stimeo--listbox-target="list" hidden>
            <li role="option" data-stimeo--listbox-target="option">Apple</li>
          </ul>
        </div>`;
      expect(codes(source)).toEqual([]);
    });

    describe("alternative groups (or)", () => {
      const spinner = (indicator: string) => `
        <div data-controller="stimeo--spinner">
          ${indicator}
          <div data-stimeo--spinner-target="region"></div>
        </div>`;

      it("accepts either spelling of a live indicator", () => {
        expect(
          codes(spinner(`<div role="status" data-stimeo--spinner-target="indicator"></div>`)),
        ).toEqual([]);
        expect(
          codes(spinner(`<div aria-live="polite" data-stimeo--spinner-target="indicator"></div>`)),
        ).toEqual([]);
      });

      it("flags an indicator with neither spelling, naming all alternatives", () => {
        const d = checkSource(
          spinner(`<div data-stimeo--spinner-target="indicator"></div>`),
          manifest,
        ).find((x) => x.code === "missing-aria");
        expect(d?.message).toContain("role or aria-live");
      });

      it("flags a wrong value even when the other group is satisfied", () => {
        // aria-live="off" silences the region regardless of the valid role.
        const source = spinner(
          `<div role="status" aria-live="off" data-stimeo--spinner-target="indicator"></div>`,
        );
        expect(codes(source)).toContain("invalid-aria-value");
      });

      // Same live-region contract on the opt-in cable controller: the author
      // supplies the status target's live semantics (spec: typing-indicator).
      const typing = (status: string) => `
        <div data-controller="stimeo--typing-indicator">
          <textarea aria-label="Message"></textarea>
          ${status}
        </div>`;

      it("accepts either live-region spelling on typing-indicator's status", () => {
        expect(
          codes(typing(`<p role="status" data-stimeo--typing-indicator-target="status"></p>`)),
        ).toEqual([]);
        expect(
          codes(typing(`<p aria-live="polite" data-stimeo--typing-indicator-target="status"></p>`)),
        ).toEqual([]);
      });

      it("flags a typing-indicator status target with no live-region semantics", () => {
        expect(codes(typing(`<p data-stimeo--typing-indicator-target="status"></p>`))).toContain(
          "missing-aria",
        );
      });

      it("does not require the optional status target itself", () => {
        // Silent mode (data-typing hook only) stays valid: the rule binds to
        // the target when present, not to its existence.
        expect(codes(typing(""))).toEqual([]);
      });

      describe("same attribute across groups (value union)", () => {
        // A synthetic manifest whose rule lists `role` in BOTH the base group
        // (values a/b) and an `or` group (value c). No real rule needs this yet,
        // but the engine must union the allowed values so a value valid in one
        // group is never flagged just because another group omits it.
        const overlapManifest: Manifest = {
          schemaVersion: 5,
          packageVersion: "0.0.0",
          controllers: {
            "stimeo--demo": {
              targets: ["box"],
              values: [],
              actions: [],
              events: [],
              requiredTargets: [],
              conditionalTargets: [],
              a11y: [
                {
                  target: "box",
                  attrs: ["role"],
                  values: ["a", "b"],
                  or: [{ attrs: ["role"], values: ["c"] }],
                  suggestion: "Set role.",
                },
              ],
              keyboard: [],
              managedAria: [],
              compositions: [],
              companions: [],
              targetDeclarations: [],
              cardinality: [],
              forbiddenAria: [],
            },
          },
        };
        const box = (role: string) =>
          `<div data-controller="stimeo--demo"><div role="${role}" data-stimeo--demo-target="box"></div></div>`;

        it("accepts a value valid in the second group", () => {
          expect(checkSource(box("c"), overlapManifest)).toEqual([]);
        });

        it("flags a value valid in no group, expecting the unioned set", () => {
          const d = checkSource(box("d"), overlapManifest).find(
            (x) => x.code === "invalid-aria-value",
          );
          expect(d?.message).toContain('Expected "a", "b", "c"');
        });
      });
    });

    describe("keyboard prerequisites", () => {
      const slider = (thumb: string) => `
        <div data-controller="stimeo--slider">
          <div data-stimeo--slider-target="track">${thumb}</div>
        </div>`;

      it("flags a div thumb without tabindex and accepts one with it", () => {
        const bare = slider(
          `<div role="slider" aria-label="Volume" data-stimeo--slider-target="thumb"></div>`,
        );
        const d = checkSource(bare, manifest).find((x) => x.code === "keyboard-inaccessible");
        expect(d?.severity).toBe("error");
        expect(d?.suggestion).toContain('tabindex="0"');
        expect(
          codes(
            slider(
              `<div role="slider" aria-label="Volume" tabindex="0" data-stimeo--slider-target="thumb"></div>`,
            ),
          ),
        ).toEqual([]);
      });

      it("flags a Tab-stop target that is removed from the Tab order (tabindex=-1)", () => {
        // reach:"tab" — the slider thumb is a steady Tab stop, so tabindex="-1"
        // strands it out of the Tab order and must be caught (a presence-only
        // check would miss this).
        const d = checkSource(
          slider(
            `<div role="slider" aria-label="Volume" tabindex="-1" data-stimeo--slider-target="thumb"></div>`,
          ),
          manifest,
        ).find((x) => x.code === "keyboard-inaccessible");
        expect(d?.severity).toBe("error");
        expect(d?.message).toContain("not in the Tab order");
      });

      it("accepts natively focusable elements without any tabindex", () => {
        // Menu items are roved via element.focus(); a <div> item needs authored
        // tabindex while a native <button> passes as-is (cf. validMenu above).
        const menu = (item: string) => `
          <div data-controller="stimeo--menu">
            <button id="menu-trigger" aria-haspopup="menu" data-stimeo--menu-target="trigger">Actions</button>
            <ul role="menu" aria-labelledby="menu-trigger" data-stimeo--menu-target="menu" hidden>
              <li role="none">${item}</li>
            </ul>
          </div>`;
        expect(
          codes(menu(`<div role="menuitem" data-stimeo--menu-target="item">Edit</div>`)),
        ).toContain("keyboard-inaccessible");
        expect(
          codes(menu(`<button role="menuitem" data-stimeo--menu-target="item">Edit</button>`)),
        ).toEqual([]);
      });

      it("accepts tabindex=-1 on a roving (reach:focus) menu item", () => {
        // The APG menu contract authors tabindex="-1" on non-native items; that
        // is correct for programmatic focus and must NOT be flagged.
        const source = `
          <div data-controller="stimeo--menu">
            <button id="menu-trigger" aria-haspopup="menu" data-stimeo--menu-target="trigger">Actions</button>
            <ul role="menu" aria-labelledby="menu-trigger" data-stimeo--menu-target="menu" hidden>
              <li role="none">
                <div role="menuitem" tabindex="-1" data-stimeo--menu-target="item">Edit</div>
              </li>
            </ul>
          </div>`;
        expect(codes(source)).toEqual([]);
      });

      it("does not treat input[type=hidden] as focusable (but a real input is)", () => {
        // input is natively focusable EXCEPT type="hidden" — never rendered.
        expect(codes(slider(`<input type="hidden" data-stimeo--slider-target="thumb">`))).toContain(
          "keyboard-inaccessible",
        );
        expect(
          codes(
            slider(
              `<input type="range" role="slider" aria-label="V" data-stimeo--slider-target="thumb">`,
            ),
          ),
        ).toEqual([]);
      });

      it("does not treat contenteditable=false as focusable (but true/bare is)", () => {
        expect(
          codes(
            slider(
              `<div role="slider" aria-label="V" contenteditable="false" data-stimeo--slider-target="thumb"></div>`,
            ),
          ),
        ).toContain("keyboard-inaccessible");
        expect(
          codes(
            slider(
              `<div role="slider" aria-label="V" contenteditable="true" data-stimeo--slider-target="thumb"></div>`,
            ),
          ),
        ).toEqual([]);
      });
    });

    describe("managed (author-futile) attributes", () => {
      it("warns when aria-activedescendant is authored on a combobox input", () => {
        const source = `
          <div data-controller="stimeo--combobox">
            <input role="combobox" aria-autocomplete="list" aria-activedescendant="opt-1"
                   data-stimeo--combobox-target="input">
            <ul role="listbox" data-stimeo--combobox-target="list" hidden>
              <li role="option" id="opt-1" data-stimeo--combobox-target="option">A</li>
            </ul>
          </div>`;
        const d = checkSource(source, manifest).find((x) => x.code === "managed-aria");
        expect(d?.severity).toBe("warning");
        expect(d?.message).toContain("aria-activedescendant");
        expect(d?.suggestion).toContain("Remove aria-activedescendant");
      });
    });

    describe("cross-controller composition values", () => {
      // Sortable's documented composition:
      // roving on the list keeps the handles one Tab stop, pointer-drag on
      // each item supplies the drag/keyboard signal — and both carry an
      // axis-alignment contract with sortable's `orientation`.
      const sortable = ({ scope = "", list = "", item = "" } = {}) => `
        <div data-controller="stimeo--sortable" ${scope}>
          <ul data-stimeo--sortable-target="list" data-controller="stimeo--roving" ${list}
              aria-label="Cards">
            <li data-stimeo--sortable-target="item" data-controller="stimeo--pointer-drag" ${item}>
              <button type="button" aria-label="Reorder A"
                      data-stimeo--pointer-drag-target="handle"
                      data-stimeo--roving-target="item">A</button>
            </li>
          </ul>
          <span role="status" data-stimeo--sortable-target="status"></span>
        </div>`;

      it("flags a vertical list whose roving leaves orientation on its horizontal default", () => {
        // The defining composition case: both sides on their defaults (sortable
        // vertical, roving horizontal) — Tab reaches the handles, arrows die.
        const all = checkSource(sortable(), manifest);
        const mismatches = all.filter((x) => x.code === "composition-mismatch");
        expect(mismatches).toHaveLength(1);
        expect(mismatches[0]?.severity).toBe("error");
        expect(mismatches[0]?.message).toContain("data-stimeo--roving-orientation-value");
        expect(mismatches[0]?.message).toContain('"vertical", "both"');
        expect(mismatches[0]?.suggestion).toContain(
          'data-stimeo--roving-orientation-value="vertical"',
        );
      });

      it("accepts an aligned or both-axis roving orientation", () => {
        expect(
          codes(sortable({ list: 'data-stimeo--roving-orientation-value="vertical"' })),
        ).toEqual([]);
        expect(codes(sortable({ list: 'data-stimeo--roving-orientation-value="both"' }))).toEqual(
          [],
        );
      });

      it("flags an authored misalignment with a machine fix to the canonical value", () => {
        const d = checkSource(
          sortable({ list: 'data-stimeo--roving-orientation-value="horizontal"' }),
          manifest,
        ).find((x) => x.code === "composition-mismatch");
        expect(d?.message).toContain('data-stimeo--roving-orientation-value="horizontal"');
        expect(d?.fix?.text).toBe("vertical");
        expect(d?.fix?.title).toContain('"vertical"');
      });

      it("follows the host's authored orientation (horizontal list)", () => {
        // On a horizontal list the roving default aligns, so a bare roving is
        // fine — and an authored vertical is now the mismatch.
        const horizontal = ' data-stimeo--sortable-orientation-value="horizontal"';
        expect(codes(sortable({ scope: horizontal }))).toEqual([]);
        const d = checkSource(
          sortable({ scope: horizontal, list: 'data-stimeo--roving-orientation-value="vertical"' }),
          manifest,
        ).find((x) => x.code === "composition-mismatch");
        expect(d?.message).toContain('"horizontal", "both"');
      });

      it("checks the scope element when the optional list target is absent", () => {
        // Without a `list` target the controller element is the list, so the
        // co-located roving sits on the scope element itself.
        const merged = (rovingAttrs: string) => `
          <ul data-controller="stimeo--sortable stimeo--roving" ${rovingAttrs} aria-label="Cards">
            <li data-stimeo--sortable-target="item">
              <button type="button" aria-label="Reorder A" data-stimeo--roving-target="item">A</button>
            </li>
          </ul>`;
        const d = checkSource(merged(""), manifest).find((x) => x.code === "composition-mismatch");
        expect(d?.message).toContain("scope element");
        expect(codes(merged('data-stimeo--roving-orientation-value="vertical"'))).toEqual([]);
      });

      it("flags an off-axis pointer-drag lock and accepts the aligned or default axis", () => {
        // pointer-drag defaults to `both`, which drags on any axis — only an
        // authored cross-axis lock breaks grabbed arrow moves.
        const aligned = { list: 'data-stimeo--roving-orientation-value="vertical"' };
        expect(codes(sortable(aligned))).toEqual([]);
        expect(
          codes(sortable({ ...aligned, item: 'data-stimeo--pointer-drag-axis-value="y"' })),
        ).toEqual([]);
        const d = checkSource(
          sortable({ ...aligned, item: 'data-stimeo--pointer-drag-axis-value="x"' }),
          manifest,
        ).find((x) => x.code === "composition-mismatch");
        expect(d?.message).toContain('data-stimeo--pointer-drag-axis-value="x"');
        expect(d?.fix?.text).toBe("y");
      });

      it("skips ERB-generated values on either side (undecidable)", () => {
        expect(
          codes(sortable({ list: 'data-stimeo--roving-orientation-value="<%= o %>"' })),
        ).not.toContain("composition-mismatch");
        expect(
          codes(sortable({ scope: 'data-stimeo--sortable-orientation-value="<%= o %>"' })),
        ).not.toContain("composition-mismatch");
      });

      it("only constrains the companion on the composition element", () => {
        // A roving elsewhere inside the sortable scope is its own composite,
        // not the handles' Tab stop — the contract must not leak onto it.
        const aside = `
          <div data-controller="stimeo--sortable">
            <ul data-stimeo--sortable-target="list" aria-label="Cards">
              <li data-stimeo--sortable-target="item">A</li>
            </ul>
            <div data-controller="stimeo--roving">
              <button type="button" data-stimeo--roving-target="item">B</button>
            </div>
          </div>`;
        expect(codes(aside)).not.toContain("composition-mismatch");
      });

      it("is suppressible via data-stimeo-ignore on the element", () => {
        expect(codes(sortable({ list: 'data-stimeo-ignore="composition-mismatch"' }))).toEqual([]);
      });
    });

    describe("requirements conditioned on the controller's own value", () => {
      // A toolbar's `aria-orientation` is the author's job, but only in the
      // vertical configuration: `horizontal` is the implicit ARIA default, so an
      // unconditional rule would reject every correct horizontal toolbar.
      const toolbar = ({ orientation = "", aria = "" } = {}) => `
        <div data-controller="stimeo--toolbar" role="toolbar" aria-label="Format"
             ${orientation} ${aria}>
          <button type="button" data-stimeo--toolbar-target="control">B</button>
        </div>`;

      it("stays silent in the default configuration", () => {
        expect(codes(toolbar())).toEqual([]);
      });

      it("stays silent when the value is authored as the default", () => {
        expect(
          codes(toolbar({ orientation: 'data-stimeo--toolbar-orientation-value="horizontal"' })),
        ).toEqual([]);
      });

      it("requires the attribute once the value arms the rule", () => {
        const d = checkSource(
          toolbar({ orientation: 'data-stimeo--toolbar-orientation-value="vertical"' }),
          manifest,
        ).find((x) => x.code === "missing-aria");
        expect(d?.severity).toBe("error");
        expect(d?.message).toContain("aria-orientation");
        expect(d?.suggestion).toContain('aria-orientation="vertical"');
      });

      it("accepts the armed configuration once the attribute is there", () => {
        expect(
          codes(
            toolbar({
              orientation: 'data-stimeo--toolbar-orientation-value="vertical"',
              aria: 'aria-orientation="vertical"',
            }),
          ),
        ).toEqual([]);
      });

      it("still checks the value of an attribute the condition armed", () => {
        const d = checkSource(
          toolbar({
            orientation: 'data-stimeo--toolbar-orientation-value="vertical"',
            aria: 'aria-orientation="horizontal"',
          }),
          manifest,
        ).find((x) => x.code === "invalid-aria-value");
        expect(d?.message).toContain('aria-orientation="horizontal"');
      });

      it("skips the requirement when the deciding value is ERB-generated", () => {
        // Undecidable, not absent: the page may render either configuration, so
        // reporting would invent a violation half the time.
        expect(
          codes(toolbar({ orientation: 'data-stimeo--toolbar-orientation-value="<%= axis %>"' })),
        ).toEqual([]);
      });

      it("treats a partly interpolated value as undecidable, not as its literal remnant", () => {
        // Neutralization blanks the ERB tag in place, so the leftover text reads
        // as a whole value and would arm the rule against markup whose rendered
        // value nobody has seen. Only "the value is ERB-touched at all" is a
        // sound reading here.
        expect(
          codes(
            toolbar({
              orientation: 'data-stimeo--toolbar-orientation-value="<%= prefix %>vertical"',
            }),
          ),
        ).toEqual([]);
      });
    });

    describe("required companion controllers", () => {
      // The More wrapper is a menu the overflow controller only fills; without
      // the menu controller the banked items are unreachable, and nothing else
      // in the schema notices because there is no companion to check.
      const overflow = (more: string, menu = "") => `
        <nav data-controller="stimeo--overflow-menu" aria-label="Actions">
          <div data-stimeo--overflow-menu-target="items"><button type="button">Save</button></div>
          <div data-stimeo--overflow-menu-target="more" ${more} hidden>
            <button type="button" id="more" aria-haspopup="menu" aria-expanded="false"
                    data-action="click->stimeo--menu#toggle" ${menu ? 'data-stimeo--menu-target="trigger"' : ""}>More</button>
            ${menu}
          </div>
        </nav>`;
      /** The wired form: Menu present, with the targets its own contract requires. */
      const wired =
        '<div role="menu" aria-labelledby="more" data-stimeo--menu-target="menu" hidden></div>';

      it("accepts the documented composition", () => {
        expect(codes(overflow('data-controller="stimeo--menu"', wired))).toEqual([]);
      });

      it("flags a More wrapper that never declares the menu controller", () => {
        const all = checkSource(overflow(""), manifest);
        expect(all.filter((x) => x.code === "missing-companion")).toHaveLength(1);
        const [d] = all;
        expect(d?.severity).toBe("error");
        expect(d?.message).toContain('"stimeo--menu"');
        expect(d?.suggestion).toContain('data-controller="stimeo--menu"');
      });

      it("skips an ERB-generated data-controller", () => {
        expect(codes(overflow('data-controller="<%= controllers %>"'))).not.toContain(
          "missing-companion",
        );
      });

      it("is suppressible via data-stimeo-ignore on the element", () => {
        expect(codes(overflow('data-stimeo-ignore="missing-companion"'))).toEqual([]);
      });
    });

    describe("reverse-direction target declarations", () => {
      // The failure no forward rule can see: markup that a screen reader
      // announces as part of the tree, but which the controller never manages
      // because it is absent from the target set every forward rule reads.
      const tree = (extra = "") => `
        <ul data-controller="stimeo--tree-view" role="tree" aria-label="Files">
          <li role="treeitem" aria-selected="false" tabindex="0"
              data-stimeo--tree-view-target="item">a</li>
          ${extra}
        </ul>`;

      it("accepts treeitems that are declared items", () => {
        expect(codes(tree())).toEqual([]);
      });

      it("flags a treeitem that was never declared as an item target", () => {
        const all = checkSource(
          tree(`<li role="treeitem" aria-selected="false" tabindex="-1">b</li>`),
          manifest,
        );
        expect(all.filter((x) => x.code === "undeclared-target")).toHaveLength(1);
        const [d] = all;
        expect(d?.severity).toBe("error");
        expect(d?.message).toContain('role="treeitem"');
        expect(d?.suggestion).toContain('data-stimeo--tree-view-target="item"');
      });

      it("flags a treeitem declared as the wrong target", () => {
        expect(
          codes(
            tree(
              `<li role="treeitem" aria-selected="false" data-stimeo--tree-view-target="group">b</li>`,
            ),
          ),
        ).toContain("undeclared-target");
      });

      it("credits the nearest enclosing tree, so a nested item is judged once", () => {
        // Both scopes enclose the inner element, so without nearest-owner
        // resolution the same treeitem is reported twice — once per tree.
        const nested = `
          <ul data-controller="stimeo--tree-view" role="tree" aria-label="Outer">
            <li role="treeitem" aria-selected="false" tabindex="0"
                data-stimeo--tree-view-target="item">a
              <ul data-controller="stimeo--tree-view" role="tree" aria-label="Inner">
                <li role="treeitem" aria-selected="false" tabindex="-1">b</li>
              </ul>
            </li>
          </ul>`;
        expect(
          checkSource(nested, manifest).filter((x) => x.code === "undeclared-target"),
        ).toHaveLength(1);
      });

      it("skips an ERB-generated role", () => {
        expect(codes(tree(`<li role="<%= role %>" aria-selected="false">b</li>`))).not.toContain(
          "undeclared-target",
        );
      });

      it("is suppressible via data-stimeo-ignore on the element", () => {
        expect(
          codes(
            tree(
              `<li role="treeitem" aria-selected="false" data-stimeo-ignore="undeclared-target">b</li>`,
            ),
          ),
        ).toEqual([]);
      });
    });

    describe("requirements conditioned on the element's own contents", () => {
      // A menu the consumer fills asynchronously is supported markup, but
      // `role="menu"` requires owned menuitems — so the author declares the
      // temporary absence, and only while the menu is structurally empty.
      const menubar = ({ empty = "", filled = 'aria-busy="true"' } = {}) => `
        <div data-controller="stimeo--menubar" role="menubar" aria-label="Main">
          <button id="t-file" role="menuitem" aria-controls="m-file" data-stimeo--menubar-target="top">File</button>
          <ul id="m-file" role="menu" aria-labelledby="t-file" data-stimeo--menubar-target="menu" ${filled} hidden>
            <li role="none"><button role="menuitem" tabindex="-1"
                    data-stimeo--menubar-target="item">New</button></li>
          </ul>
          <button id="t-recent" role="menuitem" aria-controls="m-recent" data-stimeo--menubar-target="top">Recent</button>
          <ul id="m-recent" role="menu" aria-labelledby="t-recent" data-stimeo--menubar-target="menu" ${empty} hidden></ul>
        </div>`;

      it("accepts an empty menu that declares the absence, next to a filled one", () => {
        expect(codes(menubar({ empty: 'aria-busy="true"', filled: "" }))).toEqual([]);
      });

      it("requires the attribute on a menu that holds no items", () => {
        const all = checkSource(menubar({ empty: "", filled: "" }), manifest);
        const missing = all.filter((x) => x.code === "missing-aria");
        expect(missing).toHaveLength(1);
        expect(missing[0]?.severity).toBe("error");
        expect(missing[0]?.message).toContain("aria-busy");
        expect(missing[0]?.suggestion).toContain('aria-busy="true"');
      });

      it("judges each element separately, not the scope as a whole", () => {
        // The filled menu must stay silent while its empty sibling is reported —
        // a scope-level condition could not tell the two apart.
        const source = menubar({ empty: "", filled: "" });
        const line = checkSource(source, manifest).find((x) => x.code === "missing-aria")?.line;
        expect(source.split("\n")[line ? line - 1 : 0]).toContain("m-recent");
      });

      it("still checks the value on a menu the condition armed", () => {
        const d = checkSource(menubar({ empty: 'aria-busy="false"', filled: "" }), manifest).find(
          (x) => x.code === "invalid-aria-value",
        );
        expect(d?.message).toContain('aria-busy="false"');
      });

      it("does not count inert items as absent", () => {
        // A menu whose items exist but are all disabled is structurally
        // satisfied — the requirement is about the items being *there*.
        const inert = `
          <div data-controller="stimeo--menubar" role="menubar" aria-label="Main">
            <button id="t-file" role="menuitem" aria-controls="m-file" data-stimeo--menubar-target="top">File</button>
            <ul id="m-file" role="menu" aria-labelledby="t-file" data-stimeo--menubar-target="menu" hidden>
              <li role="none"><button role="menuitem" tabindex="-1" disabled
                      data-stimeo--menubar-target="item">New</button></li>
            </ul>
          </div>`;
        expect(codes(inert)).toEqual([]);
      });

      it("accepts a menubar whose only menu is empty and declares itself busy", () => {
        // The wholly-async case the requirement exists for. Requiring `item`
        // scope-wide would reject it before this rule ever ran, so the two
        // contracts have to agree: emptiness is judged per menu, not per scope.
        const async = `
          <div data-controller="stimeo--menubar" role="menubar" aria-label="Main">
            <button id="t-file" role="menuitem" aria-controls="m-file" data-stimeo--menubar-target="top">File</button>
            <ul id="m-file" role="menu" aria-busy="true" aria-labelledby="t-file"
                data-stimeo--menubar-target="menu" hidden></ul>
          </div>`;
        expect(codes(async)).toEqual([]);
      });

      it("still reports the only menu when it is empty without declaring it", () => {
        // The other half of dropping the scope-level `item` requirement: the
        // absence must still be reported, just by the per-menu rule.
        const silent = `
          <div data-controller="stimeo--menubar" role="menubar" aria-label="Main">
            <button id="t-file" role="menuitem" aria-controls="m-file" data-stimeo--menubar-target="top">File</button>
            <ul id="m-file" role="menu" aria-labelledby="t-file" data-stimeo--menubar-target="menu" hidden></ul>
          </div>`;
        expect(codes(silent)).toEqual(["missing-aria"]);
      });

      it("is suppressible via data-stimeo-ignore on the element", () => {
        expect(codes(menubar({ empty: 'data-stimeo-ignore="missing-aria"', filled: "" }))).toEqual(
          [],
        );
      });
    });

    // ARIA levels its accessible-name requirements — required, recommended, and
    // conditional on the rest of the page. v7 mirrors those levels instead of
    // flattening them into one severity, so the check says "broken" only where
    // ARIA does.
    describe("accessible-name requirement levels (schema v7)", () => {
      const missingAria = (source: string): Diagnostic[] =>
        checkSource(source, manifest).filter((d) => d.code === "missing-aria");

      it("reports a required name as an error", () => {
        const missing = missingAria(`
          <ul data-controller="stimeo--tree-view" role="tree">
            <li role="treeitem" data-stimeo--tree-view-target="item">A</li>
          </ul>`);
        expect(missing).toHaveLength(1);
        expect(missing[0]?.severity).toBe("error");
        expect(missing[0]?.message).toContain("requires");
      });

      it("reports a recommended name as a warning, and words it as a recommendation", () => {
        const missing = missingAria(`
          <div data-controller="stimeo--toolbar" role="toolbar">
            <button data-stimeo--toolbar-target="control">Bold</button>
          </div>`);
        expect(missing).toHaveLength(1);
        expect(missing[0]?.severity).toBe("warning");
        // The verb is the part a reader acts on: "requires" here would misstate
        // the contract as firmly as the wrong severity would.
        expect(missing[0]?.message).toContain("recommends");
        expect(missing[0]?.message).not.toContain("requires");
      });

      describe("names a native tag already provides", () => {
        const grid = (tag: string) =>
          `<${tag} data-controller="stimeo--data-grid" role="grid"></${tag}>`;

        it("disarms on the tag that names the role natively", () => {
          // A <table> takes its name from <caption>, which no attribute check
          // can see — flagging it would reject correct markup.
          expect(missingAria(grid("table"))).toHaveLength(0);
        });

        it("stays armed on the spelling with no native naming path", () => {
          const missing = missingAria(grid("div"));
          expect(missing).toHaveLength(1);
          expect(missing[0]?.severity).toBe("error");
        });

        it("exempts a fieldset radiogroup but not a div one", () => {
          const radios = (tag: string) => `
            <${tag} data-controller="stimeo--radio-group" role="radiogroup">
              <div role="radio" data-stimeo--radio-group-target="radio">A</div>
            </${tag}>`;
          expect(missingAria(radios("fieldset"))).toHaveLength(0);
          expect(missingAria(radios("div"))).toHaveLength(1);
        });

        it("exempts a native input combobox while still requiring the popup's name", () => {
          const missing = missingAria(`
            <div data-controller="stimeo--combobox">
              <input role="combobox" aria-autocomplete="list" data-stimeo--combobox-target="input">
              <ul role="listbox" data-stimeo--combobox-target="list"></ul>
            </div>`);
          // The input is exempt (a <label for> may sit in another partial); the
          // listbox is a plain <ul> with no such path and stays required.
          expect(missing).toHaveLength(1);
          expect(missing[0]?.message).toContain('"list" target');
        });

        it("still requires the name when the combobox is not a native control", () => {
          // The exemption is the tag's, not the role's: a div spelling of the
          // same combobox has no <label for> to reach and stays checked.
          const missing = missingAria(`
            <div data-controller="stimeo--combobox">
              <div role="combobox" aria-autocomplete="list" data-stimeo--combobox-target="input"></div>
              <ul role="listbox" aria-label="Fruit" data-stimeo--combobox-target="list"></ul>
            </div>`);
          expect(missing).toHaveLength(1);
          expect(missing[0]?.message).toContain('"input" target');
          expect(missing[0]?.severity).toBe("error");
        });
      });

      it("requires a name on the listbox a trigger opens", () => {
        const missing = missingAria(`
          <div data-controller="stimeo--listbox">
            <span id="l">Fruit</span>
            <button role="combobox" aria-labelledby="l v" data-stimeo--listbox-target="trigger">
              <span id="v" data-stimeo--listbox-target="value">Apple</span>
            </button>
            <ul role="listbox" data-stimeo--listbox-target="list" hidden>
              <li role="option" data-stimeo--listbox-target="option">Apple</li>
            </ul>
          </div>`);
        expect(missing).toHaveLength(1);
        expect(missing[0]?.message).toContain('"list" target');
        expect(missing[0]?.severity).toBe("error");
      });

      it("recommends a name on the menubar itself, not only on its menus", () => {
        const missing = missingAria(`
          <div data-controller="stimeo--menubar" role="menubar">
            <button id="t" role="menuitem" aria-controls="m" data-stimeo--menubar-target="top">File</button>
            <ul id="m" role="menu" aria-labelledby="t" data-stimeo--menubar-target="menu" hidden>
              <li role="none"><button role="menuitem" tabindex="-1"
                      data-stimeo--menubar-target="item">New</button></li>
            </ul>
          </div>`);
        expect(missing).toHaveLength(1);
        expect(missing[0]?.message).toContain("scope element");
        expect(missing[0]?.severity).toBe("warning");
      });

      it("requires a name on every carousel slide", () => {
        const missing = missingAria(`
          <div data-controller="stimeo--carousel" aria-roledescription="carousel" aria-label="Photos">
            <div role="tabpanel" aria-roledescription="slide"
                 data-stimeo--carousel-target="slide">One</div>
          </div>`);
        expect(missing).toHaveLength(1);
        expect(missing[0]?.message).toContain('"slide" target');
        expect(missing[0]?.severity).toBe("error");
      });

      describe("levels that depend on the rest of the file", () => {
        const toolbar = `<div data-controller="stimeo--toolbar" role="toolbar"></div>`;

        it("leaves a lone toolbar at the recommended level", () => {
          const missing = missingAria(toolbar);
          expect(missing).toHaveLength(1);
          expect(missing[0]?.severity).toBe("warning");
        });

        it("escalates to an error once the file holds a second toolbar", () => {
          const missing = missingAria(`${toolbar}\n${toolbar}`);
          expect(missing).toHaveLength(2);
          expect(missing.every((d) => d.severity === "error")).toBe(true);
        });

        it("counts the role, not the controller, when deciding to escalate", () => {
          // A second toolbar that is not a Stimeo scope still makes the pair
          // indistinguishable, which is the condition ARIA actually states.
          const missing = missingAria(`${toolbar}\n<div role="toolbar"></div>`);
          expect(missing).toHaveLength(1);
          expect(missing[0]?.severity).toBe("error");
        });

        it("does not escalate on a partly ERB-generated role", () => {
          // Neutralization blanks the tag but preserves offsets, so
          // `role="<%= p %>toolbar"` trims back to a literal-looking "toolbar".
          // Reading that remnant would escalate the level on a guess — the same
          // trap the cardinality counts and target names already avoid.
          const missing = missingAria(`${toolbar}\n<div role="<%= p %>toolbar"></div>`);
          expect(missing).toHaveLength(1);
          expect(missing[0]?.severity).toBe("warning");
        });

        it("leaves a lone separator unchecked and arms on the second", () => {
          // tabindex is not decoration here: the contract makes the splitter a
          // Tab stop, and the condition counts only what a user can reach.
          const separators = (count: number) => `
            <div data-controller="stimeo--resizable">
              ${'<div role="separator" tabindex="0" data-stimeo--resizable-target="separator"></div>'.repeat(count)}
            </div>`;
          // Discretionary alone: a single splitter is unambiguous, so demanding
          // a name would add an announcement the user gains nothing from.
          expect(missingAria(separators(1))).toHaveLength(0);
          const armed = missingAria(separators(2));
          expect(armed).toHaveLength(2);
          expect(armed.every((d) => d.severity === "warning")).toBe(true);
        });

        it("does not arm on a separator the user cannot reach", () => {
          // ARIA qualifies this condition by focusability: a decorative
          // `hr role="separator"` is not somewhere focus can land, so it never
          // creates the ambiguity a name would resolve. Counting every carrier
          // of the role would warn about a page with one reachable splitter.
          const withDecorative = `
            <div data-controller="stimeo--resizable">
              <div role="separator" tabindex="0" data-stimeo--resizable-target="separator"></div>
            </div>
            <hr role="separator">`;
          expect(missingAria(withDecorative)).toHaveLength(0);
        });
      });
    });

    describe("attributes the surrounding markup contradicts", () => {
      const menu = (busy: string) => `
        <div data-controller="stimeo--menubar" role="menubar" aria-label="Main">
          <button id="t-file" role="menuitem" aria-controls="m-file" data-stimeo--menubar-target="top">File</button>
          <ul id="m-file" role="menu" aria-labelledby="t-file" data-stimeo--menubar-target="menu" ${busy} hidden>
            <li role="none"><button role="menuitem" tabindex="-1"
                    data-stimeo--menubar-target="item">New</button></li>
          </ul>
        </div>`;

      it("warns when a filled menu still declares itself busy", () => {
        const all = checkSource(menu('aria-busy="true"'), manifest);
        const forbidden = all.filter((x) => x.code === "forbidden-aria");
        expect(forbidden).toHaveLength(1);
        // Warning, not error: one file at one instant cannot separate a stale
        // declaration from a menu still streaming its items in.
        expect(forbidden[0]?.severity).toBe("warning");
        expect(forbidden[0]?.message).toContain("aria-busy");
        expect(forbidden[0]?.suggestion).toContain("Drop aria-busy");
      });

      it("stays silent for the value that is not forbidden", () => {
        expect(codes(menu('aria-busy="false"'))).not.toContain("forbidden-aria");
      });

      it("stays silent when the attribute is absent", () => {
        expect(codes(menu(""))).toEqual([]);
      });

      it("skips an ERB-generated value when the rule names specific ones", () => {
        expect(codes(menu('aria-busy="<%= loading %>"'))).not.toContain("forbidden-aria");
      });

      it("is suppressible via data-stimeo-ignore on the element", () => {
        expect(codes(menu('aria-busy="true" data-stimeo-ignore="forbidden-aria"'))).toEqual([]);
      });
    });

    describe("set-level cardinality", () => {
      // A second authored selection is normalized away on connect (first in DOM
      // order wins), so the source is the last place the mistake is visible.
      const tabs = (second: string, third = "") => `
        <div data-controller="stimeo--tabs">
          <div role="tablist" aria-label="Sections" data-stimeo--tabs-target="list">
            <button role="tab" aria-selected="true" data-stimeo--tabs-target="tab">A</button>
            <button role="tab" aria-selected="${second}" data-stimeo--tabs-target="tab">B</button>
            ${third}
          </div>
          <div role="tabpanel" aria-label="A" data-stimeo--tabs-target="panel">A</div>
          <div role="tabpanel" aria-label="B" data-stimeo--tabs-target="panel" hidden>B</div>
        </div>`;

      it("accepts a single selected element", () => {
        expect(codes(tabs("false"))).toEqual([]);
      });

      it("flags a second selected element and anchors on the one that is dropped", () => {
        const source = tabs("true");
        const all = checkSource(source, manifest);
        const violations = all.filter((x) => x.code === "cardinality-violation");
        expect(violations).toHaveLength(1);
        const [d] = violations;
        expect(d?.severity).toBe("error");
        expect(d?.message).toContain("at most 1");
        expect(d?.message).toContain("but found 2");
        // The *second* tab is the one connect deselects, so it is what the
        // author has to change — anchoring on the first would name the keeper.
        expect(source.split("\n")[d ? d.line - 1 : 0]).toContain(">B<");
      });

      it("does not count an ERB-generated value as a match", () => {
        // Under-counting is the safe direction: it can hide a violation but
        // never invent one, whereas a rendered "true" is a guess either way.
        expect(codes(tabs("<%= selected %>"))).not.toContain("cardinality-violation");
      });

      it("does not read a partly interpolated value as its literal remnant", () => {
        // Neutralization blanks the ERB tag in place, so `<%= prefix %>true`
        // trims to a bare "true" and would be counted as a second definite
        // selection — fabricating a violation the rendering may never produce.
        // The deciding-value condition already refuses to read such a remnant;
        // the count has to refuse it too.
        expect(codes(tabs("<%= prefix %>true"))).not.toContain("cardinality-violation");
      });

      it("still flags a definite over-count beside an ERB-generated value", () => {
        // The two literal `true`s are selected in every rendering, so waving the
        // whole count off as undecidable would forfeit a certain violation —
        // and `aria-selected="<%= … %>"` is ordinary Rails, so that stance would
        // switch the rule off across most real markup.
        const source = tabs(
          "true",
          `<button role="tab" aria-selected="<%= c %>" data-stimeo--tabs-target="tab">C</button>`,
        );
        expect(
          checkSource(source, manifest).filter((x) => x.code === "cardinality-violation"),
        ).toHaveLength(1);
      });

      it("is suppressible via data-stimeo-ignore", () => {
        const source = tabs("true").replace(
          'aria-selected="true" data-stimeo--tabs-target="tab">B',
          'aria-selected="true" data-stimeo-ignore="cardinality-violation" data-stimeo--tabs-target="tab">B',
        );
        expect(codes(source)).toEqual([]);
      });

      describe("conditioned on the controller's own value", () => {
        const grid = (selection: string) => `
          <table data-controller="stimeo--data-grid" role="grid" aria-label="Rows" ${selection}>
            <thead><tr><th role="columnheader" data-stimeo--data-grid-target="columnHeader"
                          tabindex="0">Name</th></tr></thead>
            <tbody>
              <tr role="row" aria-selected="true" data-stimeo--data-grid-target="row">
                <td role="gridcell" data-stimeo--data-grid-target="cell" tabindex="-1">a</td>
              </tr>
              <tr role="row" aria-selected="true" data-stimeo--data-grid-target="row">
                <td role="gridcell" data-stimeo--data-grid-target="cell" tabindex="-1">b</td>
              </tr>
            </tbody>
          </table>`;

        it("bounds the count only in the single-selection configuration", () => {
          expect(codes(grid('data-stimeo--data-grid-selection-value="single"'))).toContain(
            "cardinality-violation",
          );
        });

        it("allows several when the configuration is multiple", () => {
          expect(codes(grid('data-stimeo--data-grid-selection-value="multiple"'))).not.toContain(
            "cardinality-violation",
          );
        });

        it("stays disarmed on the declared default", () => {
          expect(codes(grid(""))).not.toContain("cardinality-violation");
        });

        it("skips an ERB-generated deciding value", () => {
          expect(codes(grid('data-stimeo--data-grid-selection-value="<%= mode %>"'))).not.toContain(
            "cardinality-violation",
          );
        });
      });

      describe("counted per container target", () => {
        // A hoverArea stands in for the one trigger it wraps: hovering an area
        // holding several always resolves to the first, silently.
        const item = (id: string) => `
          <button data-stimeo--navigation-menu-target="trigger" aria-expanded="false"
                  aria-controls="${id}">P</button>
          <div id="${id}" data-stimeo--navigation-menu-target="panel" hidden>
            <a href="/a">A</a>
          </div>`;
        const nav = (inner: string) => `
          <nav data-controller="stimeo--navigation-menu" aria-label="Main"
               data-stimeo--navigation-menu-open-on-hover-value="true">
            <ul>${inner}</ul>
          </nav>`;

        it("accepts a wrapper holding exactly one trigger", () => {
          expect(
            codes(nav(`<li data-stimeo--navigation-menu-target="hoverArea">${item("p1")}</li>`)),
          ).toEqual([]);
        });

        it("flags a wrapper holding several triggers", () => {
          const all = checkSource(
            nav(
              `<li data-stimeo--navigation-menu-target="hoverArea">${item("p1")}${item("p2")}</li>`,
            ),
            manifest,
          );
          const violations = all.filter((x) => x.code === "cardinality-violation");
          expect(violations).toHaveLength(1);
          expect(violations[0]?.message).toContain("at most 1");
          expect(violations[0]?.message).toContain('per "hoverArea" target');
          expect(violations[0]?.suggestion).toContain("exactly one trigger");
        });

        it("flags a wrapper holding no trigger at all", () => {
          const all = checkSource(
            nav(
              `<li data-stimeo--navigation-menu-target="hoverArea"><span>Nothing</span></li>
               <li>${item("p1")}</li>`,
            ),
            manifest,
          );
          const violations = all.filter((x) => x.code === "cardinality-violation");
          expect(violations).toHaveLength(1);
          expect(violations[0]?.message).toContain("at least 1");
          expect(violations[0]?.message).toContain("but found 0");
        });

        it("counts each wrapper separately", () => {
          // Two correct wrappers must not be summed into one over-count.
          expect(
            codes(
              nav(
                `<li data-stimeo--navigation-menu-target="hoverArea">${item("p1")}</li>
                 <li data-stimeo--navigation-menu-target="hoverArea">${item("p2")}</li>`,
              ),
            ),
          ).toEqual([]);
        });

        it("ignores triggers outside the wrapper", () => {
          expect(
            codes(
              nav(
                `<li data-stimeo--navigation-menu-target="hoverArea">${item("p1")}</li>
                 <li>${item("p2")}</li>`,
              ),
            ),
          ).toEqual([]);
        });
      });
    });

    describe("ARIA idref resolution", () => {
      it("warns on a dangling reference with a nearest-id suggestion", () => {
        const source = validDialog.replace('aria-labelledby="t"', 'aria-labelledby="tt"');
        const d = checkSource(source, manifest).find((x) => x.code === "unresolved-idref");
        expect(d?.severity).toBe("warning");
        expect(d?.message).toContain('references id "tt"');
        expect(d?.suggestion).toBe('Did you mean "t"?');
      });

      it("skips ERB-generated reference values and ids", () => {
        const source = `
          <div data-controller="stimeo--tabs">
            <div role="tablist" aria-label="Generated tabs"
                 data-stimeo--tabs-target="list">
              <button role="tab" aria-controls="panel-<%= i %>"
                      data-stimeo--tabs-target="tab">A</button>
            </div>
            <div role="tabpanel" id="panel-<%= i %>" data-stimeo--tabs-target="panel">A</div>
          </div>`;
        expect(codes(source)).not.toContain("unresolved-idref");
      });
    });

    describe("suppression (data-stimeo-ignore)", () => {
      it("suppresses a listed code for the subtree and keeps others", () => {
        const bare = `
          <div data-controller="stimeo--tabs" data-stimeo-ignore="missing-aria">
            <div role="tablist" aria-label="Sections" data-stimeo--tabs-target="list">
              <button data-stimeo--tabs-target="tab">A</button>
            </div>
            <div aria-label="A" data-stimeo--tabs-target="panel">A</div>
          </div>`;
        expect(codes(bare)).toEqual([]);
        expect(
          codes(
            bare.replace(
              'data-stimeo-ignore="missing-aria"',
              'data-stimeo-ignore="unresolved-idref"',
            ),
          ).filter((c) => c === "missing-aria"),
        ).toHaveLength(2);
      });

      it("suppresses everything under an empty-valued ignore", () => {
        expect(
          codes(`<div data-stimeo-ignore=""><div data-controller="stimeo--tabs"></div></div>`),
        ).toEqual([]);
      });

      it("spell-checks the ignore list itself, unsuppressibly", () => {
        const d = checkSource(`<div data-stimeo-ignore="missin-aria"></div>`, manifest).find(
          (x) => x.code === "unknown-ignore-code",
        );
        expect(d?.severity).toBe("warning");
        expect(d?.suggestion).toBe('Did you mean "missing-aria"?');
      });
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

    it("does not read a partly interpolated target name as its literal remnant", () => {
      // Neutralization blanks the tag in place, so `<%= prefix %>tab` is left
      // reading as "tab". Taking that would register a target the runtime never
      // resolves — and silence the required-target check that a fully generated
      // name (below) still trips. Undecidable, so the two must agree.
      const tabs = (name: string) => `
        <div data-controller="stimeo--tabs">
          <div role="tablist" aria-label="Sections" data-stimeo--tabs-target="list">
            <button role="tab" id="t1" aria-controls="p1" data-stimeo--tabs-target="${name}">A</button>
          </div>
          <div role="tabpanel" id="p1" aria-labelledby="t1" data-stimeo--tabs-target="panel"></div>
        </div>`;
      expect(codes(tabs("<%= prefix %>tab"))).toEqual(["missing-required-target"]);
      expect(codes(tabs("<%= prefix %>tab"))).toEqual(codes(tabs("<%= prefix %>")));
    });

    it("does not count a partly interpolated target name toward a cardinality bound", () => {
      // The same remnant reaching the count would report an over-count among
      // elements the runtime does not even own.
      const source = `
        <ul data-controller="stimeo--tree-view" role="tree" aria-label="Files">
          <li role="treeitem" aria-selected="true" tabindex="0"
              data-stimeo--tree-view-target="item">a</li>
          <li role="treeitem" aria-selected="true" tabindex="-1"
              data-stimeo--tree-view-target="<%= prefix %>item">b</li>
        </ul>`;
      expect(codes(source)).toEqual([]);
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

  /**
   * Rails renders the same wiring two ways, and a checker that reads only the
   * HTML spelling is worse than silent about the other: it reports the targets
   * it cannot see as missing while the mistakes inside them go unmentioned.
   * These cover both directions — the wiring is checked, and what the template
   * genuinely does not say is a warning rather than a failed build.
   */
  describe("Rails data: hashes", () => {
    it("checks a target name written as a helper's data: hash", () => {
      const source = `<div data-controller="stimeo--form-field">
        <%= f.text_area :body, data: { "stimeo--form-field-target": "controlTYPO" } %>
      </div>`;
      const [d] = checkSource(source, manifest).filter((x) => x.code === "unknown-target");
      expect(d?.message).toContain('Unknown target "controlTYPO"');
      expect(d?.line).toBe(2);
      // The misspelling and the requirement it leaves unmet are separate facts,
      // and the same effective markup spelled in HTML reports both — so this
      // spelling has to as well, or the two disagree about one page.
      expect(codes(source)).toEqual(["missing-required-target", "unknown-target"]);
    });

    it("anchors a diagnostic on the Ruby key, the only spelling the file holds", () => {
      const source = `<%= form_with url: "/x", data: { controller: "stimeo--menuu" } do |f| %>
        <span>hi</span>
      <% end %>`;
      const [d] = checkSource(source, manifest);
      const start = (d?.column ?? 1) - 1; // the diagnostic sits on line 1
      expect(source.slice(start, start + (d?.length ?? 0))).toBe("controller");
    });

    it("checks a controller identifier written as a helper's data: hash", () => {
      const source = `<%= form_with url: "/x", data: { controller: "stimeo--menuu" } do |f| %>
        <span>hi</span>
      <% end %>`;
      const [d] = checkSource(source, manifest);
      expect(d?.code).toBe("unknown-controller");
      expect(d?.suggestion).toBe('Did you mean "stimeo--menu"?');
    });

    it("checks action descriptors written as a helper's data: hash", () => {
      const source = `<div data-controller="stimeo--dialog">
        <%= button_tag "Open", data: { action: "click->stimeo--dialog#opne" } %>
      </div>`;
      expect(codes(source)).toContain("unknown-action-method");
    });

    it("resolves a block helper's scope over the targets written under it", () => {
      // The whole point of the container: `data-controller` on the helper owns
      // the markup up to its `<% end %>`, so neither side is reported.
      const source = `<%= form_with url: "/x", data: { controller: "stimeo--form-field" } do |f| %>
        <%= f.label :body %>
        <%= f.text_area :body, data: { "stimeo--form-field-target": "control" } %>
      <% end %>`;
      expect(checkSource(source, manifest)).toEqual([]);
    });

    it("accepts the bare-symbol spelling of a hyphenated target attribute", () => {
      const source = `<div data-controller="stimeo--form-field">
        <%= f.text_area :body, data: { stimeo__form_field_target: "control" } %>
      </div>`;
      expect(checkSource(source, manifest)).toEqual([]);
    });

    it("offers a machine fix that rewrites the Ruby string literal in place", () => {
      const source = `<div data-controller="stimeo--menu">
        <%= button_tag "x", data: { "stimeo--menu-target": "trigge" } %>
      </div>`;
      const d = checkSource(source, manifest).find((x) => x.code === "unknown-target");
      const fix = d?.fix;
      expect(fix?.text).toBe("trigger");
      expect(source.slice(fix?.start, fix?.end)).toBe("trigge");
    });

    it("honors data-stimeo-ignore written as a hash entry", () => {
      const source = `<div data-controller="stimeo--form-field">
        <%= f.text_area :body, data: { "stimeo-ignore": "unknown-target",
                                       "stimeo--form-field-target": "control" } %>
        <%= f.text_field :other, data: { "stimeo-ignore": "unknown-target",
                                         "stimeo--form-field-target": "typo" } %>
      </div>`;
      expect(codes(source)).toEqual([]);
    });

    it("does not let a generated ignore value silence the subtree", () => {
      // Blanket suppression is the reading of an *empty* list, and a value
      // nobody can read is not empty — it is unknown.
      const hash = `<div data-controller="stimeo--form-field">
        <%= f.text_area :body, data: { "stimeo-ignore": ignored,
                                       "stimeo--form-field-target": "controlTYPO" } %>
      </div>`;
      expect(codes(hash)).toContain("unknown-target");
      const markup = `<div data-controller="stimeo--form-field" data-stimeo-ignore="<%= ignored %>">
        <textarea data-stimeo--form-field-target="controlTYPO"></textarea>
      </div>`;
      expect(codes(markup)).toContain("unknown-target");
    });

    describe("what the template does not say", () => {
      it("warns instead of failing when the data: option is not a literal", () => {
        const source = `<div data-controller="stimeo--form-field">
          <%= f.text_area :body, data: field_attrs %>
        </div>`;
        const [d] = checkSource(source, manifest);
        expect(d?.code).toBe("missing-required-target");
        expect(d?.severity).toBe("warning");
        expect(d?.suggestion).toContain("may exist at runtime");
      });

      it("warns instead of failing when the host controller is computed", () => {
        const source = `<%= tag.div data: { controller: kind } do %>
          <textarea data-stimeo--form-field-target="control"></textarea>
        <% end %>`;
        const [d] = checkSource(source, manifest);
        expect(d?.code).toBe("orphan-target");
        expect(d?.severity).toBe("warning");
      });

      it("warns instead of failing for targets a helper renders itself", () => {
        // `f.select` emits the whole listbox; none of its targets is authored,
        // so the scope's target set cannot be read from the template at all.
        const source = `<%= f.select :x, [], {}, data: { controller: "stimeo--listbox" } %>`;
        const diagnostics = checkSource(source, manifest);
        expect(diagnostics).not.toHaveLength(0);
        expect(diagnostics.every((d) => d.severity === "warning")).toBe(true);
      });

      it("warns instead of failing when a target's name is generated", () => {
        // The declaration is there and the runtime may well resolve it as the
        // required target; only its spelling is out of reach. Both ways of
        // writing it read the same, or the two spellings disagree about a page.
        for (const source of [
          `<div data-controller="stimeo--form-field">
            <%= f.text_area :body, data: { "stimeo--form-field-target": name } %>
          </div>`,
          `<div data-controller="stimeo--form-field">
            <textarea data-stimeo--form-field-target="<%= name %>"></textarea>
          </div>`,
        ]) {
          const [d] = checkSource(source, manifest);
          expect(d?.code).toBe("missing-required-target");
          expect(d?.severity).toBe("warning");
        }
      });

      it("keeps an outer scope failing over what its own markup plainly says", () => {
        // Whatever the helper renders belongs to the inner controller, which is
        // the nearest owner of anything written under it — so it hides nothing
        // from the outer one, whose required target is definitely absent.
        const source = `<div data-controller="stimeo--form-field">
          <div data-controller="stimeo--form-field">
            <%= f.text_area :body, data: field_attrs %>
            <textarea data-stimeo--form-field-target="control"></textarea>
          </div>
        </div>`;
        const [d] = checkSource(source, manifest);
        expect(d?.code).toBe("missing-required-target");
        expect(d?.severity).toBe("error");
      });

      it("keeps ARIA and keyboard rules silent about a helper's rendered tag", () => {
        // role / aria-* / tabindex are the helper's to emit and never appear in
        // the template, so their absence here is not evidence of anything.
        const source = `<div data-controller="stimeo--tabs">
          <div role="tablist" aria-label="Sections" data-stimeo--tabs-target="list">
            <%= button_tag "A", data: { "stimeo--tabs-target": "tab" } %>
          </div>
          <%= tag.div "A", data: { "stimeo--tabs-target": "panel" } %>
        </div>`;
        expect(codes(source)).toEqual([]);
      });
    });

    describe("what stays untouched", () => {
      it("leaves literal markup reporting exactly what it did before", () => {
        const source = `<div data-controller="stimeo--form-field">
          <textarea data-stimeo--form-field-target="controlTYPO"></textarea>
        </div>`;
        expect(codes(source)).toEqual(["missing-required-target", "unknown-target"]);
      });

      it("ignores a data: hash in a tag that renders nothing", () => {
        expect(codes(`<% attrs = { data: { controller: "stimeo--menuu" } } %>`)).toEqual([]);
      });

      it("ignores a data: hash inside an ERB comment", () => {
        expect(codes(`<%# data: { controller: "stimeo--menuu" } %>`)).toEqual([]);
      });

      it("clears an idiomatic Rails form that mixes both spellings", () => {
        // The shape a ViewComponent template actually takes: a block helper
        // scope, helper-rendered targets, literal markup for the parts that
        // need ARIA, and a sibling controller wired through data-action.
        const source = `<%= form_with url: "/messages", data: { controller: "stimeo--form-field" } do |f| %>
          <%= f.label :body, "Message" %>
          <%= f.text_area :body, rows: 3,
                data: { "stimeo--form-field-target": "control",
                        action: "input->stimeo--form-field#clearError" } %>
          <p id="body-help" data-stimeo--form-field-target="description">Markdown supported.</p>
          <p role="alert" data-stimeo--form-field-target="error"></p>
        <% end %>`;
        expect(checkSource(source, manifest)).toEqual([]);
      });

      it("ends a block helper's scope where the template ends it", () => {
        // The `<p>` is never closed, but the `<% end %>` is still the last
        // thing inside the form: the textarea below it is a sibling.
        const source = `<%= form_with url: "/x", data: { controller: "stimeo--form-field" } do |f| %>
          <p>Hint
        <% end %>
        <textarea data-stimeo--form-field-target="control"></textarea>`;
        expect(codes(source)).toEqual(["missing-required-target", "orphan-target"]);
      });

      it("keeps reading a hash that a percent literal or a regexp is written near", () => {
        const source = `<%= tag.div "x", title: /#/, class: %w[a b], data: { controller: "stimeo--form-field" } do %>
          <textarea data-stimeo--form-field-target="control"></textarea>
        <% end %>`;
        expect(checkSource(source, manifest)).toEqual([]);
      });

      it("does not read a data: hash written inside a percent literal", () => {
        expect(codes(`<%= tag.pre %q[data: { controller: "stimeo--menuu" }] %>`)).toEqual([]);
      });

      it("does not read a helper called inside a start tag as its own element", () => {
        // Those attributes belong to the surrounding tag; treating the call as
        // a sibling element would put the controller on the wrong scope.
        const source = `<div <%= tag.attributes(data: { controller: "stimeo--menu" }) %>>
          <button data-stimeo--menu-target="trigger"></button>
        </div>`;
        expect(codes(source)).toEqual(["orphan-target"]);
      });
    });
  });

  describe("machine-applicable fixes (stage 4)", () => {
    /** Applies a diagnostic's fix to the source it was computed from. */
    function applyFix(source: string, diagnostic: Diagnostic | undefined): string {
      const fix = diagnostic?.fix;
      if (!fix) throw new Error("expected the diagnostic to carry a fix");
      return source.slice(0, fix.start) + fix.text + source.slice(fix.end);
    }

    it("fixes a typo'd controller identifier in place", () => {
      const source = `<div data-controller="stimeo--menoo"></div>`;
      const [d] = checkSource(source, manifest);
      expect(d?.code).toBe("unknown-controller");
      expect(d?.fix?.text).toBe("stimeo--menu");
      expect(d?.fix?.title).toBe('Replace with "stimeo--menu"');
      // The fix range covers exactly the broken token.
      expect(source.slice(d?.fix?.start, d?.fix?.end)).toBe("stimeo--menoo");
      const fixed = applyFix(source, d);
      expect(checkSource(fixed, manifest).map((x) => x.code)).not.toContain("unknown-controller");
    });

    it("fixes a typo'd target name", () => {
      const source = `
        <div data-controller="stimeo--menu">
          <button data-stimeo--menu-target="triger"></button>
          <ul data-stimeo--menu-target="menu"></ul>
          <li data-stimeo--menu-target="item"></li>
        </div>`;
      const d = checkSource(source, manifest).find((x) => x.code === "unknown-target");
      expect(source.slice(d?.fix?.start, d?.fix?.end)).toBe("triger");
      const fixed = applyFix(source, d);
      expect(checkSource(fixed, manifest).map((x) => x.code)).not.toContain("unknown-target");
    });

    it("fixes a typo'd action method inside a compound descriptor", () => {
      const source = `
        <div data-controller="stimeo--menu">
          <button data-stimeo--menu-target="trigger" aria-haspopup="menu"
                  data-action="keydown.esc->stimeo--menu#close click->stimeo--menu#togle"></button>
          <ul role="menu" data-stimeo--menu-target="menu" hidden>
            <li role="none"><button role="menuitem" data-stimeo--menu-target="item"></button></li>
          </ul>
        </div>`;
      const d = checkSource(source, manifest).find((x) => x.code === "unknown-action-method");
      expect(source.slice(d?.fix?.start, d?.fix?.end)).toBe("togle");
      const fixed = applyFix(source, d);
      expect(checkSource(fixed, manifest).map((x) => x.code)).not.toContain(
        "unknown-action-method",
      );
    });

    it("fixes an invalid ARIA value when exactly one value is allowed", () => {
      const source = `
        <div data-controller="stimeo--dialog">
          <button data-stimeo--dialog-target="trigger" data-action="stimeo--dialog#open">Open</button>
          <div data-stimeo--dialog-target="dialog" role="dialog"
               aria-modal="yes" aria-label="Confirm" hidden></div>
        </div>`;
      const d = checkSource(source, manifest).find((x) => x.code === "invalid-aria-value");
      expect(d?.fix?.text).toBe("true");
      expect(d?.fix?.title).toBe('Set aria-modal to "true"');
      const fixed = applyFix(source, d);
      expect(checkSource(fixed, manifest).map((x) => x.code)).not.toContain("invalid-aria-value");
    });

    it("fixes an unresolved ARIA idref to the nearest declared id", () => {
      const source = `
        <div data-controller="stimeo--dialog">
          <button data-stimeo--dialog-target="trigger" data-action="stimeo--dialog#open">Open</button>
          <div data-stimeo--dialog-target="dialog" role="dialog"
               aria-modal="true" aria-labelledby="tt" hidden><h2 id="t">Title</h2></div>
        </div>`;
      const d = checkSource(source, manifest).find((x) => x.code === "unresolved-idref");
      expect(d?.fix?.text).toBe("t");
      const fixed = applyFix(source, d);
      expect(checkSource(fixed, manifest).map((x) => x.code)).not.toContain("unresolved-idref");
    });

    it("appends a required companion to an existing data-controller", () => {
      // Appending to a list is unambiguous; creating the attribute from nothing
      // would be an insertion the diagnostic's anchor cannot express, so that
      // case deliberately ships the suggestion alone.
      const source = `
        <nav data-controller="stimeo--overflow-menu" aria-label="Actions">
          <div data-stimeo--overflow-menu-target="items"><button type="button">Save</button></div>
          <div data-stimeo--overflow-menu-target="more" data-controller="stimeo--portal" hidden>
            <button type="button">More</button>
          </div>
        </nav>`;
      const d = checkSource(source, manifest).find((x) => x.code === "missing-companion");
      expect(d?.fix?.text).toBe("stimeo--portal stimeo--menu");
      expect(d?.fix?.title).toBe('Add "stimeo--menu" to data-controller');
      expect(checkSource(applyFix(source, d), manifest).map((x) => x.code)).not.toContain(
        "missing-companion",
      );
    });

    it("emits no fix when nothing is plausibly close", () => {
      const [d] = checkSource(`<div data-controller="stimeo--zzzzzzzzzz"></div>`, manifest);
      expect(d?.code).toBe("unknown-controller");
      expect(d?.fix).toBeUndefined();
    });
  });

  describe("anchored token length (editor ranges)", () => {
    it("spans the attribute name for attribute-anchored diagnostics", () => {
      const [d] = checkSource(`<div data-controller="stimeo--menoo"></div>`, manifest);
      expect(d?.code).toBe("unknown-controller");
      expect(d?.length).toBe("data-controller".length);
    });

    it("spans the opening <tag for element-anchored diagnostics", () => {
      const diagnostics = checkSource(
        `<section data-controller="stimeo--menu"></section>`,
        manifest,
      );
      const missing = diagnostics.find((d) => d.code === "missing-required-target");
      expect(missing?.length).toBe("<section".length);
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

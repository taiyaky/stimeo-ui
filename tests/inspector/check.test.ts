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
 * End-to-end tests for the Inspector engine (stage 1 names + stage 2 structure),
 * exercising the full pipeline: ERB neutralization → parse → extract → check.
 */
describe("checkSource", () => {
  const validMenu = `
    <div data-controller="stimeo--menu">
      <button aria-haspopup="menu" data-stimeo--menu-target="trigger"
              data-action="click->stimeo--menu#toggle">Actions</button>
      <ul role="menu" data-stimeo--menu-target="menu" hidden>
        <li role="none"><button role="menuitem" data-stimeo--menu-target="item"
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

    it('checks scope-element rules (target: "") on the data-controller element', () => {
      const bare = `
        <div data-controller="stimeo--toolbar">
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
          <ul role="listbox" data-stimeo--listbox-target="list" hidden>
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
            <button aria-haspopup="menu" data-stimeo--menu-target="trigger">Actions</button>
            <ul role="menu" data-stimeo--menu-target="menu" hidden>
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
            <button aria-haspopup="menu" data-stimeo--menu-target="trigger">Actions</button>
            <ul role="menu" data-stimeo--menu-target="menu" hidden>
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
            <div role="tablist" data-stimeo--tabs-target="list">
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
            <button data-stimeo--tabs-target="tab">A</button>
            <div data-stimeo--tabs-target="panel">A</div>
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

    it("does not treat event names inside <script> as attributes", () => {
      const source = `
        <div data-controller="stimeo--otp" id="x">
          <input data-stimeo--otp-target="field">
        </div>
        <script>document.getElementById('x').addEventListener('stimeo--otp:complete', () => {});</script>`;
      expect(checkSource(source, manifest)).toEqual([]);
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

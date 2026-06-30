import { afterEach, describe, expect, it, vi } from "vitest";
import { observeScrollDismiss } from "../../src/utils/scroll_dismiss";

/**
 * Unit tests for {@link observeScrollDismiss}: it must fire on a scroll of a
 * scrollable ancestor (not just the window — `scroll` does not bubble) and detach
 * every listener on cleanup.
 */
describe("observeScrollDismiss", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  const build = () => {
    document.body.innerHTML = `
      <div id="pane" style="overflow:auto; height:100px">
        <div id="inner"><span id="surface"></span></div>
      </div>`;
    return {
      pane: document.getElementById("pane") as HTMLElement,
      surface: document.getElementById("surface") as HTMLElement,
    };
  };

  it("fires when a scrollable ancestor scrolls", () => {
    const { pane, surface } = build();
    const onScroll = vi.fn();
    const stop = observeScrollDismiss(surface, onScroll);

    pane.dispatchEvent(new Event("scroll"));

    expect(onScroll).toHaveBeenCalledTimes(1);
    stop();
  });

  it("fires when the window scrolls", () => {
    const { surface } = build();
    const onScroll = vi.fn();
    const stop = observeScrollDismiss(surface, onScroll);

    window.dispatchEvent(new Event("scroll"));

    expect(onScroll).toHaveBeenCalledTimes(1);
    stop();
  });

  it("stops firing after cleanup", () => {
    const { pane, surface } = build();
    const onScroll = vi.fn();
    const stop = observeScrollDismiss(surface, onScroll);

    stop();
    pane.dispatchEvent(new Event("scroll"));
    window.dispatchEvent(new Event("scroll"));

    expect(onScroll).not.toHaveBeenCalled();
  });

  it("ignores a non-scrollable ancestor (visible overflow)", () => {
    document.body.innerHTML = `<div id="plain"><span id="s"></span></div>`;
    const plain = document.getElementById("plain") as HTMLElement;
    const onScroll = vi.fn();
    const stop = observeScrollDismiss(document.getElementById("s") as HTMLElement, onScroll);

    plain.dispatchEvent(new Event("scroll"));

    expect(onScroll).not.toHaveBeenCalled();
    stop();
  });
});

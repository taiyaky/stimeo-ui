import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChipRow } from "../../src/utils/chip_row";

/** Behavioral tests for delegated, replaceable removable-chip rows. */
describe("ChipRow", () => {
  let chipRow: ChipRow;
  let remove: ReturnType<typeof vi.fn<(index: number) => void>>;
  let getItems: ReturnType<typeof vi.fn<() => HTMLElement[]>>;

  const items = () => Array.from(document.querySelectorAll<HTMLElement>("[data-chip]"));
  const buttons = () => items().map((item) => item.querySelector("button") as HTMLButtonElement);
  const root = () => document.querySelector<HTMLElement>("#root") as HTMLElement;
  const input = () => document.querySelector<HTMLInputElement>("#input") as HTMLInputElement;

  beforeEach(() => {
    document.body.innerHTML = `
      <div id="root">
        <div id="row">
          <span data-chip><button type="button" tabindex="0"><span>A</span></button></span>
          <span data-chip><button type="button" tabindex="-1"><span>B</span></button></span>
          <button id="clear" type="button">Clear all</button>
        </div>
        <input id="input">
      </div>`;
    remove = vi.fn<(index: number) => void>();
    getItems = vi.fn(items);
    chipRow = new ChipRow({
      directionElement: root(),
      getItems,
      onRemove: remove,
      focusAfterEnd: () => input().focus(),
    });
    chipRow.connect(document.querySelector<HTMLElement>("#row") as HTMLElement);
  });

  afterEach(() => {
    chipRow.disconnect();
    document.body.innerHTML = "";
  });

  it("delegates a nested remove-button click by chip index", () => {
    buttons()[1]
      ?.querySelector("span")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(remove).toHaveBeenCalledExactlyOnceWith(1);
  });

  it("ignores buttons that do not belong to a declared chip item", () => {
    const clear = document.querySelector<HTMLButtonElement>("#clear") as HTMLButtonElement;
    clear.click();

    const keydown = new KeyboardEvent("keydown", {
      key: "ArrowRight",
      bubbles: true,
      cancelable: true,
    });
    clear.dispatchEvent(keydown);

    expect(remove).not.toHaveBeenCalled();
    expect(keydown.defaultPrevented).toBe(false);
    expect(chipRow.buttons).toEqual(buttons());
  });

  it("uses a consumer-declared remove button instead of another chip button", () => {
    chipRow.disconnect();
    for (const item of items()) {
      item.insertAdjacentHTML("afterbegin", '<button type="button" data-info>Info</button>');
      item
        .querySelector<HTMLButtonElement>("button:not([data-info])")
        ?.setAttribute("data-remove", "");
    }
    chipRow = new ChipRow({
      directionElement: root(),
      getItems,
      getButton: (item) => item.querySelector<HTMLButtonElement>("button[data-remove]"),
      onRemove: remove,
      focusAfterEnd: () => input().focus(),
    });
    chipRow.connect(document.querySelector<HTMLElement>("#row") as HTMLElement);

    const first = items()[0] as HTMLElement;
    const info = first.querySelector<HTMLButtonElement>("button[data-info]") as HTMLButtonElement;
    const removeButton = first.querySelector<HTMLButtonElement>(
      "button[data-remove]",
    ) as HTMLButtonElement;
    info.click();
    info.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true }));
    expect(remove).not.toHaveBeenCalled();

    removeButton.click();
    expect(remove).toHaveBeenCalledExactlyOnceWith(0);
    expect(chipRow.buttons).toEqual(
      items().map((item) => item.querySelector<HTMLButtonElement>("button[data-remove]")),
    );
  });

  it("ignores a delegated event whose target is not an element", () => {
    chipRow.disconnect();
    const row = document.querySelector<HTMLElement>("#row") as HTMLElement;
    const addEventListener = vi.spyOn(row, "addEventListener");
    chipRow.connect(row);
    const listener = addEventListener.mock.calls.find(([type]) => type === "click")?.[1];

    if (typeof listener === "function") {
      listener({ target: document.createTextNode("text") } as unknown as MouseEvent);
    } else {
      throw new Error("ChipRow did not register its delegated click listener");
    }

    expect(remove).not.toHaveBeenCalled();
  });

  it("omits declared chip items that do not contain a remove button", () => {
    document
      .querySelector<HTMLElement>("#row")
      ?.insertAdjacentHTML(
        "afterbegin",
        '<span data-chip><span aria-hidden="true">No action</span></span>',
      );

    expect(chipRow.buttons).toEqual(buttons().filter(Boolean));
    expect(chipRow.length).toBe(2);
    expect(chipRow.lastIndex).toBe(2);

    chipRow.buttons[0]?.click();
    expect(remove).toHaveBeenCalledExactlyOnceWith(1);

    items()[1]?.remove();
    expect(chipRow.focusAfterRemoval(1)).toBe(true);
    expect(document.activeElement).toBe(chipRow.buttons[0]);
  });

  it("moves logically through the row and hands the end back to the input", () => {
    buttons()[0]?.focus();
    buttons()[0]?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(document.activeElement).toBe(buttons()[1]);

    buttons()[1]?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(document.activeElement).toBe(input());
  });

  it("reads the chip collection once for one arrow-key operation", () => {
    const first = buttons()[0] as HTMLButtonElement;
    getItems.mockClear();

    first.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));

    expect(getItems).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(buttons()[1]);
  });

  it("delegates Delete while respecting already-consumed and modified keys", () => {
    const consumed = new KeyboardEvent("keydown", {
      key: "Delete",
      bubbles: true,
      cancelable: true,
    });
    consumed.preventDefault();
    buttons()[0]?.dispatchEvent(consumed);
    buttons()[0]?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", ctrlKey: true, bubbles: true }),
    );
    expect(remove).not.toHaveBeenCalled();

    buttons()[0]?.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true }));
    expect(remove).toHaveBeenCalledExactlyOnceWith(0);
  });

  it("keeps a replacement row bound when the stale target disconnects later", () => {
    const old = document.querySelector<HTMLElement>("#row") as HTMLElement;
    const replacement = old.cloneNode(true) as HTMLElement;
    old.replaceWith(replacement);

    chipRow.connect(replacement);
    chipRow.disconnect(old);
    replacement.querySelector<HTMLButtonElement>("button")?.click();

    expect(remove).toHaveBeenCalledExactlyOnceWith(0);
    old.querySelector<HTMLButtonElement>("button")?.click();
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it("leaves listener order unchanged when connecting the same row again", () => {
    const calls: string[] = [];
    remove.mockImplementation(() => calls.push("chip-row"));
    const row = document.querySelector<HTMLElement>("#row") as HTMLElement;
    row.addEventListener("click", () => calls.push("consumer"));

    chipRow.connect(row);
    buttons()[0]?.click();

    expect(calls).toEqual(["chip-row", "consumer"]);
  });

  it("seeds and re-homes the single Tab stop after removal", () => {
    for (const button of buttons()) button.tabIndex = 0;
    chipRow.ensureTabStop();
    expect(buttons().map((button) => button.tabIndex)).toEqual([0, -1]);

    for (const button of buttons()) button.tabIndex = -1;
    chipRow.ensureTabStop();
    expect(buttons().map((button) => button.tabIndex)).toEqual([0, -1]);

    items()[1]?.remove();
    expect(chipRow.focusAfterRemoval(1)).toBe(true);
    expect(document.activeElement).toBe(buttons()[0]);

    items()[0]?.remove();
    expect(chipRow.focusAfterRemoval(0)).toBe(false);
  });

  it("preserves the first authored Tab stop when normalizing duplicates", () => {
    document
      .querySelector<HTMLElement>("#clear")
      ?.insertAdjacentHTML(
        "beforebegin",
        '<span data-chip><button type="button" tabindex="0">C</button></span>',
      );
    const [first, second, third] = buttons() as [
      HTMLButtonElement,
      HTMLButtonElement,
      HTMLButtonElement,
    ];
    first.tabIndex = -1;
    second.tabIndex = 0;
    third.tabIndex = 0;

    chipRow.ensureTabStop();

    expect(buttons().map((button) => button.tabIndex)).toEqual([-1, 0, -1]);
  });

  it("reports that an empty row has no last chip to focus", () => {
    for (const item of items()) item.remove();

    expect(chipRow.focusLast()).toBe(false);
    expect(document.activeElement).not.toBe(input());
  });
});

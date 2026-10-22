import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAttributeIfChanged } from "../../src/utils/attribute_write";
import { AuthoredMutationWatcher } from "../../src/utils/authored_mutation_watcher";
import { tick } from "../helpers/timing";

/** Authored records survive exact write counts, synchronous drains, and connected lifetimes. */
describe("AuthoredMutationWatcher", () => {
  let root: HTMLElement;
  let child: HTMLElement;
  let watcher: AuthoredMutationWatcher;
  const delivered = vi.fn<(records: MutationRecord[]) => void>();

  beforeEach(() => {
    root = document.createElement("div");
    child = document.createElement("span");
    root.append(child);
    document.body.append(root);
    delivered.mockClear();
    watcher = new AuthoredMutationWatcher(delivered);
  });

  afterEach(() => {
    watcher.disconnect();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  const observe = () =>
    watcher.observe(root, {
      attributes: ["data-state", "data-other"],
      subtree: true,
      childList: true,
      ancestorAttributes: ["contenteditable"],
    });
  const write = (value: string | null, target = child, name = "data-state") =>
    setAttributeIfChanged(target, name, value, () => watcher.claim(target, name, value));

  it("delivers an authored batch once without changing the DOM", async () => {
    observe();
    child.setAttribute("data-state", "author");
    await tick();
    expect(delivered).toHaveBeenCalledExactlyOnceWith([
      expect.objectContaining({ target: child, attributeName: "data-state" }),
    ]);
    expect(child.getAttribute("data-state")).toBe("author");
  });

  it("returns queued authored records synchronously without invoking the callback", async () => {
    observe();
    child.setAttribute("data-state", "author");
    expect(watcher.take()).toHaveLength(1);
    await tick();
    expect(delivered).not.toHaveBeenCalled();
    expect(watcher.take()).toEqual([]);
  });

  it("excludes actual own writes from both synchronous and asynchronous delivery", async () => {
    observe();
    write("first");
    expect(watcher.take()).toEqual([]);
    write("second");
    await tick();
    expect(delivered).not.toHaveBeenCalled();
    child.setAttribute("data-state", "author");
    await tick();
    expect(delivered).toHaveBeenCalledTimes(1);
  });

  it("counts several own writes against their final value", () => {
    observe();
    write("first");
    write("second");
    write("first");
    expect(watcher.take()).toEqual([]);
  });

  it.each(["before", "after"])(
    "keeps an extra same-value author write %s its own write",
    (order) => {
      observe();
      if (order === "before") child.setAttribute("data-state", "same");
      watcher.claim(child, "data-state", "same");
      child.setAttribute("data-state", "same");
      if (order === "after") child.setAttribute("data-state", "same");
      expect(watcher.take()).toHaveLength(1);
    },
  );

  it("preserves a different final authored value rather than consuming its records", () => {
    observe();
    write("own");
    child.setAttribute("data-state", "author");
    expect(watcher.take()).toHaveLength(2);
  });

  it("keeps element and attribute claims separate", () => {
    observe();
    write("own");
    root.setAttribute("data-state", "own");
    child.setAttribute("data-other", "own");
    expect(watcher.take().map((record) => [record.target, record.attributeName])).toEqual([
      [root, "data-state"],
      [child, "data-other"],
    ]);
  });

  it("does not claim an idempotent write that produces no record", () => {
    child.setAttribute("data-state", "same");
    observe();
    write("same");
    child.setAttribute("data-state", "same");
    expect(watcher.take()).toHaveLength(1);
  });

  it.each([null, ""])("matches the distinct removed or empty value %s", (value) => {
    child.setAttribute("data-state", "present");
    observe();
    write(value);
    expect(watcher.take()).toEqual([]);
    child.setAttribute("data-state", value === null ? "" : "present");
    expect(watcher.take()).toHaveLength(1);
  });

  it("expires excess claims at a synchronous take", () => {
    observe();
    watcher.claim(child, "data-state", "same");
    watcher.claim(child, "data-state", "same");
    child.setAttribute("data-state", "same");
    expect(watcher.take()).toEqual([]);
    child.setAttribute("data-state", "same");
    expect(watcher.take()).toHaveLength(1);
  });

  it("expires unmatched claims even when the drained queue is empty", () => {
    observe();
    watcher.claim(child, "data-state", "same");
    expect(watcher.take()).toEqual([]);
    child.setAttribute("data-state", "same");
    expect(watcher.take()).toHaveLength(1);
  });

  it("expires excess claims before a callback can author the same value", async () => {
    observe();
    watcher.claim(child, "data-state", "own");
    watcher.claim(child, "data-state", "own");
    child.setAttribute("data-state", "own");
    root.setAttribute("data-other", "author");
    delivered.mockImplementationOnce(() => child.setAttribute("data-state", "own"));
    await tick();
    expect(delivered).toHaveBeenCalledTimes(2);
    expect(delivered.mock.calls[1]?.[0]).toEqual([
      expect.objectContaining({ target: child, attributeName: "data-state" }),
    ]);
  });

  it("claims a synchronous helper write at its current value", () => {
    observe();
    child.setAttribute("data-state", "helper");
    watcher.claimCurrent(child, "data-state");
    expect(watcher.take()).toEqual([]);
  });

  it("ignores claims outside observation and starts a fresh lifetime", () => {
    watcher.claim(child, "data-state", "same");
    watcher.claimChildList(root, [child], []);
    observe();
    child.setAttribute("data-state", "same");
    expect(watcher.take()).toHaveLength(1);
  });

  it("releases queued records and claims on disconnect, then observes again", async () => {
    observe();
    write("same");
    watcher.disconnect();
    watcher.disconnect();
    child.setAttribute("data-state", "away");
    await tick();
    expect(delivered).not.toHaveBeenCalled();
    expect(watcher.take()).toEqual([]);
    observe();
    child.setAttribute("data-state", "same");
    expect(watcher.take()).toHaveLength(1);
  });

  it("rebinds the ancestor chain when the root moves", () => {
    const oldParent = document.createElement("div");
    const newParent = document.createElement("div");
    document.body.append(oldParent, newParent);
    oldParent.append(root);
    observe();
    oldParent.setAttribute("contenteditable", "true");
    expect(watcher.take()).toHaveLength(1);
    newParent.append(root);
    observe();
    oldParent.setAttribute("contenteditable", "false");
    newParent.setAttribute("contenteditable", "true");
    expect(watcher.take().map((record) => record.target)).toEqual([newParent]);
  });

  it("honors the root-only defaults and attribute filter", () => {
    watcher.observe(root, { attributes: ["data-state"] });
    child.setAttribute("data-state", "child");
    root.setAttribute("data-other", "other");
    root.append(document.createElement("i"));
    root.setAttribute("data-state", "root");
    expect(watcher.take().map((record) => record.target)).toEqual([root]);
  });

  it("observes child replacements but not character-data edits", () => {
    const text = document.createTextNode("before");
    child.append(text);
    observe();
    const control = new MutationObserver(() => {});
    control.observe(child, { subtree: true, characterData: true });
    try {
      text.data = "author";
      expect(control.takeRecords()).toHaveLength(1);
      expect(watcher.take()).toEqual([]);
      child.append(document.createTextNode("added"));
      expect(watcher.take()).toHaveLength(1);
    } finally {
      control.disconnect();
    }
  });

  it("observes nonempty child changes while an empty replacement queues none", () => {
    root.replaceChildren();
    observe();
    root.replaceChildren();
    expect(watcher.take()).toEqual([]);
    root.append(child);
    expect(watcher.take()).toHaveLength(1);
  });

  it("rejects a queued callback from an earlier observed lifetime", () => {
    const callbacks: MutationCallback[] = [];
    const instances: MutationObserver[] = [];
    const NativeObserver = MutationObserver;
    class CapturedObserver extends NativeObserver {
      constructor(callback: MutationCallback) {
        super(callback);
        callbacks.push(callback);
        instances.push(this);
      }
    }
    vi.stubGlobal("MutationObserver", CapturedObserver);
    observe();
    child.setAttribute("data-state", "author");
    const records = watcher.take();
    observe();
    const oldObserver = instances[0];
    const currentObserver = instances[1];
    if (!oldObserver || !currentObserver) throw new Error("Expected both observed lifetimes");
    child.setAttribute("data-state", "current");
    expect(oldObserver.takeRecords()).toEqual([]);
    expect(currentObserver.takeRecords()).toHaveLength(1);
    callbacks[0]?.(records, oldObserver);
    expect(delivered).not.toHaveBeenCalled();
    callbacks[1]?.(records, currentObserver);
    expect(delivered).toHaveBeenCalledExactlyOnceWith(records);
  });

  it("keeps authored child-list records without a replacement claim", () => {
    observe();
    root.append(document.createElement("i"));
    expect(watcher.take()).toHaveLength(1);
  });

  it("expires unmatched child claims at an empty synchronous take", () => {
    observe();
    watcher.claimChildList(root, [], [child]);
    expect(watcher.take()).toEqual([]);
    root.removeChild(child);
    expect(watcher.take()).toHaveLength(1);
  });

  it("expires unmatched child claims before asynchronous authored delivery", async () => {
    observe();
    watcher.claimChildList(root, [], [child]);
    root.setAttribute("data-other", "author");
    await tick();
    expect(delivered).toHaveBeenCalledTimes(1);
    root.removeChild(child);
    await tick();
    expect(delivered).toHaveBeenCalledTimes(2);
    expect(delivered.mock.calls[1]?.[0][0]?.type).toBe("childList");
  });

  it("releases child claims on disconnect before observing a later lifetime", () => {
    observe();
    root.removeChild(child);
    watcher.claimChildList(root, [], [child]);
    watcher.disconnect();
    root.append(child);
    observe();
    root.removeChild(child);
    expect(watcher.take()).toHaveLength(1);
  });

  it.each(["add", "remove"])(
    "keeps an extra authored %s of a claimed node in the same batch",
    (kind) => {
      observe();
      root.removeChild(child);
      watcher.claimChildList(root, [], [child]);
      root.append(child);
      watcher.claimChildList(root, [child], []);
      if (kind === "add") root.append(child);
      else root.removeChild(child);
      const records = watcher.take();
      expect(
        records.some((record) =>
          [...(kind === "add" ? record.addedNodes : record.removedNodes)].includes(child),
        ),
      ).toBe(true);
    },
  );

  it("excludes a replacement's actual added and removed nodes", () => {
    observe();
    const removed = [...root.childNodes];
    const added = [document.createElement("i"), document.createTextNode("value")];
    root.replaceChildren(...added);
    watcher.claimChildList(root, added, removed);
    expect(watcher.take()).toEqual([]);
    root.append(document.createElement("b"));
    expect(watcher.take()).toHaveLength(1);
  });

  it("counts repeated removals and additions of the same node", () => {
    observe();
    root.removeChild(child);
    watcher.claimChildList(root, [], [child]);
    root.append(child);
    watcher.claimChildList(root, [child], []);
    root.removeChild(child);
    watcher.claimChildList(root, [], [child]);
    root.append(child);
    watcher.claimChildList(root, [child], []);
    expect(watcher.take()).toEqual([]);
    root.removeChild(child);
    expect(watcher.take()).toHaveLength(1);
  });

  it("does not consume an unrelated node, parent, or change kind", () => {
    observe();
    watcher.claimChildList(root, [child], []);
    child.append(document.createElement("i"));
    root.append(document.createElement("b"));
    root.removeChild(child);
    expect(watcher.take()).toHaveLength(3);
  });

  // happy-dom delivers separate child-list records for each added node.
  it("keeps partially matching child-list batches authored", () => {
    observe();
    const one = document.createElement("i");
    const two = document.createElement("b");
    root.replaceChildren(one, two);
    watcher.claimChildList(root, [one], [child]);
    const authored = watcher.take();
    expect(authored.some((record) => [...record.addedNodes].includes(two))).toBe(true);
  });
});

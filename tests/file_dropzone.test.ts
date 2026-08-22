import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileDropzoneController } from "../src/controllers/file_dropzone_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { captureSpeech } from "./helpers/speech";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { tick } from "./helpers/timing";

/**
 * Behavioral tests for {@link FileDropzoneController}: dialog/keyboard selection,
 * drop handling and drag state, accept/size/duplicate/count validation, preview
 * generation with objectURL release, native-input mirroring, focus hand-off on
 * removal, shared-announcer messages, Turbo rewind, and the `change`/`reject`
 * events.
 */

/** Announcement templates that make every outcome distinguishable in assertions. */
const ANNOUNCE_ATTRS = `
  data-stimeo--file-dropzone-announce-drag-text-value="drag"
  data-stimeo--file-dropzone-announce-added-text-value="added {name} {count} of {total}"
  data-stimeo--file-dropzone-announce-removed-text-value="removed {name} {total} left"
  data-stimeo--file-dropzone-announce-rejected-type-text-value="type {name} {count}"
  data-stimeo--file-dropzone-announce-rejected-size-text-value="size {name} {count}"
  data-stimeo--file-dropzone-announce-rejected-duplicate-text-value="duplicate {name} {count}"
  data-stimeo--file-dropzone-announce-rejected-count-text-value="count {name} {count}"`;

const ITEM_TEMPLATE = `
    <template data-stimeo--file-dropzone-target="itemTemplate">
      <li data-stimeo--file-dropzone-target="item">
        <img data-stimeo--file-dropzone-target="thumb" alt="" hidden />
        <span data-stimeo--file-dropzone-target="name"></span>
        <button type="button" aria-label="Remove {name}"
                data-stimeo--file-dropzone-target="remove">×</button>
      </li>
    </template>`;

/** The item template with one declared part taken out. */
const without = (part: "item" | "name" | "remove" | "label"): string => {
  if (part === "label") return ITEM_TEMPLATE.replace('aria-label="Remove {name}"', "");
  if (part === "remove") return ITEM_TEMPLATE.replace(/<button[\s\S]*?<\/button>/, "");
  return ITEM_TEMPLATE.replace(`data-stimeo--file-dropzone-target="${part}"`, "");
};

const markup = (
  attrs = "",
  inputAttrs = 'accept="image/*" multiple aria-label="Upload files"',
  template = ITEM_TEMPLATE,
) => `
  <div data-controller="stimeo--file-dropzone" ${attrs}>
    <div data-stimeo--file-dropzone-target="zone"
         data-action="dragover->stimeo--file-dropzone#onDragOver
                      dragleave->stimeo--file-dropzone#onDragLeave
                      drop->stimeo--file-dropzone#onDrop">
      <button type="button" data-stimeo--file-dropzone-target="trigger"
              data-action="click->stimeo--file-dropzone#openDialog">Choose files</button>
      <input type="file" ${inputAttrs} class="visually-hidden"
             data-stimeo--file-dropzone-target="input"
             data-action="change->stimeo--file-dropzone#onChange" />
    </div>
    <ul data-stimeo--file-dropzone-target="list" aria-label="Selected files"></ul>${template}
  </div>`;

const file = (name: string, type: string, size = 10, lastModified = 1) =>
  new File([new Uint8Array(size)], name, { type, lastModified });

// Captured up front so a test can take `DataTransfer` away from the controller
// without also disarming the helper that builds its input.
const RealDataTransfer = DataTransfer;

const fileList = (...files: File[]): FileList => {
  const transfer = new RealDataTransfer();
  for (const f of files) transfer.items.add(f);
  return transfer.files;
};

describe("FileDropzoneController", () => {
  let application: Application;
  const createdUrls: string[] = [];
  const revokedUrls: string[] = [];
  const announcements: string[] = [];

  const onAnnounce = (event: Event): void => {
    announcements.push((event as CustomEvent<{ message: string }>).detail.message);
  };

  const mount = async (attrs = "", inputAttrs?: string, template?: string) => {
    document.body.innerHTML = markup(attrs, inputAttrs, template);
    application = Application.start();
    application.register("stimeo--file-dropzone", FileDropzoneController);
    await tick();
  };

  beforeEach(() => {
    createdUrls.length = 0;
    revokedUrls.length = 0;
    announcements.length = 0;
    window.addEventListener("stimeo--announcer:announce", onAnnounce);
    let counter = 0;
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn(() => {
        counter += 1;
        const url = `blob:mock/${counter}`;
        createdUrls.push(url);
        return url;
      }),
      revokeObjectURL: vi.fn((url: string) => {
        revokedUrls.push(url);
      }),
    });
  });

  afterEach(() => {
    window.removeEventListener("stimeo--announcer:announce", onAnnounce);
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
  });

  const root = () =>
    document.querySelector<HTMLElement>("[data-controller='stimeo--file-dropzone']") as HTMLElement;
  const zone = () =>
    document.querySelector<HTMLElement>(
      "[data-stimeo--file-dropzone-target='zone']",
    ) as HTMLElement;
  const trigger = () =>
    document.querySelector<HTMLElement>(
      "[data-stimeo--file-dropzone-target='trigger']",
    ) as HTMLElement;
  const input = () =>
    document.querySelector<HTMLInputElement>(
      "[data-stimeo--file-dropzone-target='input']",
    ) as HTMLInputElement;
  const items = () =>
    Array.from(
      document.querySelectorAll<HTMLElement>("[data-stimeo--file-dropzone-target='item']"),
    );
  const removeButtons = () =>
    Array.from(
      document.querySelectorAll<HTMLButtonElement>("[data-stimeo--file-dropzone-target='remove']"),
    );
  const list = () =>
    document.querySelector<HTMLElement>(
      "[data-stimeo--file-dropzone-target='list']",
    ) as HTMLElement;
  const names = () =>
    items().map(
      (item) => item.querySelector("[data-stimeo--file-dropzone-target='name']")?.textContent ?? "",
    );
  const inputNames = () => Array.from(input().files ?? []).map((f) => f.name);
  const controller = () =>
    application.getControllerForElementAndIdentifier(root(), "stimeo--file-dropzone");

  const dropOn = (target: HTMLElement, ...files: File[]) => {
    const event = new Event("drop", { bubbles: true, cancelable: true });
    Object.assign(event, { dataTransfer: { files: fileList(...files) } });
    target.dispatchEvent(event);
    return event;
  };
  const drop = (...files: File[]) => dropOn(zone(), ...files);
  const dragOver = () =>
    zone().dispatchEvent(new Event("dragover", { bubbles: true, cancelable: true }));
  const dragLeaveTo = (related: EventTarget | null) =>
    zone().dispatchEvent(new MouseEvent("dragleave", { bubbles: true, relatedTarget: related }));
  const chooseFiles = (...files: File[]) => {
    input().files = fileList(...files);
    input().dispatchEvent(new Event("change", { bubbles: true }));
  };
  const rejectsFrom = (): Array<{ file: File; reason: string }> => {
    const seen: Array<{ file: File; reason: string }> = [];
    root().addEventListener("stimeo--file-dropzone:reject", (event) => {
      seen.push((event as CustomEvent).detail);
    });
    return seen;
  };
  const changesFrom = (): File[][] => {
    const seen: File[][] = [];
    root().addEventListener("stimeo--file-dropzone:change", (event) => {
      seen.push((event as CustomEvent).detail.files);
    });
    return seen;
  };
  /** Every event this controller reports, in dispatch order. */
  const reportsFrom = (): Array<{ event: string; detail: Record<string, unknown> }> => {
    const seen: Array<{ event: string; detail: Record<string, unknown> }> = [];
    for (const event of ["change", "reject", "reconcile"]) {
      root().addEventListener(`stimeo--file-dropzone:${event}`, (e) => {
        seen.push({ event, detail: (e as CustomEvent).detail });
      });
    }
    return seen;
  };

  it("opens the native dialog when the trigger is activated", async () => {
    await mount();
    const clicked = vi.spyOn(input(), "click").mockImplementation(() => {});
    trigger().click();
    expect(clicked).toHaveBeenCalledOnce();
  });

  it("adds dropped files, generating an image preview", async () => {
    await mount();
    const changes = changesFrom();
    drop(file("photo.jpg", "image/jpeg"));
    expect(items()).toHaveLength(1);
    const img = items()[0]?.querySelector("img") as HTMLImageElement;
    expect(img.hidden).toBe(false);
    expect(img.src).toContain("blob:mock/");
    expect(img.alt).toBe("photo.jpg");
    expect(names()).toEqual(["photo.jpg"]);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.[0]?.name).toBe("photo.jpg");
  });

  it("hides the thumbnail for a file that is not an image", async () => {
    await mount("", 'multiple aria-label="Upload files"');
    drop(file("notes.txt", "text/plain"));
    const img = items()[0]?.querySelector("img") as HTMLImageElement;
    expect(img.hidden).toBe(true);
    expect(createdUrls).toHaveLength(0);
  });

  it("keeps the authored remove-button label and expands {name} into it", async () => {
    const template = ITEM_TEMPLATE.replace(
      'aria-label="Remove {name}"',
      'aria-label="{name} を削除"',
    );
    await mount("", undefined, template);
    drop(file("photo.jpg", "image/jpeg"));
    expect(removeButtons()[0]?.getAttribute("aria-label")).toBe("photo.jpg を削除");
  });

  it("mirrors the accepted files onto the native input and back out again", async () => {
    await mount();
    drop(file("a.jpg", "image/jpeg"), file("b.jpg", "image/jpeg"));
    expect(inputNames()).toEqual(["a.jpg", "b.jpg"]);

    removeButtons()[0]?.click();
    expect(inputNames()).toEqual(["b.jpg"]);
  });

  it("adds the files chosen through the native dialog and keeps earlier ones", async () => {
    await mount();
    const changes = changesFrom();
    drop(file("a.jpg", "image/jpeg"));
    chooseFiles(file("b.jpg", "image/jpeg"));

    expect(names()).toEqual(["a.jpg", "b.jpg"]);
    expect(inputNames()).toEqual(["a.jpg", "b.jpg"]);
    expect(changes).toHaveLength(2);
  });

  it("restores the input selection when the dialog batch is rejected outright", async () => {
    await mount();
    drop(file("a.jpg", "image/jpeg"));
    chooseFiles(file("notes.txt", "text/plain"));

    expect(names()).toEqual(["a.jpg"]);
    expect(inputNames()).toEqual(["a.jpg"]);
  });

  it("sets the drag-over flag and announces the affordance once per drag", async () => {
    await mount(ANNOUNCE_ATTRS);
    dragOver();
    dragOver();
    dragOver();
    expect(zone().hasAttribute("data-dragover")).toBe(true);
    expect(announcements).toEqual(["drag"]);

    dragLeaveTo(null);
    expect(zone().hasAttribute("data-dragover")).toBe(false);
    dragOver();
    expect(announcements).toEqual(["drag", "drag"]);
  });

  it("keeps the drag-over flag while the pointer crosses an element inside the zone", async () => {
    await mount();
    dragOver();
    dragLeaveTo(trigger());
    expect(zone().hasAttribute("data-dragover")).toBe(true);

    dragLeaveTo(list());
    expect(zone().hasAttribute("data-dragover")).toBe(false);
  });

  it("clears the drag-over flag when the files are dropped", async () => {
    await mount();
    dragOver();
    expect(zone().hasAttribute("data-dragover")).toBe(true);
    drop(file("a.jpg", "image/jpeg"));
    expect(zone().hasAttribute("data-dragover")).toBe(false);
  });

  it("clears the invalid flag on the next batch", async () => {
    await mount();
    drop(file("notes.txt", "text/plain"));
    expect(zone().hasAttribute("data-stimeo--file-dropzone-invalid")).toBe(true);
    drop(file("a.jpg", "image/jpeg"));
    expect(zone().hasAttribute("data-stimeo--file-dropzone-invalid")).toBe(false);
  });

  it("rejects files failing the accept filter, naming the file in the detail", async () => {
    await mount();
    const rejects = rejectsFrom();
    drop(file("notes.txt", "text/plain"));
    expect(items()).toHaveLength(0);
    expect(rejects.map((r) => r.reason)).toEqual(["type"]);
    expect(rejects[0]?.file.name).toBe("notes.txt");
    expect(zone().hasAttribute("data-stimeo--file-dropzone-invalid")).toBe(true);
  });

  it("matches accept by extension and ignores empty tokens", async () => {
    await mount("", 'accept=".png, ,.svg" multiple aria-label="Upload files"');
    const rejects = rejectsFrom();
    // The blank token must match nothing — not even a file the platform gave no type.
    drop(file("logo.PNG", "image/png"), file("photo.jpg", "image/jpeg"), file("data.bin", ""));
    expect(names()).toEqual(["logo.PNG"]);
    expect(rejects.map((r) => r.file.name)).toEqual(["photo.jpg", "data.bin"]);
    expect(rejects.map((r) => r.reason)).toEqual(["type", "type"]);
  });

  it("accepts every file when the input declares no accept list", async () => {
    await mount("", 'multiple aria-label="Upload files"');
    drop(file("notes.txt", "text/plain"), file("photo.jpg", "image/jpeg"));
    expect(names()).toEqual(["notes.txt", "photo.jpg"]);
  });

  it("rejects files over the size limit but keeps one exactly at it", async () => {
    await mount('data-stimeo--file-dropzone-max-size-value="100"');
    const rejects = rejectsFrom();
    drop(file("edge.jpg", "image/jpeg", 100), file("big.jpg", "image/jpeg", 200));
    expect(names()).toEqual(["edge.jpg"]);
    expect(rejects.map((r) => r.reason)).toEqual(["size"]);
    expect(rejects[0]?.file.name).toBe("big.jpg");
  });

  it("rejects files beyond the count limit", async () => {
    await mount('data-stimeo--file-dropzone-max-files-value="1"');
    const rejects = rejectsFrom();
    drop(file("a.jpg", "image/jpeg"));
    drop(file("b.jpg", "image/jpeg"));
    expect(items()).toHaveLength(1);
    expect(rejects.map((r) => r.reason)).toEqual(["count"]);
  });

  it("leaves size and count unlimited at their defaults", async () => {
    await mount();
    drop(
      file("a.jpg", "image/jpeg", 5_000_000),
      file("b.jpg", "image/jpeg", 2),
      file("c.jpg", "image/jpeg", 3),
    );
    expect(items()).toHaveLength(3);
  });

  it("treats a non-multiple input as a single-file cap", async () => {
    await mount("", 'accept="image/*"');
    drop(file("a.jpg", "image/jpeg"));
    drop(file("b.jpg", "image/jpeg"));
    expect(items()).toHaveLength(1);
  });

  it("reports a file's own defect ahead of the count limit", async () => {
    await mount('data-stimeo--file-dropzone-max-files-value="1"');
    const rejects = rejectsFrom();
    drop(file("a.jpg", "image/jpeg"));
    drop(file("notes.txt", "text/plain"), file("b.jpg", "image/jpeg"));
    expect(rejects.map((r) => r.reason)).toEqual(["type", "count"]);
  });

  it("rejects a file already selected unless duplicates are allowed", async () => {
    await mount();
    const rejects = rejectsFrom();
    drop(file("a.jpg", "image/jpeg"));
    drop(file("a.jpg", "image/jpeg"));
    expect(items()).toHaveLength(1);
    expect(rejects.map((r) => r.reason)).toEqual(["duplicate"]);

    // A same-named file that differs in size is a different selection.
    drop(file("a.jpg", "image/jpeg", 20));
    expect(items()).toHaveLength(2);
  });

  it("allows the same file twice when allowDuplicates is set", async () => {
    await mount('data-stimeo--file-dropzone-allow-duplicates-value="true"');
    drop(file("a.jpg", "image/jpeg"));
    drop(file("a.jpg", "image/jpeg"));
    expect(items()).toHaveLength(2);
    expect(inputNames()).toEqual(["a.jpg", "a.jpg"]);
  });

  it("removes a file, revoking its objectURL and moving focus to the next button", async () => {
    await mount();
    drop(file("a.jpg", "image/jpeg"), file("b.jpg", "image/jpeg"));
    const changes = changesFrom();
    removeButtons()[0]?.click();

    expect(names()).toEqual(["b.jpg"]);
    expect(revokedUrls).toEqual([createdUrls[0]]);
    expect(document.activeElement).toBe(removeButtons()[0]);
    expect(changes[0]?.map((f) => f.name)).toEqual(["b.jpg"]);
  });

  it("falls back to the previous remove button, then to the trigger", async () => {
    await mount();
    drop(file("a.jpg", "image/jpeg"), file("b.jpg", "image/jpeg"));
    removeButtons()[1]?.click();
    expect(document.activeElement).toBe(removeButtons()[0]);

    removeButtons()[0]?.click();
    expect(items()).toHaveLength(0);
    expect(document.activeElement).toBe(trigger());
  });

  it("ignores clicks on any other button inside an item", async () => {
    const template = ITEM_TEMPLATE.replace(
      "<span",
      '<button type="button" class="preview">Preview</button><span',
    );
    await mount("", undefined, template);
    drop(file("a.jpg", "image/jpeg"));

    items()[0]?.querySelector<HTMLButtonElement>("button.preview")?.click();
    expect(items()).toHaveLength(1);

    removeButtons()[0]?.click();
    expect(items()).toHaveLength(0);
  });

  it("announces additions, rejections, and removals as distinct messages", async () => {
    await mount(`${ANNOUNCE_ATTRS} data-stimeo--file-dropzone-max-size-value="100"`);
    drop(file("a.jpg", "image/jpeg"));
    drop(file("big.jpg", "image/jpeg", 200));
    drop(file("notes.txt", "text/plain"));
    removeButtons()[0]?.click();

    expect(announcements).toEqual([
      "added a.jpg 1 of 1",
      "size big.jpg 1",
      "type notes.txt 1",
      "removed a.jpg 0 left",
    ]);
  });

  it("condenses one batch into one message per outcome", async () => {
    await mount(`${ANNOUNCE_ATTRS} data-stimeo--file-dropzone-max-size-value="100"`);
    drop(
      file("a.jpg", "image/jpeg"),
      file("b.jpg", "image/jpeg"),
      file("big.jpg", "image/jpeg", 200),
      file("huge.jpg", "image/jpeg", 300),
      file("notes.txt", "text/plain"),
    );

    expect(announcements).toEqual(["added a.jpg 2 of 2", "size big.jpg 2", "type notes.txt 1"]);
  });

  it("stays silent when the consumer authors no announcement text", async () => {
    await mount();
    dragOver();
    drop(file("a.jpg", "image/jpeg"));
    drop(file("notes.txt", "text/plain"));
    removeButtons()[0]?.click();
    expect(announcements).toEqual([]);
  });

  it("keeps two dropzones on one page independent", async () => {
    document.body.innerHTML = `<div id="first">${markup()}</div><div id="second">${markup()}</div>`;
    application = Application.start();
    application.register("stimeo--file-dropzone", FileDropzoneController);
    await tick();

    const zoneIn = (id: string) =>
      document.querySelector<HTMLElement>(
        `#${id} [data-stimeo--file-dropzone-target='zone']`,
      ) as HTMLElement;
    const itemsIn = (id: string) =>
      Array.from(
        document.querySelectorAll<HTMLElement>(`#${id} [data-stimeo--file-dropzone-target='item']`),
      );
    const inputIn = (id: string) =>
      document.querySelector<HTMLInputElement>(
        `#${id} [data-stimeo--file-dropzone-target='input']`,
      ) as HTMLInputElement;

    dropOn(zoneIn("first"), file("a.jpg", "image/jpeg"));
    expect(itemsIn("first")).toHaveLength(1);
    expect(itemsIn("second")).toHaveLength(0);
    expect(Array.from(inputIn("second").files ?? [])).toHaveLength(0);

    // The same file is a duplicate only within the widget that already holds it.
    dropOn(zoneIn("second"), file("a.jpg", "image/jpeg"));
    expect(itemsIn("second")).toHaveLength(1);

    // Removing from one leaves the other untouched.
    itemsIn("first")[0]
      ?.querySelector<HTMLButtonElement>("[data-stimeo--file-dropzone-target='remove']")
      ?.click();
    expect(itemsIn("first")).toHaveLength(0);
    expect(itemsIn("second")).toHaveLength(1);
    expect(revokedUrls).toHaveLength(1);
  });

  it("rebinds removal and restores client previews when the list target is replaced", async () => {
    await mount();
    drop(file("a.jpg", "image/jpeg"), file("b.jpg", "image/jpeg"));
    const oldList = list();
    const replacement = oldList.cloneNode(false) as HTMLElement;

    oldList.replaceWith(replacement);
    await tick();

    expect(replacement.querySelectorAll("[data-stimeo--file-dropzone-target='item']")).toHaveLength(
      2,
    );
    removeButtons()[0]?.click();
    expect(items()).toHaveLength(1);
    expect(revokedUrls).toHaveLength(1);

    const staleClick = new MouseEvent("click", { bubbles: true });
    oldList.dispatchEvent(staleClick);
    expect(items()).toHaveLength(1);
  });

  it("moves previews back when a morph empties the list in place", async () => {
    await mount('data-stimeo--file-dropzone-max-files-value="2"');
    drop(file("a.jpg", "image/jpeg"), file("b.jpg", "image/jpeg"));
    list().replaceChildren();
    expect(items()).toHaveLength(0);

    const rejects = rejectsFrom();
    drop(file("c.jpg", "image/jpeg"));
    // Screen and selection agree again: the two survivors are back and still count.
    expect(names()).toEqual(["a.jpg", "b.jpg"]);
    expect(rejects.map((r) => r.reason)).toEqual(["count"]);
  });

  it("reports what a batch took before what it turned away", async () => {
    await mount('data-stimeo--file-dropzone-max-files-value="4"');
    const reports = reportsFrom();
    drop(
      file("a.jpg", "image/jpeg"),
      file("b.jpg", "image/jpeg"),
      file("c.jpg", "image/jpeg"),
      file("d.jpg", "image/jpeg"),
      file("e.jpg", "image/jpeg"),
    );

    // A consumer that clears its rejection notice on `change` must not lose the
    // notice raised by the same drop, so the accepted set is reported first.
    expect(reports.map((r) => r.event)).toEqual(["change", "reject"]);
    const accepted = (reports[0]?.detail.files ?? []) as File[];
    expect(accepted.map((f) => f.name)).toEqual(["a.jpg", "b.jpg", "c.jpg", "d.jpg"]);
    expect(reports[1]?.detail.reason).toBe("count");
  });

  it("reports the selection the cache rewind discards", async () => {
    await mount();
    drop(file("a.jpg", "image/jpeg"));
    const reports = reportsFrom();

    document.dispatchEvent(new Event("turbo:before-cache"));

    // The rewind is the controller deciding the selection is gone, so consumers
    // that painted from `change` can drop it before the snapshot is taken.
    expect(reports).toEqual([{ event: "reconcile", detail: { files: [] } }]);
  });

  it("stays silent when the cache rewind has nothing to discard", async () => {
    await mount();
    const reports = reportsFrom();

    document.dispatchEvent(new Event("turbo:before-cache"));

    expect(reports).toEqual([]);
  });

  it("rewinds previews and state attributes before Turbo caches the page", async () => {
    await mount();
    dragOver();
    drop(file("a.jpg", "image/jpeg"), file("notes.txt", "text/plain"));
    expect(items()).toHaveLength(1);

    document.dispatchEvent(new Event("turbo:before-cache"));

    expect(items()).toHaveLength(0);
    expect(revokedUrls).toEqual(createdUrls);
    expect(inputNames()).toEqual([]);
    expect(zone().hasAttribute("data-dragover")).toBe(false);
    expect(zone().hasAttribute("data-stimeo--file-dropzone-invalid")).toBe(false);
  });

  it("stops rewinding once the controller is gone", async () => {
    await mount();
    drop(file("a.jpg", "image/jpeg"));
    controller()?.disconnect();
    await tick();
    revokedUrls.length = 0;

    document.dispatchEvent(new Event("turbo:before-cache"));
    expect(revokedUrls).toEqual([]);
  });

  it("revokes every preview URL once the disconnect proves a real detach", async () => {
    await mount();
    drop(file("a.jpg", "image/jpeg"), file("b.jpg", "image/jpeg"));
    expect(createdUrls).toHaveLength(2);

    root().remove();
    await tick();

    expect(revokedUrls).toEqual(createdUrls);
  });

  it("keeps the selection when the element only moves within the page", async () => {
    await mount();
    drop(file("a.jpg", "image/jpeg"), file("b.jpg", "image/jpeg"));
    const holder = document.createElement("section");
    document.body.appendChild(holder);

    holder.appendChild(root());
    await tick();

    expect(revokedUrls).toEqual([]);
    expect(items()).toHaveLength(2);
    removeButtons()[0]?.click();
    expect(items()).toHaveLength(1);
  });

  it("ignores removal clicks once the controller has disconnected", async () => {
    await mount();
    drop(file("a.jpg", "image/jpeg"));
    const button = removeButtons()[0] as HTMLButtonElement;
    controller()?.disconnect();

    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(revokedUrls).toHaveLength(0);
  });

  it("renders nothing and reports the template when the remove button is missing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await mount("", undefined, without("remove"));
    const changes = changesFrom();

    drop(file("a.jpg", "image/jpeg"), file("b.jpg", "image/jpeg"));

    expect(items()).toHaveLength(0);
    expect(changes).toEqual([]);
    expect(inputNames()).toEqual([]);
    // One diagnostic per connection, however many files were dropped.
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toContain('lacks a "remove" target <button>');
    warn.mockRestore();
  });

  it.each([
    ["item", without("item"), '"item" root'],
    ["name", without("name"), '"name" element'],
    ["a labelled remove button", without("label"), "non-empty aria-label"],
    ["the template itself", "", '"itemTemplate" target'],
  ])("names %s when the item template lacks it", async (_part, template, expected) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await mount("", undefined, template);

    drop(file("a.jpg", "image/jpeg"));

    expect(items()).toHaveLength(0);
    expect(warn.mock.calls[0]?.[0]).toContain(expected);
    warn.mockRestore();
  });

  it("names the list target when it goes away under a live selection", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await mount();
    drop(file("a.jpg", "image/jpeg"));
    list().removeAttribute("data-stimeo--file-dropzone-target");
    await tick();

    drop(file("b.jpg", "image/jpeg"));

    // The rendered item stays where it is; only the new file has nowhere to go.
    expect(items()).toHaveLength(1);
    expect(warn.mock.calls[0]?.[0]).toContain('"list" target');
    warn.mockRestore();
  });

  it("keeps working where DataTransfer cannot be constructed", async () => {
    vi.stubGlobal("DataTransfer", undefined);
    await mount();
    const changes = changesFrom();

    drop(file("a.jpg", "image/jpeg"));

    expect(names()).toEqual(["a.jpg"]);
    expect(changes).toHaveLength(1);
  });

  it("still rewinds when a morph takes the input target away", async () => {
    await mount();
    dragOver();
    drop(file("a.jpg", "image/jpeg"), file("notes.txt", "text/plain"));
    input().removeAttribute("data-stimeo--file-dropzone-target");
    await tick();

    document.dispatchEvent(new Event("turbo:before-cache"));

    expect(items()).toHaveLength(0);
    expect(zone().hasAttribute("data-dragover")).toBe(false);
    expect(zone().hasAttribute("data-stimeo--file-dropzone-invalid")).toBe(false);
  });

  it("leaves a drop an inner dropzone already handled alone", async () => {
    await mount();
    const inner = document.createElement("div");
    zone().appendChild(inner);
    inner.addEventListener("drop", (event) => event.preventDefault());

    dropOn(inner, file("a.jpg", "image/jpeg"));
    expect(items()).toHaveLength(0);
  });

  it("refuses the drop path while the field is disabled", async () => {
    await mount();
    input().disabled = true;
    const dropped = drop(file("a.jpg", "image/jpeg"));

    expect(items()).toHaveLength(0);
    // The default is left alone, which is what refuses the drop in a browser.
    expect(dropped.defaultPrevented).toBe(false);
    dragOver();
    expect(zone().hasAttribute("data-dragover")).toBe(false);

    const clicked = vi.spyOn(input(), "click").mockImplementation(() => {});
    trigger().click();
    expect(clicked).not.toHaveBeenCalled();
  });

  it("refuses the drop path inside a disabled fieldset", async () => {
    document.body.innerHTML = `<form><fieldset disabled>${markup()}</fieldset></form>`;
    application = Application.start();
    application.register("stimeo--file-dropzone", FileDropzoneController);
    await tick();

    drop(file("a.jpg", "image/jpeg"));
    expect(items()).toHaveLength(0);
  });

  it("has no machine-detectable a11y violations with files present", async () => {
    await mount();
    drop(file("photo.jpg", "image/jpeg"));
    await expectNoA11yViolations(root());
  });

  it("announces the file trigger by name", async () => {
    await mount();
    const phrases = await captureSpeech({ container: root(), steps: 1 });
    expect(phrases).toEqual(["button, Choose files", "Upload files"]);
  });
});

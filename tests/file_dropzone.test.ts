import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileDropzoneController } from "../src/controllers/file_dropzone_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { captureSpeech } from "./helpers/speech";
import { disconnectAndStopApplication, restoreFromCache } from "./helpers/stimulus";
import { tick } from "./helpers/timing";

/**
 * Behavioral tests for {@link FileDropzoneController}: dialog/keyboard selection,
 * drop handling and drag state, accept/size/duplicate/count validation, preview
 * generation with objectURL release, native-input mirroring, focus hand-off on
 * removal, shared-announcer messages, the selection across Turbo's cache and morphs,
 * and the `change`/`reject`/`reconcile` events.
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

  /** A row that names itself `item name` and holds the button and thumb inside it. */
  const NESTED_NAME_TEMPLATE = `
    <template data-stimeo--file-dropzone-target="itemTemplate">
      <li data-stimeo--file-dropzone-target="item name">
        <img data-stimeo--file-dropzone-target="thumb" alt="" hidden />
        <button type="button" aria-label="Remove {name}"
                data-stimeo--file-dropzone-target="remove">×</button>
      </li>
    </template>`;

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

  it("keeps the nested button and thumbnail when a row is its own name", async () => {
    // A row may name itself `item name`. Writing the file name over the whole
    // subtree takes the remove button and the thumbnail with it, leaving a row
    // that is rendered but cannot be removed.
    await mount("", undefined, NESTED_NAME_TEMPLATE);

    drop(file("a.jpg", "image/jpeg"));
    await tick();

    // The helper matches the exact attribute value, which a token list is not.
    const row = document.querySelector(
      "[data-stimeo--file-dropzone-target~='item']",
    ) as HTMLElement;
    expect(row.textContent).toContain("a.jpg");
    expect(row.querySelector("button")).not.toBeNull();
    expect(row.querySelector("img")).not.toBeNull();
  });

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

  it("decides a thumbnail authored visible from each file's type", async () => {
    // The authored `hidden` is only a starting state: each row's thumbnail is
    // shown for an image and hidden for anything else, whatever the template says.
    const template = ITEM_TEMPLATE.replace(' alt="" hidden />', ' alt="" />');
    await mount("", 'multiple aria-label="Upload files"', template);
    const authored = document.querySelector<HTMLTemplateElement>(
      "[data-stimeo--file-dropzone-target='itemTemplate']",
    );
    expect(authored?.content.querySelector("img")?.hasAttribute("hidden")).toBe(false);

    drop(file("photo.jpg", "image/jpeg"), file("notes.txt", "text/plain"));

    const [photo, notes] = items().map((item) => item.querySelector("img") as HTMLImageElement);
    expect(photo?.hidden).toBe(false);
    expect(photo?.src).toContain("blob:mock/");
    expect(notes?.hidden).toBe(true);
    expect(notes?.hasAttribute("src")).toBe(false);
    expect(createdUrls).toHaveLength(1);
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

  // The list holds exactly the preview items: a template is authored across lines,
  // so anything cloned beyond its first element would settle in the list as the
  // author adds and removes files, and only the item itself is taken back.
  it("leaves nothing behind in the list across repeated add/remove cycles", async () => {
    await mount();

    for (let round = 0; round < 100; round++) {
      drop(file(`f${round}.png`, "image/png"));
      removeButtons()[0]?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    }

    expect(list().children).toHaveLength(0);
    expect(list().childNodes).toHaveLength(0);
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

  it("claims a dragover so the browser lets the files drop", async () => {
    await mount();
    const over = new Event("dragover", { bubbles: true, cancelable: true });

    zone().dispatchEvent(over);

    expect(over.defaultPrevented).toBe(true);
  });

  it("claims a drop so the browser does not open the files itself", async () => {
    await mount();

    const dropped = drop(file("a.jpg", "image/jpeg"));

    expect(dropped.defaultPrevented).toBe(true);
    expect(names()).toEqual(["a.jpg"]);
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

  it("keeps focus on a neighbouring row when the row is its own remove button", async () => {
    // One element carries the row, its name and its button. Focus management reads
    // the declared buttons, so it has to find the row itself among them.
    const selfRemove = `
    <template data-stimeo--file-dropzone-target="itemTemplate">
      <button type="button" aria-label="Remove {name}"
              data-stimeo--file-dropzone-target="item name remove"></button>
    </template>`;
    const rows = () =>
      Array.from(
        document.querySelectorAll<HTMLButtonElement>(
          '[data-stimeo--file-dropzone-target~="remove"]',
        ),
      );
    await mount("", undefined, selfRemove);
    drop(file("a.jpg", "image/jpeg"), file("b.jpg", "image/jpeg"));
    expect(rows()).toHaveLength(2);

    rows()[0]?.click();

    // The row is its own name element, so the remaining row reads as the file left.
    expect(rows().map((row) => row.textContent)).toEqual(["b.jpg"]);
    expect(document.activeElement).toBe(rows()[0]);
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

  it("stops removing files through a list that is no longer a target", async () => {
    await mount();
    drop(file("a.jpg", "image/jpeg"));
    const changes = changesFrom();
    const oldList = list();

    oldList.removeAttribute("data-stimeo--file-dropzone-target");
    // Drive the callback directly: happy-dom delivers target callbacks unreliably.
    (controller() as FileDropzoneController).listTargetDisconnected(oldList);
    removeButtons()[0]?.click();

    expect(items()).toHaveLength(1);
    expect(revokedUrls).toEqual([]);
    expect(changes).toEqual([]);
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

  it("moves the previews into a list that arrives after the only one left", async () => {
    await mount();
    drop(file("a.jpg", "image/jpeg"));
    const original = list();
    original.remove();
    await tick();
    const replacement = original.cloneNode(false) as HTMLElement;
    root().append(replacement);
    await tick();

    expect(replacement.querySelectorAll("[data-stimeo--file-dropzone-target='item']")).toHaveLength(
      1,
    );
    removeButtons()[0]?.click();
    expect(items()).toHaveLength(0);
    expect(inputNames()).toEqual([]);
  });

  describe("a zone that replaces the current one", () => {
    const INVALID = "data-stimeo--file-dropzone-invalid";
    const DRAGOVER = "data-dragover";

    /** A server-rendered copy of the zone, without the state hooks. */
    const zoneCopy = (): HTMLElement => {
      const copy = zone().cloneNode(true) as HTMLElement;
      copy.removeAttribute(INVALID);
      copy.removeAttribute(DRAGOVER);
      return copy;
    };

    it("carries the rejection hook onto a replacement delivered in one task", async () => {
      await mount();
      drop(file("notes.txt", "text/plain"));
      const successor = zoneCopy();
      zone().replaceWith(successor);
      await tick();

      expect(successor.hasAttribute(INVALID)).toBe(true);
    });

    it("carries a drag in progress onto a replacement delivered in one task", async () => {
      await mount();
      dragOver();
      const successor = zoneCopy();
      zone().replaceWith(successor);
      await tick();

      expect(successor.hasAttribute(DRAGOVER)).toBe(true);
    });

    it("carries the rejection hook onto the zone that stays after an earlier one leaves", async () => {
      await mount();
      const original = zone();
      const successor = zoneCopy();
      original.after(successor);
      await tick();
      drop(file("notes.txt", "text/plain")); // marks the earlier zone only
      original.remove();
      await tick();

      expect(zone()).toBe(successor);
      expect(successor.hasAttribute(INVALID)).toBe(true);
    });

    it("carries the rejection hook onto a zone that arrives after the only one left", async () => {
      await mount();
      drop(file("notes.txt", "text/plain"));
      const arrival = zoneCopy();
      zone().remove();
      await tick();
      root().prepend(arrival);
      await tick();

      expect(arrival.hasAttribute(INVALID)).toBe(true);
    });

    it("takes its hooks off a zone left in the page without its target token", async () => {
      await mount();
      const original = zone();
      const successor = zoneCopy();
      original.after(successor);
      await tick();
      drop(file("notes.txt", "text/plain"));
      dragOver();
      original.removeAttribute("data-stimeo--file-dropzone-target");
      await tick();

      expect(original.hasAttribute(INVALID)).toBe(false);
      expect(original.hasAttribute(DRAGOVER)).toBe(false);
      expect(successor.hasAttribute(INVALID)).toBe(true);
      expect(successor.hasAttribute(DRAGOVER)).toBe(true);
    });

    it("gives back a rejection mark the zone carried before this wrote it, once it stops being the target", async () => {
      await mount();
      const original = zone();
      original.setAttribute(INVALID, "");
      dragOver();
      expect(original.hasAttribute(INVALID)).toBe(false);

      original.removeAttribute("data-stimeo--file-dropzone-target");
      await tick();

      expect(original.getAttribute(INVALID)).toBe("");
      expect(original.hasAttribute(DRAGOVER)).toBe(false);
    });

    it("keeps a hook value the page wrote on a zone that stops being the target", async () => {
      await mount();
      drop(file("notes.txt", "text/plain"));
      const original = zone();
      original.setAttribute(INVALID, "server");

      original.removeAttribute("data-stimeo--file-dropzone-target");
      await tick();

      expect(original.getAttribute(INVALID)).toBe("server");
    });

    it("takes its hooks off the zone when the widget loses its controller", async () => {
      await mount();
      drop(file("notes.txt", "text/plain"));
      dragOver();
      const departed = zone();

      root().removeAttribute("data-controller");
      await tick();

      expect(departed.hasAttribute(INVALID)).toBe(false);
      expect(departed.hasAttribute(DRAGOVER)).toBe(false);
    });

    it("keeps its hooks on a zone that moves within the widget", async () => {
      await mount();
      drop(file("notes.txt", "text/plain"));
      dragOver();
      const moving = zone();
      const records: MutationRecord[] = [];
      const observer = new MutationObserver((batch) => records.push(...batch));
      observer.observe(moving, { attributes: true, attributeFilter: [INVALID, DRAGOVER] });

      root().append(moving);
      await tick();
      records.push(...observer.takeRecords());
      observer.disconnect();

      expect(moving.hasAttribute(INVALID)).toBe(true);
      expect(moving.hasAttribute(DRAGOVER)).toBe(true);
      expect(records.map((record) => record.attributeName)).toEqual([]);
    });

    it("reports nothing while it moves the hooks", async () => {
      await mount(ANNOUNCE_ATTRS);
      drop(file("notes.txt", "text/plain"));
      const reports = reportsFrom();
      announcements.length = 0;
      zone().replaceWith(zoneCopy());
      await tick();

      expect(reports).toEqual([]);
      expect(announcements).toEqual([]);
    });

    it("tolerates the removal of the only zone", async () => {
      await mount();
      drop(file("notes.txt", "text/plain"));
      const only = zone();
      only.remove();

      expect(() =>
        (controller() as FileDropzoneController).zoneTargetDisconnected(only),
      ).not.toThrow();
    });

    it("moves nothing once it has disconnected", async () => {
      await mount();
      const original = zone();
      const successor = zoneCopy();
      original.after(successor);
      await tick();
      drop(file("notes.txt", "text/plain"));
      const instance = controller() as FileDropzoneController;
      instance.disconnect();
      original.remove();
      instance.zoneTargetDisconnected(original);

      expect(successor.hasAttribute(INVALID)).toBe(false);
    });
  });

  describe("an input that takes over", () => {
    /** A server-rendered copy of the input, which carries no files. */
    const inputCopy = (): HTMLInputElement => {
      const copy = input().cloneNode(true) as HTMLInputElement;
      copy.files = fileList();
      return copy;
    };
    const namesOn = (element: HTMLInputElement) =>
      Array.from(element.files ?? []).map((f) => f.name);

    it("mirrors the selection onto an input that replaces the current one in one task", async () => {
      await mount();
      drop(file("a.jpg", "image/jpeg"), file("b.jpg", "image/jpeg"));
      const successor = inputCopy();
      expect(namesOn(successor)).toEqual([]);

      input().replaceWith(successor);
      await tick();

      expect(input()).toBe(successor);
      expect(namesOn(successor)).toEqual(["a.jpg", "b.jpg"]);
    });

    it("mirrors the selection onto an input that stays after an earlier one leaves", async () => {
      await mount();
      drop(file("a.jpg", "image/jpeg"));
      const original = input();
      const successor = inputCopy();
      original.after(successor);
      await tick();
      drop(file("b.jpg", "image/jpeg")); // mirrored onto the earlier input only
      expect(namesOn(original)).toEqual(["a.jpg", "b.jpg"]);

      original.remove();
      await tick();

      expect(input()).toBe(successor);
      expect(namesOn(successor)).toEqual(["a.jpg", "b.jpg"]);
      removeButtons()[0]?.click();
      expect(namesOn(successor)).toEqual(["b.jpg"]);
    });

    it("takes over silently: no report, no native change, no announcement", async () => {
      await mount(ANNOUNCE_ATTRS);
      drop(file("a.jpg", "image/jpeg"));
      const original = input();
      const successor = inputCopy();
      const reports = reportsFrom();
      const commits: Event[] = [];
      root().addEventListener("change", (event) => commits.push(event));
      announcements.length = 0;

      original.after(successor);
      await tick();
      original.remove();
      await tick();

      expect(namesOn(successor)).toEqual(["a.jpg"]);
      expect(reports).toEqual([]);
      expect(commits).toEqual([]);
      expect(announcements).toEqual([]);
    });

    it("mirrors the selection onto an input that arrives after the only one left", async () => {
      await mount();
      drop(file("a.jpg", "image/jpeg"));
      const arrival = inputCopy();
      input().remove();
      await tick();

      zone().append(arrival);
      await tick();

      expect(namesOn(arrival)).toEqual(["a.jpg"]);
    });

    it("tolerates the removal of the only input", async () => {
      await mount();
      drop(file("a.jpg", "image/jpeg"));
      input().remove();
      // Drive the callback directly: happy-dom delivers target callbacks unreliably, and a
      // throw from one it delivers surfaces outside the test.
      expect(() =>
        (controller() as FileDropzoneController).inputTargetDisconnected(),
      ).not.toThrow();
      await tick();

      expect(names()).toEqual(["a.jpg"]);
    });

    it("mirrors nothing onto the input that stays once it has disconnected", async () => {
      await mount();
      drop(file("a.jpg", "image/jpeg"));
      const original = input();
      const successor = inputCopy();
      original.after(successor);
      await tick();
      const instance = controller() as FileDropzoneController;
      instance.disconnect();
      original.remove();
      instance.inputTargetDisconnected();
      instance.inputTargetConnected();

      expect(namesOn(successor)).toEqual([]);
    });

    it("leaves the files on an input that stops being the target", async () => {
      await mount();
      drop(file("a.jpg", "image/jpeg"));
      const original = input();
      const successor = inputCopy();
      original.after(successor);
      await tick();

      original.removeAttribute("data-stimeo--file-dropzone-target");
      await tick();

      expect(input()).toBe(successor);
      expect(namesOn(original)).toEqual(["a.jpg"]);
      expect(namesOn(successor)).toEqual(["a.jpg"]);
    });

    it("leaves the files on the input when the widget loses its controller", async () => {
      await mount();
      drop(file("a.jpg", "image/jpeg"));
      const departed = input();

      root().removeAttribute("data-controller");
      await tick();

      expect(namesOn(departed)).toEqual(["a.jpg"]);
    });

    it("keeps the selection on an input that moves within the widget", async () => {
      await mount();
      drop(file("a.jpg", "image/jpeg"));
      const moving = input();

      root().append(moving);
      await tick();

      expect(input()).toBe(moving);
      expect(namesOn(moving)).toEqual(["a.jpg"]);
    });

    /**
     * Chooses `files` in `element` the way its native dialog does. Stimulus binds the
     * action of an appended input unreliably under happy-dom, so the call it would make
     * with that event is made directly when the binding did not run.
     */
    const chooseIn = (element: HTMLInputElement, ...files: File[]) => {
      const instance = controller() as FileDropzoneController;
      const onChange = vi.spyOn(instance, "onChange");
      element.files = fileList(...files);
      const event = new Event("change", { bubbles: true });
      element.dispatchEvent(event);
      if (onChange.mock.calls.length === 0) instance.onChange(event);
      onChange.mockRestore();
    };

    it("adds the files chosen in an input that waits behind the one in use", async () => {
      await mount();
      drop(file("a.jpg", "image/jpeg"));
      const original = input();
      const successor = inputCopy();
      original.after(successor);
      await tick();
      const changes = changesFrom();

      chooseIn(successor, file("b.jpg", "image/jpeg"));

      expect(names()).toEqual(["a.jpg", "b.jpg"]);
      expect(namesOn(original)).toEqual(["a.jpg", "b.jpg"]);
      expect(changes).toHaveLength(1);
      original.remove();
      await tick();
      expect(namesOn(successor)).toEqual(["a.jpg", "b.jpg"]);
    });

    it("reads the input in use for a change no input dispatched, or with no event", async () => {
      await mount();
      const instance = controller() as FileDropzoneController;
      input().files = fileList(file("a.jpg", "image/jpeg"));
      const elsewhere = new Event("change", { bubbles: true });
      trigger().dispatchEvent(elsewhere);

      instance.onChange(elsewhere);
      input().files = fileList(file("b.jpg", "image/jpeg"));
      instance.onChange();

      expect(names()).toEqual(["a.jpg", "b.jpg"]);
    });
  });

  describe("a list that stays after an earlier one leaves", () => {
    const itemSelector = "[data-stimeo--file-dropzone-target='item']";

    /** Inserts an empty copy of the list after it and lets Stimulus report it. */
    const insertSuccessor = async (): Promise<[HTMLElement, HTMLElement]> => {
      const original = list();
      const successor = original.cloneNode(false) as HTMLElement;
      original.after(successor);
      await tick();
      return [original, successor];
    };

    it("keeps the previews in the first list while a successor waits behind it", async () => {
      await mount();
      drop(file("a.jpg", "image/jpeg"));
      const original = list();

      const [, successor] = await insertSuccessor();

      expect(list()).toBe(original);
      expect(original.querySelectorAll(itemSelector)).toHaveLength(1);
      expect(successor.querySelectorAll(itemSelector)).toHaveLength(0);
      drop(file("b.jpg", "image/jpeg"));
      expect(original.querySelectorAll(itemSelector)).toHaveLength(2);
      expect(successor.querySelectorAll(itemSelector)).toHaveLength(0);
    });

    it("moves the previews into a list that arrives in front of the current one", async () => {
      await mount();
      drop(file("a.jpg", "image/jpeg"));
      const original = list();
      const front = original.cloneNode(false) as HTMLElement;

      original.before(front);
      await tick();

      expect(list()).toBe(front);
      expect(front.querySelectorAll(itemSelector)).toHaveLength(1);
      expect(original.querySelectorAll(itemSelector)).toHaveLength(0);
      removeButtons()[0]?.click();
      expect(items()).toHaveLength(0);
      expect(inputNames()).toEqual([]);
    });

    it("moves every selected preview into the list that stays", async () => {
      await mount();
      drop(file("a.jpg", "image/jpeg"));
      const [original, successor] = await insertSuccessor();
      drop(file("b.jpg", "image/jpeg")); // rendered into the earlier list
      original.remove();
      await tick();

      expect(list()).toBe(successor);
      expect(successor.querySelectorAll(itemSelector)).toHaveLength(2);
      expect(names()).toEqual(["a.jpg", "b.jpg"]);
      removeButtons()[0]?.click();
      expect(names()).toEqual(["b.jpg"]);
      expect(inputNames()).toEqual(["b.jpg"]);
    });

    it("reports nothing while it moves the previews", async () => {
      await mount(ANNOUNCE_ATTRS);
      drop(file("a.jpg", "image/jpeg"));
      const [original] = await insertSuccessor();
      drop(file("b.jpg", "image/jpeg"));
      const reports = reportsFrom();
      const commits: Event[] = [];
      root().addEventListener("change", (event) => commits.push(event));
      announcements.length = 0;
      original.remove();
      await tick();

      expect(reports).toEqual([]);
      expect(commits).toEqual([]);
      expect(announcements).toEqual([]);
    });

    it("tolerates the removal of the only list", async () => {
      await mount();
      drop(file("a.jpg", "image/jpeg"));
      const only = list();
      only.remove();

      // Drive the callback directly: happy-dom delivers target callbacks unreliably.
      expect(() =>
        (controller() as FileDropzoneController).listTargetDisconnected(only),
      ).not.toThrow();
      expect(items()).toHaveLength(0);
      expect(inputNames()).toEqual(["a.jpg"]);
    });

    it("moves nothing into the list that stays once it has disconnected", async () => {
      await mount();
      drop(file("a.jpg", "image/jpeg"));
      const [original, successor] = await insertSuccessor();
      drop(file("b.jpg", "image/jpeg"));
      const instance = controller() as FileDropzoneController;
      instance.disconnect();
      original.remove();
      instance.listTargetDisconnected(original);

      expect(successor.querySelectorAll(itemSelector)).toHaveLength(0);
    });
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

  /** Puts a restored copy of the page in place, as Turbo renders one from its cache. */
  const restore = async () => {
    application = await restoreFromCache(application, (restored) =>
      restored.register("stimeo--file-dropzone", FileDropzoneController),
    );
  };

  /** Every `reconcile` that reaches the document, which outlives a restored body. */
  const reconcilesOnDocument = (): unknown[] => {
    const seen: unknown[] = [];
    document.addEventListener("stimeo--file-dropzone:reconcile", (e) =>
      seen.push((e as CustomEvent).detail),
    );
    return seen;
  };

  it("marks every item it renders as its own", async () => {
    await mount();
    drop(file("a.jpg", "image/jpeg"), file("b.jpg", "image/jpeg"));
    expect(
      items().map((item) => item.hasAttribute("data-stimeo--file-dropzone-generated")),
    ).toEqual([true, true]);
  });

  it("keeps the selection, the input and the zone hooks through turbo:before-cache", async () => {
    await mount();
    drop(file("a.jpg", "image/jpeg"), file("notes.txt", "text/plain"));
    dragOver();
    const reports = reportsFrom();

    // Turbo dispatches it on pages that stay as well, where this is the selection the
    // form is about to submit.
    document.dispatchEvent(new Event("turbo:before-cache"));

    expect(names()).toEqual(["a.jpg"]);
    expect(inputNames()).toEqual(["a.jpg"]);
    expect(revokedUrls).toEqual([]);
    expect(zone().hasAttribute("data-dragover")).toBe(true);
    expect(zone().hasAttribute("data-stimeo--file-dropzone-invalid")).toBe(true);
    expect(reports).toEqual([]);
  });

  it("removes the previews and the hooks a restored page carries, and reports it", async () => {
    await mount();
    drop(file("a.jpg", "image/jpeg"), file("notes.txt", "text/plain"));
    dragOver();
    const reports = reconcilesOnDocument();

    await restore();

    expect(items()).toHaveLength(0);
    expect(inputNames()).toEqual([]);
    expect(zone().hasAttribute("data-dragover")).toBe(false);
    expect(zone().hasAttribute("data-stimeo--file-dropzone-invalid")).toBe(false);
    expect(reports).toEqual([{ files: [] }]);
  });

  it("takes files on a restored page as a fresh selection", async () => {
    await mount('data-stimeo--file-dropzone-max-files-value="1"');
    drop(file("a.jpg", "image/jpeg"));

    await restore();
    const changes = changesFrom();
    drop(file("b.jpg", "image/jpeg"));

    // The discarded row counts towards nothing, and the new one can be removed.
    expect(names()).toEqual(["b.jpg"]);
    expect(changes).toHaveLength(1);
    removeButtons()[0]?.click();
    expect(items()).toHaveLength(0);
  });

  it("stays silent on a restored page that carries no selection", async () => {
    await mount();
    const reports = reconcilesOnDocument();

    await restore();

    expect(reports).toEqual([]);
  });

  it("keeps what the author put in the list on a restored page", async () => {
    await mount();
    list().insertAdjacentHTML("afterbegin", '<li id="authored">Already uploaded</li>');
    drop(file("a.jpg", "image/jpeg"));

    await restore();

    expect(document.getElementById("authored")).not.toBeNull();
    expect(items()).toHaveLength(0);
  });

  it("keeps an authored zone hook on a page with no previews to discard", async () => {
    document.body.innerHTML = markup().replace(
      'data-stimeo--file-dropzone-target="zone"',
      'data-stimeo--file-dropzone-target="zone" data-stimeo--file-dropzone-invalid=""',
    );
    application = Application.start();
    application.register("stimeo--file-dropzone", FileDropzoneController);
    await tick();

    expect(zone().hasAttribute("data-stimeo--file-dropzone-invalid")).toBe(true);
  });

  it("gives back the zone hooks of a restored page that carries them without any preview, silently", async () => {
    await mount();
    drop(file("notes.txt", "text/plain"));
    dragOver();
    expect(items()).toHaveLength(0);
    expect(zone().hasAttribute("data-stimeo--file-dropzone-invalid")).toBe(true);
    expect(zone().hasAttribute("data-dragover")).toBe(true);
    const reports = reconcilesOnDocument();

    await restore();

    expect(zone().hasAttribute("data-stimeo--file-dropzone-invalid")).toBe(false);
    expect(zone().hasAttribute("data-dragover")).toBe(false);
    expect(
      zone()
        .getAttributeNames()
        .filter((name) => name.endsWith("-lease")),
    ).toEqual([]);
    expect(reports).toEqual([]);
  });

  it("gives a restored zone the hook its author wrote when it discards the previews", async () => {
    document.body.innerHTML = markup().replace(
      'data-stimeo--file-dropzone-target="zone"',
      'data-stimeo--file-dropzone-target="zone" data-stimeo--file-dropzone-invalid=""',
    );
    application = Application.start();
    application.register("stimeo--file-dropzone", FileDropzoneController);
    await tick();
    drop(file("a.jpg", "image/jpeg"));
    expect(items()).toHaveLength(1);
    expect(zone().hasAttribute("data-stimeo--file-dropzone-invalid")).toBe(false);

    await restore();

    expect(items()).toHaveLength(0);
    expect(zone().getAttribute("data-stimeo--file-dropzone-invalid")).toBe("");
  });

  it("keeps the rejection hook of a selection-less zone across an in-page move", async () => {
    await mount();
    drop(file("notes.txt", "text/plain"));
    const controller = application.getControllerForElementAndIdentifier(
      document.querySelector("[data-controller='stimeo--file-dropzone']") as HTMLElement,
      "stimeo--file-dropzone",
    ) as FileDropzoneController;

    controller.disconnect();
    controller.connect();

    expect(zone().hasAttribute("data-stimeo--file-dropzone-invalid")).toBe(true);
  });

  it("discards a restored selection when the input target is gone", async () => {
    await mount();
    drop(file("a.jpg", "image/jpeg"), file("notes.txt", "text/plain"));
    input().removeAttribute("data-stimeo--file-dropzone-target");
    await tick();

    await restore();

    expect(items()).toHaveLength(0);
    expect(zone().hasAttribute("data-stimeo--file-dropzone-invalid")).toBe(false);
  });

  it("puts the previews and the zone hooks back after a morph empties them in place", async () => {
    await mount();
    drop(file("a.jpg", "image/jpeg"), file("notes.txt", "text/plain"));
    const reports = reportsFrom();
    const [item] = items();

    // A morph keeps only what the server rendered: no item, no hook.
    list().replaceChildren();
    zone().removeAttribute("data-stimeo--file-dropzone-invalid");
    await tick();

    expect(items()).toEqual([item]);
    expect(inputNames()).toEqual(["a.jpg"]);
    expect(zone().hasAttribute("data-stimeo--file-dropzone-invalid")).toBe(true);
    expect(reports).toEqual([]);
  });

  it("leaves the zone hooks alone on a list change that takes no preview out", async () => {
    await mount();
    drop(file("a.jpg", "image/jpeg"), file("notes.txt", "text/plain"));
    // The page takes the rejection hook over, then adds a node of its own to the list.
    zone().removeAttribute("data-stimeo--file-dropzone-invalid");
    list().insertAdjacentHTML("beforeend", "<li>Uploaded earlier</li>");
    await tick();

    expect(zone().hasAttribute("data-stimeo--file-dropzone-invalid")).toBe(false);
  });

  it("keeps its previews, its hooks and its silence when the same instance connects again", async () => {
    await mount();
    drop(file("a.jpg", "image/jpeg"), file("notes.txt", "text/plain"));
    const reports = reportsFrom();
    const instance = controller() as FileDropzoneController;

    instance.disconnect();
    instance.connect();
    await tick();

    expect(names()).toEqual(["a.jpg"]);
    expect(zone().hasAttribute("data-stimeo--file-dropzone-invalid")).toBe(true);
    expect(reports).toEqual([]);
  });

  it("leaves the list alone when its own removal takes a preview out", async () => {
    await mount();
    drop(file("a.jpg", "image/jpeg"), file("b.jpg", "image/jpeg"));

    removeButtons()[0]?.click();
    await tick();

    expect(names()).toEqual(["b.jpg"]);
  });

  it("stops watching its lists on disconnect", async () => {
    const observe = vi.spyOn(MutationObserver.prototype, "observe");
    const release = vi.spyOn(MutationObserver.prototype, "disconnect");
    try {
      await mount();
      const watch = observe.mock.calls.findIndex(
        ([target, options]) =>
          target === list() && JSON.stringify(options) === JSON.stringify({ childList: true }),
      );
      expect(watch).not.toBe(-1);
      const watcher = observe.mock.contexts[watch];

      controller()?.disconnect();
      expect(release.mock.contexts).toContain(watcher);
    } finally {
      observe.mockRestore();
      release.mockRestore();
    }
  });

  it("revokes every preview URL once the disconnect proves a real detach", async () => {
    await mount();
    drop(file("a.jpg", "image/jpeg"), file("b.jpg", "image/jpeg"));
    expect(createdUrls).toHaveLength(2);

    root().remove();
    await tick();

    expect(revokedUrls).toEqual(createdUrls);
  });

  it("clears selected files and zone state from a retained subtree on real detach", async () => {
    await mount(ANNOUNCE_ATTRS);
    drop(file("a.jpg", "image/jpeg"), file("b.jpg", "image/jpeg"), file("notes.txt", "text/plain"));
    dragOver();
    const element = root();
    const retainedList = list();
    const retainedInput = input();
    const retainedZone = zone();
    const instance = controller() as FileDropzoneController;
    const authored = document.createElement("li");
    retainedList.prepend(authored);
    const reports = reportsFrom();
    const messages = [...announcements];

    expect(retainedList.children).toHaveLength(3);
    expect(Array.from(retainedInput.files ?? []).map((selected) => selected.name)).toEqual([
      "a.jpg",
      "b.jpg",
    ]);
    expect(retainedZone.hasAttribute("data-dragover")).toBe(true);
    expect(retainedZone.hasAttribute("data-stimeo--file-dropzone-invalid")).toBe(true);
    expect(createdUrls).toHaveLength(2);
    expect(revokedUrls).toEqual([]);

    element.remove();
    instance.disconnect();

    expect(element.isConnected).toBe(false);
    expect(Array.from(retainedList.children)).toEqual([authored]);
    expect(Array.from(retainedInput.files ?? [])).toEqual([]);
    expect(retainedZone.hasAttribute("data-dragover")).toBe(false);
    expect(retainedZone.hasAttribute("data-stimeo--file-dropzone-invalid")).toBe(false);
    expect(revokedUrls).toEqual(createdUrls);
    expect(reports).toEqual([]);
    expect(announcements).toEqual(messages);
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

  it("reports an unusable template again on the next connection", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await mount("", undefined, without("name"));
    drop(file("a.jpg", "image/jpeg"));
    expect(warn).toHaveBeenCalledOnce();

    const instance = controller() as FileDropzoneController;
    instance.disconnect();
    instance.connect();
    drop(file("b.jpg", "image/jpeg"));

    expect(items()).toHaveLength(0);
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it.each([
    ["item", without("item"), '"item" root'],
    ["name", without("name"), '"name" target'],
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

  it("publishes a pending native file selection when its change is delivered", async () => {
    await mount();
    const chosen = file("first.png", "image/png");
    const changes: unknown[] = [];
    root().addEventListener("stimeo--file-dropzone:change", (event) =>
      changes.push((event as CustomEvent).detail),
    );
    input().files = fileList(chosen);
    input().dispatchEvent(new Event("change", { bubbles: true }));
    expect(changes).toEqual([{ files: [chosen] }]);
    expect(names()).toEqual(["first.png"]);
  });

  it("does not report a duplicate native selection as another confirmed set", async () => {
    await mount();
    const chosen = file("first.png", "image/png");
    chooseFiles(chosen);
    const changes: unknown[] = [];
    root().addEventListener("stimeo--file-dropzone:change", (event) =>
      changes.push((event as CustomEvent).detail),
    );
    input().files = fileList(chosen);
    input().dispatchEvent(new Event("change", { bubbles: true }));
    expect(changes).toEqual([]);
    expect(names()).toEqual(["first.png"]);
  });
});

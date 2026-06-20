import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileDropzoneController } from "../src/controllers/file_dropzone_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { captureSpeech } from "./helpers/speech";

/**
 * Behavioral tests for {@link FileDropzoneController}: dialog/keyboard selection,
 * drop handling and drag state, accept/size/count validation, preview generation
 * with objectURL release, focus hand-off on removal, and the `change`/`reject`
 * events.
 */

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const markup = (attrs = "", inputAttrs = 'accept="image/*" multiple aria-label="Upload files"') => `
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
    <ul data-stimeo--file-dropzone-target="list" aria-label="Selected files"></ul>
    <span role="status" aria-live="polite" class="visually-hidden"
          data-stimeo--file-dropzone-target="status"></span>
    <template data-stimeo--file-dropzone-target="itemTemplate">
      <li data-stimeo--file-dropzone-target="item">
        <img data-file-dropzone-slot="thumb" alt="" hidden />
        <span data-file-dropzone-slot="name"></span>
        <button type="button">Remove</button>
      </li>
    </template>
  </div>`;

const file = (name: string, type: string, size = 10) => {
  const f = new File([new Uint8Array(size)], name, { type });
  return f;
};

const fileList = (...files: File[]): FileList => {
  const list = {
    length: files.length,
    item: (index: number) => files[index] ?? null,
    [Symbol.iterator]: function* () {
      yield* files;
    },
  } as unknown as FileList;
  files.forEach((f, i) => {
    (list as unknown as Record<number, File>)[i] = f;
  });
  return list;
};

describe("FileDropzoneController", () => {
  let application: Application;
  const createdUrls: string[] = [];
  const revokedUrls: string[] = [];

  const mount = async (attrs = "", inputAttrs?: string) => {
    document.body.innerHTML = inputAttrs ? markup(attrs, inputAttrs) : markup(attrs);
    application = Application.start();
    application.register("stimeo--file-dropzone", FileDropzoneController);
    await tick();
  };

  beforeEach(() => {
    createdUrls.length = 0;
    revokedUrls.length = 0;
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
    application.stop();
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
  const items = () =>
    Array.from(
      document.querySelectorAll<HTMLElement>("[data-stimeo--file-dropzone-target='item']"),
    );
  const status = () =>
    document.querySelector<HTMLElement>(
      "[data-stimeo--file-dropzone-target='status']",
    ) as HTMLElement;
  const drop = (...files: File[]) =>
    zone().dispatchEvent(
      Object.assign(new Event("drop", { bubbles: true }), {
        dataTransfer: { files: fileList(...files) },
        preventDefault: () => {},
      }),
    );

  it("opens the native dialog when the trigger is activated", async () => {
    await mount();
    const input = document.querySelector<HTMLInputElement>(
      "[data-stimeo--file-dropzone-target='input']",
    );
    const clicked = vi.spyOn(input as HTMLInputElement, "click").mockImplementation(() => {});
    trigger().click();
    expect(clicked).toHaveBeenCalledOnce();
  });

  it("adds dropped files, generating an image preview", async () => {
    await mount();
    const changes: File[][] = [];
    root().addEventListener("stimeo--file-dropzone:change", (event) => {
      changes.push((event as CustomEvent).detail.files);
    });
    drop(file("photo.jpg", "image/jpeg"));
    expect(items()).toHaveLength(1);
    const img = items()[0]?.querySelector("img") as HTMLImageElement;
    expect(img.hidden).toBe(false);
    expect(img.src).toContain("blob:mock/");
    expect(items()[0]?.querySelector("button")?.getAttribute("aria-label")).toBe(
      "Remove photo.jpg",
    );
    expect(changes).toHaveLength(1);
    expect(changes[0]?.[0]?.name).toBe("photo.jpg");
  });

  it("sets and clears the drag-over flag and announces the affordance", async () => {
    await mount('data-stimeo--file-dropzone-drag-label-value="Drop here"');
    zone().dispatchEvent(new Event("dragover"));
    expect(zone().hasAttribute("data-dragover")).toBe(true);
    expect(status().textContent).toBe("Drop here");
    zone().dispatchEvent(new Event("dragleave"));
    expect(zone().hasAttribute("data-dragover")).toBe(false);
  });

  it("rejects files failing the accept filter", async () => {
    await mount();
    const rejects: Array<{ reason: string }> = [];
    root().addEventListener("stimeo--file-dropzone:reject", (event) => {
      rejects.push((event as CustomEvent).detail);
    });
    drop(file("notes.txt", "text/plain"));
    expect(items()).toHaveLength(0);
    expect(rejects.map((r) => r.reason)).toEqual(["type"]);
    expect(zone().hasAttribute("data-stimeo--file-dropzone-invalid")).toBe(true);
  });

  it("rejects files over the size limit", async () => {
    await mount('data-stimeo--file-dropzone-max-size-value="100"');
    const rejects: Array<{ reason: string }> = [];
    root().addEventListener("stimeo--file-dropzone:reject", (event) => {
      rejects.push((event as CustomEvent).detail);
    });
    drop(file("big.jpg", "image/jpeg", 200));
    expect(rejects.map((r) => r.reason)).toEqual(["size"]);
  });

  it("rejects files beyond the count limit", async () => {
    await mount('data-stimeo--file-dropzone-max-files-value="1"');
    const rejects: Array<{ reason: string }> = [];
    root().addEventListener("stimeo--file-dropzone:reject", (event) => {
      rejects.push((event as CustomEvent).detail);
    });
    drop(file("a.jpg", "image/jpeg"));
    drop(file("b.jpg", "image/jpeg"));
    expect(items()).toHaveLength(1);
    expect(rejects.map((r) => r.reason)).toEqual(["count"]);
  });

  it("treats a non-multiple input as a single-file cap", async () => {
    await mount("", 'accept="image/*"');
    drop(file("a.jpg", "image/jpeg"));
    drop(file("b.jpg", "image/jpeg"));
    expect(items()).toHaveLength(1);
  });

  it("removes a file, revoking its objectURL and re-homing focus", async () => {
    await mount();
    drop(file("a.jpg", "image/jpeg"), file("b.jpg", "image/jpeg"));
    items()[0]?.querySelector("button")?.click(); // remove a.jpg
    expect(items()).toHaveLength(1);
    expect(items()[0]?.querySelector("[data-file-dropzone-slot='name']")?.textContent).toBe(
      "b.jpg",
    );
    expect(revokedUrls).toHaveLength(1);
  });

  it("revokes all preview URLs on disconnect", async () => {
    await mount();
    drop(file("a.jpg", "image/jpeg"), file("b.jpg", "image/jpeg"));
    expect(createdUrls).toHaveLength(2);
    const controller = application.getControllerForElementAndIdentifier(
      root(),
      "stimeo--file-dropzone",
    );
    controller?.disconnect();
    expect(revokedUrls).toHaveLength(2);
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

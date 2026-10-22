import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FormDataProjection,
  prepareFormDataProjection,
  projectedFieldName,
} from "../../src/utils/form_data_projection";
import { query } from "../helpers/dom";
import { dispatchFormData } from "../helpers/form_data";

/** Reserved transport identities isolate one field while retaining native entry order. */
describe("FormDataProjection", () => {
  const holds: FormDataProjection[] = [];
  const hold = () => {
    const value = new FormDataProjection();
    holds.push(value);
    return value;
  };
  function fixture() {
    document.body.innerHTML =
      '<form id="f"><input name="same" value="before"><input id="field" name="same" type="hidden" value="raw"><input name="same" value="after"></form>';
    return {
      form: query<HTMLFormElement>("#f"),
      field: query<HTMLInputElement>("#field"),
    };
  }
  afterEach(() => {
    vi.unstubAllGlobals();
    for (const value of holds) value.release();
    holds.length = 0;
    document.body.innerHTML = "";
  });
  it("keeps public names, duplicate values and entry order while projecting once", () => {
    const { form, field } = fixture();
    let calls = 0;
    const projection = hold();
    projection.hold(field, () => {
      calls++;
      return "projected";
    });
    const key = field.name;
    projection.hold(field, () => "unexpected");
    expect(field.name).toBe(key);
    expect(field.value).toBe("raw");
    expect(projectedFieldName(key)).toBe("same");
    expect([...dispatchFormData(form)]).toEqual([
      ["same", "before"],
      ["same", "projected"],
      ["same", "after"],
    ]);
    expect(calls).toBe(1);
    projection.release();
    projection.release();
    expect(field.name).toBe("same");
    expect([...dispatchFormData(form)]).toEqual([
      ["same", "before"],
      ["same", "raw"],
      ["same", "after"],
    ]);
  });
  it("does not let a prior writer release a newer writer's identity", () => {
    const { form, field } = fixture();
    const older = hold();
    const newer = hold();
    older.hold(field, () => "old");
    newer.hold(field, () => "new");
    const key = field.name;
    older.release();
    expect(field.name).toBe(key);
    expect(dispatchFormData(form).getAll("same")).toEqual(["before", "new", "after"]);
    newer.release();
    expect(field.name).toBe("same");
  });
  it("returns only the current claim's identity when a morph writes the public name back", () => {
    const { form, field } = fixture();
    const older = hold();
    const newer = hold();
    older.hold(field, () => "old");
    newer.hold(field, () => "new");
    const key = field.name;
    field.name = "same";
    field.dispatchEvent(new Event("turbo:morph-element", { bubbles: true }));
    expect(field.name).toBe(key);
    expect(dispatchFormData(form).getAll("same")).toEqual(["before", "new", "after"]);
    newer.release();
    field.dispatchEvent(new Event("turbo:morph-element", { bubbles: true }));
    expect(field.name).toBe("same");
  });
  it("leaves an ordinary name written by the page intact until the next claim", () => {
    const { form, field } = fixture();
    const projection = hold();
    projection.hold(field, () => "ignored");
    field.name = "page";
    projection.release();
    expect(field.name).toBe("page");
    expect(dispatchFormData(form).get("page")).toBe("raw");
    projection.hold(field, () => "new-claim");
    expect(dispatchFormData(form).get("page")).toBe("new-claim");
  });
  it("keeps a retained identity registered after its field changes forms", () => {
    const { field } = fixture();
    const projection = hold();
    projection.hold(field, () => "kept");
    const key = field.name;
    const other = document.createElement("form");
    document.body.append(other);
    other.append(field);
    projection.hold(field, () => "replacement");
    expect([...dispatchFormData(other)]).toEqual([["same", "kept"]]);
    other.remove();
    expect([...dispatchFormData(other)]).toEqual([["same", "kept"]]);
    expect(field.name).toBe(key);
  });
  it("releases its previous field when the same holder claims another field", () => {
    const { form, field } = fixture();
    const projection = hold();
    projection.hold(field, () => "older-projection");
    const next = document.createElement("input");
    next.type = "hidden";
    next.name = "next";
    next.value = "next-raw";
    form.append(next);
    projection.hold(next, () => "next-projection");
    expect([...dispatchFormData(form)]).toEqual([
      ["same", "before"],
      ["same", "raw"],
      ["same", "after"],
      ["next", "next-projection"],
    ]);
    expect(field.name).toBe("same");
  });
  it("keeps nameless fields out of the entry list", () => {
    const { form, field } = fixture();
    field.removeAttribute("name");
    hold().hold(field, () => "never");
    expect(field.hasAttribute("name")).toBe(false);
    expect([...dispatchFormData(form)]).toEqual([
      ["same", "before"],
      ["same", "after"],
    ]);
  });
  it("decodes an orphaned copied entry as empty without accepting its stale value", () => {
    const { form, field } = fixture();
    const projection = hold();
    projection.hold(field, (value) => value);
    const copy = field.cloneNode() as HTMLInputElement;
    copy.removeAttribute("id");
    projection.release();
    form.append(copy);
    expect(dispatchFormData(form).getAll("same")).toEqual(["before", "raw", "after", ""]);
  });
  it("decodes a registered form while the entire form is detached", () => {
    const { form, field } = fixture();
    hold().hold(field, () => "detached");
    form.remove();
    expect(dispatchFormData(form).getAll("same")).toEqual(["before", "detached", "after"]);
  });
  it("prepares a new detached form without altering unrelated entries", () => {
    const { field } = fixture();
    hold().hold(field, () => "new-form");
    const form = document.createElement("form");
    form.append(field);
    prepareFormDataProjection(form);
    prepareFormDataProjection(form);
    expect([...dispatchFormData(form)]).toEqual([["same", "new-form"]]);
  });
  it("retains prior payload edits, File contents and later consumer entries", async () => {
    const { form, field } = fixture();
    hold().hold(field, (value) => (value === "raw" ? "produced" : value));
    form.addEventListener("formdata", (event) =>
      event.formData.append("file", new File(["content"], "sample.txt")),
    );
    const data = dispatchFormData(form);
    expect(data.getAll("same")).toEqual(["before", "produced", "after"]);
    const file = data.get("file") as File;
    expect(file.name).toBe("sample.txt");
    expect(await file.text()).toBe("content");
  });
  it.each([
    "ordinary",
    "__stimeo_raw_v1_short",
    "__stimeo_raw_v1_00000000000000000000000000000000:{",
    "__stimeo_raw_v1_00000000000000000000000000000000:42",
  ])("preserves non-protocol names (%s)", (name) => {
    expect(projectedFieldName(name)).toBe(name);
  });
  it("reclaims a restored transport name with a fresh identity", () => {
    const { form, field } = fixture();
    const first = hold();
    first.hold(field, () => "first");
    const copy = field.cloneNode() as HTMLInputElement;
    copy.id = "copy";
    first.release();
    field.remove();
    form.append(copy);
    hold().hold(copy, () => "accepted");
    expect(dispatchFormData(form).getAll("same")).toEqual(["before", "after", "accepted"]);
  });
  it("keeps the browser's hidden charset control outside the raw transport protocol", () => {
    const { field } = fixture();
    field.name = "_ChArSeT_";
    hold().hold(field, () => "not-a-charset");
    expect(field.name).toBe("_ChArSeT_");
  });
  it("does not require secure-context-only UUID support", () => {
    const { form, field } = fixture();
    vi.stubGlobal("crypto", { getRandomValues: crypto.getRandomValues.bind(crypto) });
    hold().hold(field, () => "available");
    expect(dispatchFormData(form).getAll("same")).toEqual(["before", "available", "after"]);
  });
  it.each(["release", "replace", "stale-release"])(
    "releases a producer while its sink remains alive (%s)",
    (mode) => {
      const script = resolve("tests/helpers/form_data_projection_gc.ts");
      const run = spawnSync("bun", [script, mode], { encoding: "utf8", timeout: 10000 });
      expect(run.stderr).toBe("");
      expect(run.status, run.stdout).toBe(0);
      expect(JSON.parse(run.stdout)).toEqual({ released: true, free: true, retained: true });
    },
  );
  it("projects a field moved to a connected form before that form is registered", () => {
    const { field } = fixture();
    hold().hold(field, () => "moved");
    const other = document.createElement("form");
    document.body.append(other);
    other.append(field);
    expect([...dispatchFormData(other)]).toEqual([["same", "moved"]]);
  });
  it("leaves a non-protocol name with a matching separator and JSON suffix intact", () => {
    const name = "x".repeat("__stimeo_raw_v1_".length + 32) + ':"public"';
    expect(projectedFieldName(name)).toBe(name);
    const invalid = "__stimeo_raw_v1_" + "0".repeat(32) + ';"public"';
    expect(projectedFieldName(invalid)).toBe(invalid);
  });
  it("ignores a plain event that carries no FormData", () => {
    const { form, field } = fixture();
    hold().hold(field, (value) => value);
    form.dispatchEvent(new Event("formdata", { bubbles: true }));
    expect(field.value).toBe("raw");
  });
});

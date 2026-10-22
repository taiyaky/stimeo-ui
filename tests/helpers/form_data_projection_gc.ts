import { Window } from "happy-dom";
import { FormDataProjection } from "../../src/utils/form_data_projection";

/** Isolates native weak references from the deterministic observer setup used by Vitest. */
const window = new Window();
const form = window.document.createElement("form");
const field = window.document.createElement("input");
field.name = "raw";
form.append(field);
window.document.body.append(form);
const older = new FormDataProjection();
const newer = new FormDataProjection();

/** The callback owns the producer; callers retain only its weak reference. */
function produce(projection: FormDataProjection, value: string): WeakRef<object> {
  const producer = { value };
  projection.hold(field as unknown as HTMLInputElement, () => producer.value);
  return new WeakRef(producer);
}

/** A stale release must leave the current claimant discoverable by the next writer. */
function supersededAfterStaleRelease(): WeakRef<object> {
  produce(older, "older");
  const middle = new FormDataProjection();
  const producer = produce(middle, "middle");
  older.release();
  produce(newer, "newer");
  return producer;
}

const producer =
  process.argv[2] === "stale-release" ? supersededAfterStaleRelease() : produce(older, "older");
if (process.argv[2] === "replace") produce(newer, "newer");
older.release();
const free = (() => new WeakRef({}))();
const retained = {};
const live = new WeakRef(retained);
for (let attempt = 0; attempt < 5; attempt++) {
  await new Promise((resolve) => setTimeout(resolve, 0));
  (globalThis as unknown as { Bun: { gc(force: boolean): void } }).Bun.gc(true);
}
const result = {
  released: producer.deref() === undefined,
  free: free.deref() === undefined,
  retained: live.deref() === retained,
};
console.log(JSON.stringify(result));
newer.release();
await window.happyDOM.close();
if (!result.released || !result.free || !result.retained) process.exitCode = 1;

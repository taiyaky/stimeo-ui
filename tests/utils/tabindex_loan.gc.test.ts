import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";
import { TabindexLoan } from "../../src/utils/tabindex_loan";
import { tick } from "../helpers/timing";

/** Gets native WeakRef from a fresh realm because test setup replaces global WeakRef with StrongRef. */
const NativeWeakRef = runInNewContext("WeakRef", Object.create(null)) as typeof WeakRef;

/** Uses only the attribute methods needed by TabindexLoan, avoiding happy-dom element roots. */
function makeTarget(): HTMLElement {
  const attributes = new Map<string, string>();
  return {
    getAttribute: (name: string) => attributes.get(name) ?? null,
    setAttribute: (name: string, value: string) => attributes.set(name, value),
    removeAttribute: (name: string) => attributes.delete(name),
  } as unknown as HTMLElement;
}

function forceFullGc(): void {
  const runtime = globalThis as unknown as {
    Bun?: { gc?: (fullCollection?: boolean) => void };
    gc?: () => void;
  };
  if (typeof runtime.Bun?.gc === "function") runtime.Bun.gc(true);
  else if (typeof runtime.gc === "function") runtime.gc();
  else throw new Error("This test requires explicit garbage-collection support.");
}

async function collected(target: WeakRef<object>): Promise<boolean> {
  for (let attempt = 0; attempt < 40; attempt++) {
    await tick();
    forceFullGc();
    await tick();
    if (target.deref() === undefined) return true;
  }
  return false;
}

function makeUnreferenced(): WeakRef<object> {
  const target = makeTarget();
  return new NativeWeakRef(target);
}

function makeReturned(): { loan: TabindexLoan; target: WeakRef<object> } {
  const loan = new TabindexLoan("-1", "stimeo--gc-probe");
  const element = makeTarget();
  loan.lend(element);
  loan.returnAll();
  return { loan, target: new NativeWeakRef(element) };
}

function makeStillLent(): { loan: TabindexLoan; target: WeakRef<object> } {
  const loan = new TabindexLoan("-1", "stimeo--gc-probe");
  const element = makeTarget();
  loan.lend(element);
  return { loan, target: new NativeWeakRef(element) };
}

it("releases returned targets and retains only live loans", async () => {
  for (let round = 0; round < 10; round++) {
    const collectorControl = makeUnreferenced();
    const returned = makeReturned();
    const stillLent = makeStillLent();

    expect(await collected(collectorControl)).toBe(true);
    expect(await collected(returned.target)).toBe(true);
    returned.loan.returnAll();

    expect(await collected(stillLent.target)).toBe(false);
    stillLent.loan.returnAll();
    expect(await collected(stillLent.target)).toBe(true);
    stillLent.loan.returnAll();
  }
}, 60_000);

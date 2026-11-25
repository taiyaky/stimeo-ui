import { Application, type ControllerConstructor } from "@hotwired/stimulus";
import { disconnectAndStopApplication, restoreFromCache } from "./stimulus";
import { tick } from "./timing";

/** A filtering component and the authored attributes its public actions can change. */
export interface OptionAttributeCase {
  readonly identifier: string;
  readonly controller: ControllerConstructor;
  readonly markup: string;
  readonly target: string;
  readonly watch: Readonly<Record<string, readonly string[]>>;
  readonly marks?: readonly string[];
  readonly arrange: (byId: (id: string) => HTMLElement) => void;
}

/** The DOM operation ends target ownership or detaches the whole component. */
export type OptionDeparture = "token" | "identifier" | "removal";

/** One departure, optionally applied to a copy restored from the cache. */
export interface OptionAttributeRow {
  readonly name: string;
  readonly item: OptionAttributeCase;
  readonly departure: OptionDeparture;
  readonly restored?: boolean;
}

/** A hidden authored candidate beside a visible candidate that the filter can hide. */
export interface HiddenOptionCase {
  readonly identifier: string;
  readonly controller: ControllerConstructor;
  readonly markup: string;
  readonly steps: readonly (readonly [string, (byId: (id: string) => HTMLElement) => void])[];
}

/** Fails when the fixture does not contain the named element. */
const byId = (id: string): HTMLElement => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Element not found: #${id}`);
  return element;
};

/** Reads attributes by stable fixture id. */
const snapshot = (item: OptionAttributeCase, root: ParentNode = document) =>
  Object.fromEntries(
    Object.entries(item.watch).map(([id, attributes]) => {
      const element = root.querySelector(`[id="${id}"]`);
      return [
        id,
        Object.fromEntries(
          attributes.map((attribute) => [attribute, element?.getAttribute(attribute) ?? null]),
        ),
      ];
    }),
  ) as Record<string, Record<string, string | null>>;

/** Removes one ownership token without changing other controller or target tokens. */
const dropToken = (element: Element, attribute: string, token: string): void => {
  const rest = (element.getAttribute(attribute) ?? "")
    .split(/\s+/)
    .filter((each) => each !== "" && each !== token);
  if (rest.length > 0) element.setAttribute(attribute, rest.join(" "));
  else element.removeAttribute(attribute);
};

/** Expands a fixture into departures on the live page and on a restored copy. */
export const optionAttributeRows = (
  name: string,
  item: OptionAttributeCase,
  departures: readonly OptionDeparture[],
  restored: readonly OptionDeparture[] = [],
): OptionAttributeRow[] => [
  ...departures.map((departure) => ({ name, item, departure })),
  ...restored.map((departure) => ({ name, item, departure, restored: true })),
];

/**
 * Returns attributes and persisted ownership records that violate the departure contract.
 * Target callbacks are delivered by Stimulus after the DOM operation.
 */
export async function measureOptionAttributes(row: OptionAttributeRow): Promise<unknown[]> {
  const { item, departure } = row;
  document.body.innerHTML = item.markup;
  const authored = snapshot(item);
  let application = Application.start();
  application.register(item.identifier, item.controller);
  try {
    await tick();
    item.arrange(byId);
    await tick();
    const written = snapshot(item);
    if (row.restored) {
      application = await restoreFromCache(application, (restored) =>
        restored.register(item.identifier, item.controller),
      );
    }
    const host = byId("host");
    if (departure === "token") {
      dropToken(byId("departing"), `data-${item.identifier}-target`, item.target);
    } else if (departure === "identifier") {
      dropToken(host, "data-controller", item.identifier);
    } else {
      host.remove();
    }
    await tick();
    const keeps = departure === "removal";
    const detached = document.createDocumentFragment();
    if (keeps) detached.append(host);
    const after = snapshot(item, keeps ? detached : document);

    const checked = departure === "token" ? ["departing"] : Object.keys(item.watch);
    const violations: unknown[] = [];
    let exercised = false;
    for (const id of checked) {
      for (const attribute of item.watch[id] ?? []) {
        const fact = {
          element: id,
          attribute,
          authored: authored[id]?.[attribute] ?? null,
          written: written[id]?.[attribute] ?? null,
          after: after[id]?.[attribute] ?? null,
        };
        if (fact.written !== fact.authored) exercised = true;
        const mark = item.marks?.includes(attribute) ?? false;
        const expected = keeps ? fact.written : fact.authored;
        if (fact.after !== expected && !(mark && fact.after === null)) {
          violations.push({ ...fact, expected });
        }
      }
      if (keeps) continue;
      const record = new RegExp(`^data-${item.identifier}-.+-(lease|hidden-region|tabindex-loan)$`);
      const element = byId(id);
      for (const attribute of element.getAttributeNames()) {
        if (record.test(attribute)) {
          violations.push({
            element: id,
            attribute,
            after: element.getAttribute(attribute),
            expected: null,
          });
        }
      }
    }
    if (!exercised && violations.length === 0) {
      throw new Error(
        `${row.name}: not measured, the arrangement wrote nothing the departure could undo`,
      );
    }
    return violations;
  } finally {
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
  }
}

/** Returns steps that reveal an authored-hidden candidate, requiring the filter to hide its probe. */
export async function measureHiddenOption(item: HiddenOptionCase): Promise<unknown[]> {
  document.body.innerHTML = item.markup;
  const application = Application.start();
  application.register(item.identifier, item.controller);
  try {
    const initialProbe = byId("probe").getAttribute("hidden");
    const facts: { step: string; authored: string | null; probe: string | null }[] = [];
    const record = (step: string) =>
      facts.push({
        step,
        authored: byId("authored").getAttribute("hidden"),
        probe: byId("probe").getAttribute("hidden"),
      });
    await tick();
    record("connect");
    for (const [name, act] of item.steps) {
      act(byId);
      await tick();
      record(name);
    }
    if (!facts.some((fact) => fact.probe !== initialProbe)) {
      throw new Error(`${item.identifier}: not measured, the steps never hid the probe`);
    }
    return facts.filter((fact) => fact.authored === null);
  } finally {
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
  }
}

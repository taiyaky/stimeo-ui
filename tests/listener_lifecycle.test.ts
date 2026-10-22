import { describe } from "vitest";
import { cableControllers } from "../src/cable/index";
import { stimeoControllers } from "../src/index";
import { positioningControllers } from "../src/positioning/index";
import { describeListenerRelease } from "./helpers/listeners";

/**
 * Every controller in `stimeoControllers`, `cableControllers` and `positioningControllers`
 * releases what its connection registered, apart from the document-lifetime listeners named
 * in `documentLifetime`, whether the release goes through `removeEventListener` or a signal,
 * and also after its `connect()` ran twice. The per-controller suites cover the listeners
 * that targets, Values and interactions add.
 */
describe("listener release across the controllers", () => {
  describeListenerRelease(
    { ...stimeoControllers, ...cableControllers, ...positioningControllers },
    {
      markup: {
        "stimeo--dirty-form": (identifier) =>
          `<form id="host" data-controller="${identifier}"><input name="title" value="draft"></form>`,
        "stimeo--input-mask": (identifier) =>
          `<input id="host" data-controller="${identifier}" data-${identifier}-pattern-value="999">`,
      },
      documentLifetime: {
        // The mask of a copy Turbo renders into the document is installed once per
        // document and identifier and kept for the document's life.
        "stimeo--password-reveal": [{ target: () => document, type: "turbo:before-render" }],
      },
    },
  );
});

import { Application, type ControllerConstructor } from "@hotwired/stimulus";
import { expect } from "vitest";
import { composeDraft } from "./ime";
import { disconnectAndStopApplication } from "./stimulus";
import { tick } from "./timing";

/** A field whose confirmed composition may be followed by a script's ordinary edit. */
export interface ConfirmedInputCase {
  readonly identifier: string;
  readonly controller: ControllerConstructor;
  readonly markup: string;
  readonly field: () => HTMLInputElement | HTMLTextAreaElement;
  readonly draft: string;
  readonly committed: string;
  readonly written: string;
  readonly facts: () => Record<string, unknown>;
}

/** The confirmation, focus departure and script write included in one observation. */
interface InputSequence {
  readonly composed: boolean;
  readonly blurred: boolean;
  readonly written: boolean;
}

/** Reads the public state after the selected IME and plain-input steps in a fresh mount. */
export async function observeConfirmedInput(
  item: ConfirmedInputCase,
  sequence: InputSequence,
): Promise<Record<string, unknown>> {
  document.body.innerHTML = `${item.markup}<input id="other-field" aria-label="Other field">`;
  const application = Application.start();
  application.register(item.identifier, item.controller);
  try {
    await tick();
    const field = item.field();
    field.focus();
    expect(document.activeElement).toBe(field);
    if (sequence.composed) {
      field.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      composeDraft(field, item.draft);
      field.value = item.committed;
      field.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    }
    if (sequence.blurred) {
      const other = document.getElementById("other-field");
      if (!(other instanceof HTMLInputElement)) throw new Error("Other field not found");
      other.focus();
      expect(document.activeElement).toBe(other);
    }
    if (sequence.written) {
      field.value = item.written;
      field.dispatchEvent(new Event("input", { bubbles: true }));
    }
    await tick();
    return item.facts();
  } finally {
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
  }
}

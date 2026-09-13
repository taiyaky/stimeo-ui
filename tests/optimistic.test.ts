import { Application } from "@hotwired/stimulus";
import { afterEach, describe, expect, it } from "vitest";
import { OptimisticController } from "../src/controllers/optimistic_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { captureSpeech } from "./helpers/speech";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { tick } from "./helpers/timing";

/**
 * Behavioral tests for {@link OptimisticController}: the submit-start
 * optimistic toggle (marker-tracked), commit on success, exact rollback on
 * failure, authored-state respect, cache-restore revert, and teardown.
 */

describe("OptimisticController", () => {
  let application: Application;

  const fixture = `
    <main>
      <form data-controller="stimeo--optimistic" action="/likes" method="post">
        <button type="submit" aria-label="Like">
          <span id="off" data-stimeo--optimistic-target="hide">♡</span>
          <span id="on" hidden data-stimeo--optimistic-target="show">♥</span>
        </button>
      </form>
    </main>`;

  const mount = async (html = fixture) => {
    document.body.innerHTML = html;
    application = Application.start();
    application.register("stimeo--optimistic", OptimisticController);
    await tick();
  };

  /** Starts a fresh application over `html`, the way a restored page arrives. */
  const remount = async (html: string) => {
    disconnectAndStopApplication(application);
    await mount(html);
  };

  afterEach(async () => {
    controller()?.disconnect();
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
    await tick();
  });

  const form = () => document.querySelector("form") as HTMLFormElement;
  const on = () => document.querySelector("#on") as HTMLElement;
  const off = () => document.querySelector("#off") as HTMLElement;
  const controller = () =>
    form()
      ? (application?.getControllerForElementAndIdentifier(
          form(),
          "stimeo--optimistic",
        ) as OptimisticController | null)
      : null;
  const submitStart = () =>
    form().dispatchEvent(new CustomEvent("turbo:submit-start", { bubbles: true }));
  const submitEnd = (success: boolean) =>
    form().dispatchEvent(
      new CustomEvent("turbo:submit-end", { bubbles: true, detail: { success } }),
    );

  it("applies the optimistic state on submit-start", async () => {
    await mount();
    submitStart();
    expect(on().hidden).toBe(false);
    expect(off().hidden).toBe(true);
    expect(form().getAttribute("data-optimistic")).toBe("true");
    expect(form().getAttribute("aria-busy")).toBe("true");
  });

  it("keeps the state and dispatches commit on success", async () => {
    await mount();
    const events: string[] = [];
    form().addEventListener("stimeo--optimistic:commit", () => events.push("commit"));
    submitStart();
    submitEnd(true);
    expect(on().hidden).toBe(false);
    expect(form().hasAttribute("data-optimistic")).toBe(false);
    expect(form().hasAttribute("aria-busy")).toBe(false);
    expect(events).toEqual(["commit"]);
  });

  it("rolls back exactly the toggled state and dispatches rollback on failure", async () => {
    await mount();
    const events: string[] = [];
    form().addEventListener("stimeo--optimistic:rollback", () => events.push("rollback"));
    submitStart();
    submitEnd(false);
    expect(on().hidden).toBe(true);
    expect(off().hidden).toBe(false);
    expect(form().hasAttribute("data-optimistic")).toBe(false);
    expect(events).toEqual(["rollback"]);
  });

  it("never reverts a target it did not toggle (authored state wins)", async () => {
    // The show target is already visible: the controller must not mark it, so a
    // failure leaves it exactly as authored.
    await mount(`
      <main>
        <form data-controller="stimeo--optimistic" action="/likes" method="post">
          <span id="on" data-stimeo--optimistic-target="show">♥</span>
          <button type="submit">Like</button>
        </form>
      </main>`);
    submitStart();
    submitEnd(false);
    expect(on().hidden).toBe(false);
  });

  it("reverts a cache snapshot taken mid-submit on connect", async () => {
    // The snapshot carries the records the mid-submit writes left behind: the
    // authored `hidden` of each toggled face and the authored `aria-busy`.
    await mount(`
      <main>
        <form data-controller="stimeo--optimistic" data-optimistic="true" aria-busy="true"
              data-optimistic-busy="absent" action="/likes" method="post">
          <span id="off" hidden data-optimistic-toggled="absent"
                data-stimeo--optimistic-target="hide">♡</span>
          <span id="on" data-optimistic-toggled="value:"
                data-stimeo--optimistic-target="show">♥</span>
          <button type="submit">Like</button>
        </form>
      </main>`);
    expect(form().hasAttribute("data-optimistic")).toBe(false);
    expect(form().hasAttribute("aria-busy")).toBe(false);
    expect(form().hasAttribute("data-optimistic-busy")).toBe(false);
    expect(off().hidden).toBe(false);
    expect(on().hidden).toBe(true);
    expect(document.querySelectorAll("[data-optimistic-toggled]")).toHaveLength(0);
  });

  it("stops reacting after disconnect", async () => {
    await mount();
    controller()?.disconnect();
    submitStart();
    expect(form().hasAttribute("data-optimistic")).toBe(false);
    expect(on().hidden).toBe(true);
  });

  it("has no machine-detectable a11y violations", async () => {
    await mount();
    await expectNoA11yViolations(document.body);
  });

  // --- Speech order -----------------------------------------------------------

  it("flips the announced face with the optimistic toggle and restores it on rollback", async () => {
    // The button is named by its VISIBLE face (no aria-label), so the optimistic
    // `hidden` flip is exactly what a screen reader hears.
    await mount(`
      <main>
        <form data-controller="stimeo--optimistic" action="/likes" method="post">
          <button type="submit">
            <span data-stimeo--optimistic-target="hide">Like</span>
            <span hidden data-stimeo--optimistic-target="show">Liked</span>
          </button>
        </form>
      </main>`);
    const container = document.querySelector("main") as HTMLElement;
    const idle = await captureSpeech({ container, steps: 2 });
    // Freeze the whole ordered array: only the authored (visible) face names the
    // button — the hidden face is out of the accessibility tree.
    expect(idle).toEqual(["main", "form", "button, Like"]);

    // Optimistic state: the faces flip, so the announced name flips with them
    // (`aria-busy` is set on the form; the virtual reader does not voice it).
    submitStart();
    const optimistic = await captureSpeech({ container, steps: 2 });
    expect(optimistic).toEqual(["main", "form", "button, Liked"]);

    // Rollback restores exactly the authored faces — and the idle announcement.
    submitEnd(false);
    const rolledBack = await captureSpeech({ container, steps: 2 });
    expect(rolledBack).toEqual(idle);
  });
  // --- Which submission a terminal belongs to -------------------------------

  describe("submission ownership", () => {
    /** Turbo names the submission on both events; these fixtures do the same. */
    const startOf = (el: Element, submission: object) =>
      el.dispatchEvent(
        new CustomEvent("turbo:submit-start", {
          bubbles: true,
          detail: { formSubmission: submission },
        }),
      );
    const endOf = (el: Element, submission: object, success?: boolean) =>
      el.dispatchEvent(
        new CustomEvent("turbo:submit-end", {
          bubbles: true,
          detail: { formSubmission: submission, ...(success === undefined ? {} : { success }) },
        }),
      );
    const wrapper = `
      <main>
        <div data-controller="stimeo--optimistic">
          <form id="like" action="/likes" method="post">
            <button type="submit">
              <span id="off" data-stimeo--optimistic-target="hide">Like</span>
              <span id="on" hidden data-stimeo--optimistic-target="show">Liked</span>
            </button>
          </form>
          <form id="search" action="/search" method="get"><button type="submit">Go</button></form>
        </div>
      </main>`;
    const wrap = () => document.querySelector("[data-controller]") as HTMLElement;
    const like = () => document.querySelector("#like") as HTMLFormElement;
    const search = () => document.querySelector("#search") as HTMLFormElement;
    const seen: string[] = [];
    const listen = () => {
      seen.length = 0;
      wrap().addEventListener("stimeo--optimistic:commit", () => seen.push("commit"));
      wrap().addEventListener("stimeo--optimistic:rollback", () => seen.push("rollback"));
    };

    it("ignores a sibling form's terminal while another submission owns the state", async () => {
      await mount(wrapper);
      listen();
      const liking = {};
      startOf(like(), liking);
      endOf(search(), {}, true);
      expect(seen).toEqual([]);
      expect(wrap().getAttribute("data-optimistic")).toBe("true");
      expect(on().hidden).toBe(false);
      expect(on().hasAttribute("data-optimistic-toggled")).toBe(true);
    });

    it("still rolls back when the owning submission fails after a sibling finished", async () => {
      await mount(wrapper);
      listen();
      const liking = {};
      startOf(like(), liking);
      endOf(search(), {}, true);
      endOf(like(), liking, false);
      expect(seen).toEqual(["rollback"]);
      expect(on().hidden).toBe(true);
      expect(off().hidden).toBe(false);
    });

    it("ignores a sibling terminal that arrives before the owning one, in either order", async () => {
      await mount(wrapper);
      listen();
      const liking = {};
      startOf(like(), liking);
      endOf(like(), liking, true);
      endOf(search(), {}, false);
      expect(seen).toEqual(["commit"]);
      expect(on().hidden).toBe(false);
    });

    it("hands ownership to the newest submission, so an abandoned one cannot strand it", async () => {
      await mount(wrapper);
      listen();
      const abandoned = {};
      startOf(like(), abandoned);
      like().remove(); // its terminal will never reach the wrapper
      const fresh = {};
      startOf(search(), fresh);
      endOf(search(), fresh, true);
      expect(seen).toEqual(["commit"]);
      expect(wrap().hasAttribute("data-optimistic")).toBe(false);
      expect(wrap().hasAttribute("aria-busy")).toBe(false);
    });

    it("does nothing for a terminal that no start preceded", async () => {
      await mount();
      const events: string[] = [];
      form().addEventListener("stimeo--optimistic:commit", () => events.push("commit"));
      form().addEventListener("stimeo--optimistic:rollback", () => events.push("rollback"));
      submitEnd(true);
      submitEnd(false);
      expect(events).toEqual([]);
      expect(form().hasAttribute("data-optimistic")).toBe(false);
      expect(on().hidden).toBe(true);
    });

    it("resolves a submission once, so a repeated terminal cannot undo it", async () => {
      await mount();
      const events: string[] = [];
      form().addEventListener("stimeo--optimistic:commit", () => events.push("commit"));
      form().addEventListener("stimeo--optimistic:rollback", () => events.push("rollback"));
      submitStart();
      submitEnd(true);
      submitEnd(false);
      expect(events).toEqual(["commit"]);
      expect(on().hidden).toBe(false);
    });
  });

  // --- An in-page move is not a restore --------------------------------------

  describe("in-page move", () => {
    it("keeps an in-flight optimistic state across a reconnect", async () => {
      await mount();
      const events: string[] = [];
      form().addEventListener("stimeo--optimistic:commit", () => events.push("commit"));
      submitStart();
      const instance = controller() as OptimisticController;
      instance.disconnect();
      instance.connect();
      // Asserted synchronously: the subject is what `connect()` does on the
      // reconnect half of a move. Yielding here hands the element to a second
      // controller instance, which is a first connect and rewinds by contract.
      expect(form().getAttribute("data-optimistic")).toBe("true");
      expect(form().getAttribute("aria-busy")).toBe("true");
      expect(on().hidden).toBe(false);
      expect(on().hasAttribute("data-optimistic-toggled")).toBe(true);

      submitEnd(true);
      expect(events).toEqual(["commit"]);
      expect(on().hidden).toBe(false);
      expect(form().hasAttribute("data-optimistic")).toBe(false);
    });

    it("still rewinds a restored snapshot, which no move preceded", async () => {
      await mount(`
        <main>
          <form data-controller="stimeo--optimistic" data-optimistic="true" aria-busy="true"
                data-optimistic-busy="absent" action="/likes" method="post">
            <span id="on" data-optimistic-toggled="value:"
                  data-stimeo--optimistic-target="show">♥</span>
            <span id="off" hidden data-optimistic-toggled="absent"
                  data-stimeo--optimistic-target="hide">♡</span>
          </form>
        </main>`);
      expect(form().hasAttribute("data-optimistic")).toBe(false);
      expect(on().hidden).toBe(true);
      expect(off().hidden).toBe(false);
    });
  });

  // --- What a rollback puts back ---------------------------------------------

  describe("authored values", () => {
    it("restores an element registered as both faces to what the author wrote", async () => {
      await mount(`
        <main>
          <form data-controller="stimeo--optimistic" action="/likes" method="post">
            <span id="both" hidden data-stimeo--optimistic-target="show hide">Both</span>
          </form>
        </main>`);
      const both = document.querySelector("#both") as HTMLElement;
      submitStart();
      submitEnd(false);
      expect(both.hasAttribute("hidden")).toBe(true);
      expect(both.hasAttribute("data-optimistic-toggled")).toBe(false);
    });

    it("puts a visible element registered as both faces back on show", async () => {
      await mount(`
        <main>
          <form data-controller="stimeo--optimistic" action="/likes" method="post">
            <span id="both" data-stimeo--optimistic-target="show hide">Both</span>
          </form>
        </main>`);
      const both = document.querySelector("#both") as HTMLElement;
      submitStart();
      expect(both.getAttribute("hidden")).toBe(""); // the hide pass runs last
      submitEnd(false);
      expect(both.hasAttribute("hidden")).toBe(false); // and the author had it visible
    });

    it("puts back an authored until-found on an element registered as both faces", async () => {
      await mount(`
        <main>
          <form data-controller="stimeo--optimistic" action="/likes" method="post">
            <span id="both" hidden="until-found" data-stimeo--optimistic-target="show hide">Both</span>
          </form>
        </main>`);
      const both = document.querySelector("#both") as HTMLElement;
      submitStart();
      submitEnd(false);
      expect(both.getAttribute("hidden")).toBe("until-found");
    });

    it("puts back an authored hidden=until-found instead of a plain hidden", async () => {
      await mount(`
        <main>
          <form data-controller="stimeo--optimistic" action="/likes" method="post">
            <span id="uf" hidden="until-found" data-stimeo--optimistic-target="show">Liked</span>
          </form>
        </main>`);
      const uf = document.querySelector("#uf") as HTMLElement;
      submitStart();
      expect(uf.hasAttribute("hidden")).toBe(false);
      submitEnd(false);
      expect(uf.getAttribute("hidden")).toBe("until-found");
    });

    it("leaves an already-correct hidden=until-found face untouched through a commit", async () => {
      await mount(`
        <main>
          <form data-controller="stimeo--optimistic" action="/likes" method="post">
            <span id="uf" hidden="until-found" data-stimeo--optimistic-target="hide">Like</span>
          </form>
        </main>`);
      const uf = document.querySelector("#uf") as HTMLElement;
      submitStart();
      submitEnd(true);
      expect(uf.getAttribute("hidden")).toBe("until-found");
    });

    it("leaves a face something else moved in flight, dropping only the record", async () => {
      await mount();
      submitStart();
      // A value this controller never writes, so a naive write-back would show.
      on().setAttribute("hidden", "until-found");
      submitEnd(false);
      expect(on().getAttribute("hidden")).toBe("until-found");
      expect(on().hasAttribute("data-optimistic-toggled")).toBe(false);
      expect(off().hidden).toBe(false);
    });

    it("leaves aria-busy alone when Turbo cleared it before the terminal", async () => {
      // On the form itself Turbo marks busy before submit-start and clears it
      // before submit-end, so what it wrote must not come back as an authored value.
      await mount();
      form().setAttribute("aria-busy", "true"); // Turbo's markAsBusy
      submitStart();
      // Turbo owns the attribute here, so nothing of the author's is recorded.
      expect(form().getAttribute("data-optimistic-busy")).toBe("absent");
      form().removeAttribute("aria-busy"); // Turbo's clearBusyState
      submitEnd(true);
      expect(form().hasAttribute("aria-busy")).toBe(false);
      expect(form().hasAttribute("data-optimistic-busy")).toBe(false);
    });

    it("rewinds a form snapshot taken mid-submit without a stale aria-busy", async () => {
      await mount();
      form().setAttribute("aria-busy", "true"); // Turbo's markAsBusy, before submit-start
      submitStart();
      // What Turbo cached mid-submit, restored on a page where no terminal follows.
      const snapshot = (document.querySelector("main") as HTMLElement).outerHTML;
      await remount(snapshot);

      expect(form().hasAttribute("data-optimistic")).toBe(false);
      expect(on().hidden).toBe(true);
      expect(form().hasAttribute("aria-busy")).toBe(false);
    });

    it("keeps an authored aria-busy on a wrapper element", async () => {
      // Turbo owns aria-busy on the form itself; on a wrapper this controller is
      // the only writer, so the authored value has to come back.
      await mount(`
        <main>
          <div data-controller="stimeo--optimistic" aria-busy="false">
            <form action="/likes" method="post">
              <span id="on" hidden data-stimeo--optimistic-target="show">Liked</span>
            </form>
          </div>
        </main>`);
      const wrap = document.querySelector("[data-controller]") as HTMLElement;
      form().dispatchEvent(new CustomEvent("turbo:submit-start", { bubbles: true }));
      expect(wrap.getAttribute("aria-busy")).toBe("true");
      form().dispatchEvent(
        new CustomEvent("turbo:submit-end", { bubbles: true, detail: { success: true } }),
      );
      expect(wrap.getAttribute("aria-busy")).toBe("false");
      expect(wrap.hasAttribute("data-optimistic-busy")).toBe(false);
    });
  });

  // --- The record's lifecycle -------------------------------------------------

  describe("records", () => {
    it("records only the faces it actually moved", async () => {
      await mount();
      submitStart();
      expect(on().getAttribute("data-optimistic-toggled")).toBe("value:");
      expect(off().getAttribute("data-optimistic-toggled")).toBe("absent");
      expect(form().getAttribute("data-optimistic-busy")).toBe("absent");
    });

    it("drops the records on commit and on rollback alike", async () => {
      await mount();
      submitStart();
      submitEnd(true);
      expect(document.querySelectorAll("[data-optimistic-toggled]")).toHaveLength(0);
      expect(form().hasAttribute("data-optimistic-busy")).toBe(false);

      submitStart();
      submitEnd(false);
      expect(document.querySelectorAll("[data-optimistic-toggled]")).toHaveLength(0);
    });

    it("never reverts a confirmed face on a later failure", async () => {
      await mount();
      submitStart();
      submitEnd(true);
      expect(on().hidden).toBe(false);
      submitStart(); // the faces are already in the confirmed state: nothing moves
      submitEnd(false);
      expect(on().hidden).toBe(false);
      expect(off().hidden).toBe(true);
    });

    it("never reverts a face the author restored after a rollback", async () => {
      await mount();
      submitStart();
      submitEnd(false);
      on().hidden = false; // the author shows the liked face themselves
      submitStart();
      submitEnd(false);
      expect(on().hidden).toBe(false);
    });
  });

  // --- The optional target contract -------------------------------------------

  describe("targets", () => {
    it("hooks and dispatches for a form with no targets at all", async () => {
      await mount(`
        <main>
          <form data-controller="stimeo--optimistic" action="/likes" method="post">
            <button type="submit">Like</button>
          </form>
        </main>`);
      const events: string[] = [];
      form().addEventListener("stimeo--optimistic:commit", () => events.push("commit"));
      submitStart();
      expect(form().getAttribute("data-optimistic")).toBe("true");
      expect(form().getAttribute("aria-busy")).toBe("true");
      submitEnd(true);
      expect(events).toEqual(["commit"]);
      expect(form().hasAttribute("aria-busy")).toBe(false);
    });

    it("toggles and restores every target, not just the first", async () => {
      await mount(`
        <main>
          <form data-controller="stimeo--optimistic" action="/likes" method="post">
            <span id="s1" hidden data-stimeo--optimistic-target="show">A</span>
            <span id="s2" hidden data-stimeo--optimistic-target="show">B</span>
            <span id="h1" data-stimeo--optimistic-target="hide">C</span>
            <span id="h2" data-stimeo--optimistic-target="hide">D</span>
          </form>
        </main>`);
      const at = (id: string) => document.querySelector(`#${id}`) as HTMLElement;
      submitStart();
      expect([at("s1").hidden, at("s2").hidden]).toEqual([false, false]);
      expect([at("h1").hidden, at("h2").hidden]).toEqual([true, true]);
      submitEnd(false);
      expect([at("s1").hidden, at("s2").hidden]).toEqual([true, true]);
      expect([at("h1").hidden, at("h2").hidden]).toEqual([false, false]);
    });
  });

  // --- Delegation --------------------------------------------------------------

  describe("delegated listeners", () => {
    it("works for a form nested under the controller element", async () => {
      await mount(`
        <main>
          <div data-controller="stimeo--optimistic">
            <form action="/likes" method="post">
              <span id="on" hidden data-stimeo--optimistic-target="show">Liked</span>
              <span id="off" data-stimeo--optimistic-target="hide">Like</span>
            </form>
          </div>
        </main>`);
      const wrap = document.querySelector("[data-controller]") as HTMLElement;
      const events: string[] = [];
      wrap.addEventListener("stimeo--optimistic:rollback", () => events.push("rollback"));
      form().dispatchEvent(new CustomEvent("turbo:submit-start", { bubbles: true }));
      expect(wrap.getAttribute("data-optimistic")).toBe("true");
      expect(on().hidden).toBe(false);
      form().dispatchEvent(
        new CustomEvent("turbo:submit-end", { bubbles: true, detail: { success: false } }),
      );
      expect(events).toEqual(["rollback"]);
      expect(on().hidden).toBe(true);
    });

    it("works for a form swapped in after connect", async () => {
      await mount(`
        <main>
          <div data-controller="stimeo--optimistic">
            <form id="old" action="/likes" method="post"></form>
          </div>
        </main>`);
      const wrap = document.querySelector("[data-controller]") as HTMLElement;
      (document.querySelector("#old") as HTMLElement).outerHTML = `
        <form id="fresh" action="/likes" method="post">
          <span id="on" hidden data-stimeo--optimistic-target="show">Liked</span>
        </form>`;
      await tick();
      const fresh = document.querySelector("#fresh") as HTMLFormElement;
      fresh.dispatchEvent(new CustomEvent("turbo:submit-start", { bubbles: true }));
      expect(wrap.getAttribute("data-optimistic")).toBe("true");
      expect(on().hidden).toBe(false);
    });
  });

  // --- Teardown and terminal shapes --------------------------------------------

  describe("teardown", () => {
    it("stops reacting to both lifecycle events after disconnect", async () => {
      await mount();
      const events: string[] = [];
      form().addEventListener("stimeo--optimistic:commit", () => events.push("commit"));
      form().addEventListener("stimeo--optimistic:rollback", () => events.push("rollback"));
      submitStart();
      controller()?.disconnect();
      submitEnd(true);
      submitEnd(false);
      expect(events).toEqual([]);
    });
  });

  describe("a real detach", () => {
    it("forgets the submission it owned, so a later terminal resolves nothing", async () => {
      await mount();
      const events: string[] = [];
      form().addEventListener("stimeo--optimistic:commit", () => events.push("commit"));
      submitStart();

      const main = document.querySelector("main") as HTMLElement;
      const el = form();
      el.remove(); // a real detach: the teardown runs synchronously
      await tick();
      main.append(el); // back in, with no submission in flight: a restore
      await tick();
      expect(el.hasAttribute("data-optimistic")).toBe(false);

      submitEnd(true); // the abandoned submission's terminal
      expect(events).toEqual([]);
    });
  });

  describe("terminals Turbo actually sends", () => {
    it("treats a terminal with no success key as a failure", async () => {
      await mount();
      const events: string[] = [];
      form().addEventListener("stimeo--optimistic:rollback", () => events.push("rollback"));
      submitStart();
      // Turbo leaves `result` unset when it aborts a submission, so the spread
      // that builds the terminal's detail carries no `success` key at all.
      form().dispatchEvent(new CustomEvent("turbo:submit-end", { bubbles: true, detail: {} }));
      expect(events).toEqual(["rollback"]);
      expect(on().hidden).toBe(true);
      expect(off().hidden).toBe(false);
    });
  });
});

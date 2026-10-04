import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PortalController } from "../src/controllers/portal_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { query } from "./helpers/dom";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { flushMicrotasks, tick } from "./helpers/timing";

/**
 * Behavioral tests for {@link PortalController}: the teleport on connect with a comment
 * placeholder, append / prepend positioning, custom destinations, restore-on-disconnect
 * (and removal when restore is off), unparsable and empty destinations falling back to
 * the default, the mount / unmount
 * events, and the "in-page move vs real detach" discrimination (DetachGate) — including
 * the scoped-application observed-root cases on both markup forms — and the node
 * following a `to` / `position` declaration that changes while connected.
 */

describe("PortalController", () => {
  let application: Application;

  const setup = (html: string) => {
    document.body.innerHTML = html;
  };
  const start = async () => {
    application = Application.start();
    application.register("stimeo--portal", PortalController);
    await tick();
  };

  beforeEach(() => {
    document.body.innerHTML = "";
  });

  afterEach(() => {
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
  });

  const src = () => query("#src");
  const content = () => query("#c");
  const hasComment = (el: Element) =>
    Array.from(el.childNodes).some((n) => n.nodeType === Node.COMMENT_NODE);

  it("teleports the content target into the destination, leaving a placeholder", async () => {
    setup(
      `<div id="dest"></div>
       <div id="src" data-controller="stimeo--portal" data-stimeo--portal-to-value="#dest">
         <div data-stimeo--portal-target="content" id="c">hi</div>
       </div>`,
    );
    await start();
    expect(content().parentElement?.id).toBe("dest");
    expect(content().getAttribute("data-portaled")).toBe("true");
    // A comment placeholder marks the original spot inside #src.
    expect(hasComment(src())).toBe(true);
  });

  it("teleports the controller element itself when there is no content target", async () => {
    setup(
      `<div id="dest"></div>
       <div id="wrap"><div id="src" data-controller="stimeo--portal" data-stimeo--portal-to-value="#dest">x</div></div>`,
    );
    await start();
    expect(src().parentElement?.id).toBe("dest");
    expect(src().getAttribute("data-portaled")).toBe("true");
    // Placeholder left behind in the original wrapper.
    expect(hasComment(query("#wrap"))).toBe(true);
  });

  it("teleports the controller element once, however often Stimulus reconnects it", async () => {
    setup(
      `<div id="dest"></div>
       <div id="wrap"><div id="src" data-controller="stimeo--portal" data-stimeo--portal-to-value="#dest">x</div></div>`,
    );
    let mounts = 0;
    src().addEventListener("stimeo--portal:mount", () => {
      mounts += 1;
    });
    await start();
    await tick();
    expect(src().parentElement?.id).toBe("dest");
    expect(mounts).toBe(1);
    const placeholders = Array.from(query("#wrap").childNodes).filter(
      (node) => node.nodeType === Node.COMMENT_NODE,
    );
    expect(placeholders).toHaveLength(1);
  });

  it("prepends to the destination when position is prepend", async () => {
    setup(
      `<div id="dest"><span id="existing"></span></div>
       <div id="src" data-controller="stimeo--portal" data-stimeo--portal-to-value="#dest"
            data-stimeo--portal-position-value="prepend">
         <div data-stimeo--portal-target="content" id="c">hi</div>
       </div>`,
    );
    await start();
    expect(query("#dest").firstElementChild?.id).toBe("c");
  });

  it("appends to the end of the destination by default", async () => {
    setup(
      `<div id="dest"><span id="existing"></span></div>
       <div id="src" data-controller="stimeo--portal" data-stimeo--portal-to-value="#dest">
         <div data-stimeo--portal-target="content" id="c">hi</div>
       </div>`,
    );
    await start();
    expect(query("#dest").lastElementChild?.id).toBe("c");
    expect(query("#dest").firstElementChild?.id).toBe("existing");
  });

  it("defaults the destination to body", async () => {
    setup(
      `<div id="src" data-controller="stimeo--portal">
         <div data-stimeo--portal-target="content" id="c">hi</div>
       </div>`,
    );
    await start();
    expect(content().parentElement).toBe(document.body);
  });

  it("emits mount with the destination on connect", async () => {
    setup(
      `<div id="dest"></div>
       <div id="src" data-controller="stimeo--portal" data-stimeo--portal-to-value="#dest">
         <div data-stimeo--portal-target="content" id="c">hi</div>
       </div>`,
    );
    const mounts: Array<EventTarget | null> = [];
    document.addEventListener("stimeo--portal:mount", (e) =>
      mounts.push((e as CustomEvent).detail.destination),
    );
    await start();
    expect(mounts).toEqual([query("#dest")]);
  });

  it("restores the node to its placeholder on disconnect", async () => {
    setup(
      `<div id="dest"></div>
       <div id="src" data-controller="stimeo--portal" data-stimeo--portal-to-value="#dest">
         <div data-stimeo--portal-target="content" id="c">hi</div>
       </div>`,
    );
    await start();
    const wrap = src();
    const node = content();
    const unmounts: number[] = [];
    wrap.addEventListener("stimeo--portal:unmount", () => unmounts.push(1));

    wrap.remove(); // removing the source triggers disconnect
    await tick();
    expect(node.parentElement).toBe(wrap); // back inside the (now detached) source
    expect(node.hasAttribute("data-portaled")).toBe(false);
    expect(query("#dest").children.length).toBe(0);
    expect(unmounts).toEqual([1]);
  });

  it("tears down when the identifier is removed but the element stays in the DOM", async () => {
    setup(
      `<div id="dest"></div>
       <div id="src" data-controller="stimeo--portal" data-stimeo--portal-to-value="#dest">
         <div data-stimeo--portal-target="content" id="c">hi</div>
       </div>`,
    );
    await start();
    expect(content().parentElement?.id).toBe("dest");

    // Drop the identifier (a Turbo 8 morph could do this) — the element stays connected,
    // but the controller is torn down, so the teleport must be restored, not orphaned.
    src().setAttribute("data-controller", "");
    await tick();
    expect(content().parentElement?.id).toBe("src"); // restored to its placeholder
    expect(content().hasAttribute("data-portaled")).toBe(false);
  });

  it("restores a no-content teleport to its original spot when the identifier is removed", async () => {
    setup(
      `<div id="dest"></div>
       <div id="wrap"><span id="before"></span><div id="src" data-controller="stimeo--portal"
            data-stimeo--portal-to-value="#dest">x</div><span id="after"></span></div>`,
    );
    await start();
    const source = src();
    expect(source.parentElement?.id).toBe("dest");
    const details: unknown[] = [];
    source.addEventListener("stimeo--portal:unmount", (event) => {
      details.push((event as CustomEvent).detail);
    });

    source.removeAttribute("data-controller"); // a definite detach for the no-content form
    await tick();
    expect(source.parentElement?.id).toBe("wrap");
    // Back at the recorded spot, not merely back in the wrapper.
    expect(source.previousElementSibling?.id).toBe("before");
    expect(source.nextElementSibling?.id).toBe("after");
    expect(source.hasAttribute("data-portaled")).toBe(false);
    expect(hasComment(query("#wrap"))).toBe(false);
    expect(details).toEqual([{}]);
  });

  it("keeps the teleport when the source element moves within the page", async () => {
    setup(
      `<div id="dest"></div>
       <div id="elsewhere"></div>
       <div id="src" data-controller="stimeo--portal" data-stimeo--portal-to-value="#dest">
         <div data-stimeo--portal-target="content" id="c">hi</div>
       </div>`,
    );
    await start();
    const source = src();
    const node = content();
    expect(node.parentElement?.id).toBe("dest");

    // An in-page move disconnects and reconnects the SAME instance in one mutation
    // batch: the reconnect cancels the teardown probe and the teleport survives.
    query("#elsewhere").appendChild(source);
    await tick();
    expect(node.parentElement?.id).toBe("dest"); // still teleported
    expect(hasComment(source)).toBe(true); // placeholder still marks the original spot

    source.remove(); // and a later real detach still restores
    await tick();
    expect(node.parentElement).toBe(source);
    expect(node.hasAttribute("data-portaled")).toBe(false);
  });

  it("restores the content when the source leaves a scoped application's observed root", async () => {
    // A scoped Application.start(root) stops observing an element that moves out of
    // `root`: `data-controller` stays but no reconnect ever comes, so the synchronous
    // token check cannot see this detach. The DetachGate probe must fire and restore,
    // or the content is stranded at the destination with a dead owner.
    setup(
      `<div id="scope">
         <div id="dest"></div>
         <div id="src" data-controller="stimeo--portal" data-stimeo--portal-to-value="#dest">
           <div data-stimeo--portal-target="content" id="c">hi</div>
         </div>
       </div>
       <div id="outside"></div>`,
    );
    application = Application.start(query("#scope"));
    application.register("stimeo--portal", PortalController);
    await tick();
    const source = src();
    const node = content();
    expect(node.parentElement?.id).toBe("dest");
    const unmounts: number[] = [];
    source.addEventListener("stimeo--portal:unmount", () => unmounts.push(1));

    query("#outside").appendChild(source); // exits the observed root: no reconnect
    await tick();
    expect(node.parentElement).toBe(source); // restored, not stranded in #dest
    expect(node.hasAttribute("data-portaled")).toBe(false);
    expect(query("#dest").children.length).toBe(0);
    expect(unmounts).toEqual([1]);
  });

  it("keeps a no-content teleport that exits a scoped application's observed root", async () => {
    // The no-`content` form teleports the controller element ITSELF, so a destination
    // outside the scoped root makes the teleport exit observation as its normal job.
    // Restoring on that ambiguous disconnect would re-enter the root, reconnect,
    // re-teleport, and disconnect again — forever — so the teleport is deliberately
    // kept (fire-and-forget; see the controller's disconnect()).
    setup(
      `<div id="dest"></div>
       <div id="scope">
         <div id="wrap">
           <div id="src" data-controller="stimeo--portal" data-stimeo--portal-to-value="#dest">x</div>
         </div>
       </div>`,
    );
    application = Application.start(query("#scope"));
    application.register("stimeo--portal", PortalController);
    await tick();
    expect(src().parentElement?.id).toBe("dest"); // teleport done

    await tick(); // any (wrongly) armed probe has long settled: the teleport must hold
    expect(src().parentElement?.id).toBe("dest");
    expect(src().getAttribute("data-portaled")).toBe("true");
    expect(hasComment(query("#wrap"))).toBe(true); // bookkeeping persists by design
  });

  it("keeps the teleport when a new instance takes the element over", async () => {
    setup(
      `<div id="dest"></div>
       <div id="src" data-controller="stimeo--portal" data-stimeo--portal-to-value="#dest">
         <div data-stimeo--portal-target="content" id="c">hi</div>
       </div>`,
    );
    await start();
    const source = src();
    const node = content();
    expect(node.parentElement?.id).toBe("dest");
    const unmounts: number[] = [];
    source.addEventListener("stimeo--portal:unmount", () => unmounts.push(1));

    // Registering again swaps the instance on the same element: the outgoing one leaves
    // a probe armed, and it must not rewind the teleport the incoming one now owns.
    application.register("stimeo--portal", PortalController);
    await tick();
    expect(node.parentElement?.id).toBe("dest");
    expect(unmounts).toEqual([]);

    source.remove(); // the instance that took over still finishes the teardown
    await tick();
    expect(node.parentElement).toBe(source);
    expect(unmounts).toEqual([1]);
  });

  it("removes the node instead of restoring when restore is false", async () => {
    setup(
      `<div id="dest"></div>
       <div id="src" data-controller="stimeo--portal" data-stimeo--portal-to-value="#dest"
            data-stimeo--portal-restore-value="false">
         <div data-stimeo--portal-target="content" id="c">hi</div>
       </div>`,
    );
    await start();
    const node = content();
    const source = src();
    const details: unknown[] = [];
    source.addEventListener("stimeo--portal:unmount", (event) => {
      details.push((event as CustomEvent).detail);
    });

    source.remove();
    await tick();
    expect(node.isConnected).toBe(false);
    expect(query("#dest").children.length).toBe(0);
    expect(details).toEqual([{}]); // the removal half of unmount, not just the restore half
  });

  it("does nothing when the destination does not exist", async () => {
    setup(
      `<div id="src" data-controller="stimeo--portal" data-stimeo--portal-to-value="#missing">
         <div data-stimeo--portal-target="content" id="c">hi</div>
       </div>`,
    );
    await start();
    expect(content().parentElement?.id).toBe("src"); // unmoved
    expect(content().hasAttribute("data-portaled")).toBe(false);
  });

  it("falls back to the default destination when the selector cannot be parsed", async () => {
    setup(
      `<div id="src" data-controller="stimeo--portal" data-stimeo--portal-to-value=")(bad">
         <div data-stimeo--portal-target="content" id="c">hi</div>
       </div>`,
    );
    await start();
    expect(content().parentElement).toBe(document.body);
    expect(content().getAttribute("data-portaled")).toBe("true");
  });

  it("falls back to the default destination when the selector is empty", async () => {
    setup(
      `<div id="src" data-controller="stimeo--portal" data-stimeo--portal-to-value="">
         <div data-stimeo--portal-target="content" id="c">hi</div>
       </div>`,
    );
    await start();
    expect(content().parentElement).toBe(document.body);
  });

  it("has no a11y violations", async () => {
    setup(
      `<div id="dest"></div>
       <div id="src" data-controller="stimeo--portal" data-stimeo--portal-to-value="#dest">
         <div data-stimeo--portal-target="content" id="c"><button>ok</button></div>
       </div>`,
    );
    await start();
    await expectNoA11yViolations(document.body);
  });

  /**
   * `to` and `position` describe where the node lives while the controller is connected.
   * Stimulus delivers Value callbacks through a `MutationObserver` happy-dom may drop, so
   * each case writes the attribute and then runs the callback itself; a pass Stimulus
   * adds on top finds the node already in place and moves nothing.
   */
  describe("following the destination declaration", () => {
    const controller = () =>
      application.getControllerForElementAndIdentifier(src(), "stimeo--portal") as PortalController;
    const placeholders = (el: Element) =>
      Array.from(el.childNodes).filter((n) => n.nodeType === Node.COMMENT_NODE);
    /** Records every mount destination (by id) and every unmount, in order. */
    const record = (target: EventTarget) => {
      const log: string[] = [];
      target.addEventListener("stimeo--portal:mount", (event) => {
        const destination = (event as CustomEvent<{ destination: Element }>).detail.destination;
        log.push(`mount:${destination.id || destination.tagName.toLowerCase()}`);
      });
      target.addEventListener("stimeo--portal:unmount", (event) => {
        log.push(`unmount:${JSON.stringify((event as CustomEvent).detail)}`);
      });
      return log;
    };
    const declareTo = async (value: string) => {
      src().setAttribute("data-stimeo--portal-to-value", value);
      controller().toValueChanged();
      await flushMicrotasks();
    };
    const declarePosition = async (value: string) => {
      src().setAttribute("data-stimeo--portal-position-value", value);
      controller().positionValueChanged();
      await flushMicrotasks();
    };
    const twoDestinations = (extra = "") =>
      `<div id="dest1"></div>
       <div id="dest2"><span id="resident"></span></div>
       <div id="src" data-controller="stimeo--portal" data-stimeo--portal-to-value="#dest1" ${extra}>
         <span id="before"></span><div data-stimeo--portal-target="content" id="c">hi</div><span id="after"></span>
       </div>`;

    it("moves the content into a new destination and keeps the original placeholder", async () => {
      setup(twoDestinations());
      const log = record(src());
      await start();
      const [placeholder] = placeholders(src());

      await declareTo("#dest2");
      expect(content().parentElement?.id).toBe("dest2");
      expect(content().getAttribute("data-portaled")).toBe("true");
      // The spot recorded by the first move is still the one that marks home.
      expect(placeholders(src())).toEqual([placeholder]);
      expect(log).toEqual(["mount:dest1", "mount:dest2"]);

      const instance = controller();
      const source = src();
      const node = content();
      source.remove();
      instance.disconnect();
      await tick();
      expect(node.previousElementSibling?.id).toBe("before");
      expect(node.nextElementSibling?.id).toBe("after");
      expect(node.hasAttribute("data-portaled")).toBe(false);
      expect(log).toEqual(["mount:dest1", "mount:dest2", "unmount:{}"]);
    });

    it("moves the content to the other end of its destination when position changes", async () => {
      setup(
        twoDestinations().replace(
          'data-stimeo--portal-to-value="#dest1"',
          'data-stimeo--portal-to-value="#dest2"',
        ),
      );
      const log = record(src());
      await start();
      expect(query("#dest2").lastElementChild?.id).toBe("c");

      await declarePosition("prepend");
      expect(query("#dest2").firstElementChild?.id).toBe("c");
      expect(query("#resident").previousElementSibling?.id).toBe("c");
      expect(log).toEqual(["mount:dest2", "mount:dest2"]);
    });

    it("applies a destination and a position declared together as one move", async () => {
      setup(twoDestinations());
      const log = record(src());
      await start();

      // Position first: a pass run per callback would place the content at the front of
      // the old destination before the new one is known.
      src().setAttribute("data-stimeo--portal-position-value", "prepend");
      src().setAttribute("data-stimeo--portal-to-value", "#dest2");
      controller().positionValueChanged();
      controller().toValueChanged();
      await flushMicrotasks();

      expect(query("#dest2").firstElementChild?.id).toBe("c");
      expect(log).toEqual(["mount:dest1", "mount:dest2"]);
    });

    it("puts the content back home when the new destination matches nothing, even with restore off", async () => {
      setup(twoDestinations('data-stimeo--portal-restore-value="false"'));
      const log = record(src());
      await start();

      await declareTo("#missing");
      expect(content().parentElement?.id).toBe("src");
      expect(content().previousElementSibling?.id).toBe("before");
      expect(content().nextElementSibling?.id).toBe("after");
      expect(content().hasAttribute("data-portaled")).toBe(false);
      expect(placeholders(src())).toEqual([]);
      expect(log).toEqual(["mount:dest1", "unmount:{}"]);

      // A destination that matches again teleports it afresh.
      await declareTo("#dest2");
      expect(content().parentElement?.id).toBe("dest2");
      expect(placeholders(src())).toHaveLength(1);
      expect(log).toEqual(["mount:dest1", "unmount:{}", "mount:dest2"]);
    });

    it("never moves the content into itself: a destination inside it sends it home", async () => {
      setup(
        `<div id="dest1"></div>
         <div id="src" data-controller="stimeo--portal" data-stimeo--portal-to-value="#dest1">
           <div data-stimeo--portal-target="content" id="c"><div id="inner"></div></div>
         </div>`,
      );
      const log = record(src());
      await start();

      await declareTo("#inner");
      expect(content().parentElement?.id).toBe("src");
      expect(query("#inner").parentElement?.id).toBe("c");
      expect(log).toEqual(["mount:dest1", "unmount:{}"]);

      await declareTo("#c");
      expect(content().parentElement?.id).toBe("src");
      expect(log).toEqual(["mount:dest1", "unmount:{}"]);
    });

    it("teleports once a declaration starts to match", async () => {
      setup(
        twoDestinations().replace(
          'data-stimeo--portal-to-value="#dest1"',
          'data-stimeo--portal-to-value="#missing"',
        ),
      );
      const log = record(src());
      await start();
      expect(content().parentElement?.id).toBe("src");

      await declareTo("#dest1");
      expect(content().parentElement?.id).toBe("dest1");
      expect(content().getAttribute("data-portaled")).toBe("true");
      expect(log).toEqual(["mount:dest1"]);
    });

    it("moves nothing when the same declaration is delivered again", async () => {
      setup(twoDestinations());
      const log = record(src());
      await start();
      query("#dest1").append(document.createElement("hr")); // the content now sits first

      controller().toValueChanged();
      controller().positionValueChanged();
      await flushMicrotasks();
      expect(query("#dest1").firstElementChild?.id).toBe("c");
      expect(log).toEqual(["mount:dest1"]);
    });

    it("applies a declaration that changed while the source was disconnected", async () => {
      setup(twoDestinations());
      const log = record(src());
      await start();
      const instance = controller();

      // An in-page move in one batch: the Value callback Stimulus delivers between the
      // two halves asks for a pass while the window is closed, so connect() applies it.
      instance.disconnect();
      src().setAttribute("data-stimeo--portal-to-value", "#dest2");
      instance.toValueChanged();
      instance.connect();
      await tick();

      expect(content().parentElement?.id).toBe("dest2");
      expect(placeholders(src())).toHaveLength(1);
      expect(log).toEqual(["mount:dest1", "mount:dest2"]);
    });

    it("moves nothing for a Value callback that arrives after a real detach", async () => {
      setup(twoDestinations());
      const log = record(src());
      await start();
      const instance = controller();
      const source = src();
      const node = content();
      source.remove();
      instance.disconnect();
      await tick();
      expect(node.parentElement).toBe(source);

      source.setAttribute("data-stimeo--portal-to-value", "#dest2");
      instance.toValueChanged();
      await flushMicrotasks();
      expect(node.parentElement).toBe(source);
      expect(query("#dest2").children).toHaveLength(1);
      expect(log).toEqual(["mount:dest1", "unmount:{}"]);
    });

    it("keeps one mount across an in-page move of the source", async () => {
      setup(`${twoDestinations()}<div id="elsewhere"></div>`);
      const log = record(src());
      await start();

      query("#elsewhere").appendChild(src());
      await tick();
      expect(content().parentElement?.id).toBe("dest1");
      expect(log).toEqual(["mount:dest1"]);
    });

    it("moves a no-content teleport to a new destination and keeps it across the churn", async () => {
      setup(
        `<div id="dest1"></div>
         <div id="dest2"></div>
         <div id="wrap"><span id="before"></span><div id="src" data-controller="stimeo--portal"
              data-stimeo--portal-to-value="#dest1">x</div><span id="after"></span></div>`,
      );
      const log = record(src());
      await start();
      const instance = controller();
      const source = src();
      const [placeholder] = placeholders(query("#wrap"));

      await declareTo("#dest2");
      expect(source.parentElement?.id).toBe("dest2");
      // The element moved itself: Stimulus disconnects and reconnects the same instance.
      await tick();
      expect(source.parentElement?.id).toBe("dest2");
      expect(controller()).toBe(instance);
      expect(placeholders(query("#wrap"))).toEqual([placeholder]);
      expect(log).toEqual(["mount:dest1", "mount:dest2"]);

      source.removeAttribute("data-controller");
      await tick();
      expect(source.previousElementSibling?.id).toBe("before");
      expect(source.nextElementSibling?.id).toBe("after");
      expect(log).toEqual(["mount:dest1", "mount:dest2", "unmount:{}"]);
    });

    it("moves with moveBefore where the engine offers it, so focus inside survives", async () => {
      setup(twoDestinations());
      await start();
      const moves: Array<[Node, Node | null]> = [];
      for (const id of ["dest2", "src"]) {
        const parent = query(`#${id}`);
        Object.defineProperty(parent, "moveBefore", {
          configurable: true,
          value(node: Node, before: Node | null) {
            moves.push([node, before]);
            parent.insertBefore(node, before);
          },
        });
      }

      await declarePosition("prepend");
      await declareTo("#dest2");
      expect(moves).toEqual([[content(), query("#resident")]]);

      const [home] = placeholders(src());
      await declareTo("#missing");
      expect(moves).toEqual([
        [content(), query("#resident")],
        [content(), home],
      ]);
      expect(content().nextElementSibling?.id).toBe("after");
    });

    it("puts data-portaled back after a morph of a no-content teleport, without moving it", async () => {
      setup(
        `<div id="dest1"></div>
         <div id="wrap"><div id="src" data-controller="stimeo--portal"
              data-stimeo--portal-to-value="#dest1">x</div></div>`,
      );
      const log = record(src());
      await start();
      src().removeAttribute("data-portaled"); // the server's markup does not carry the hook

      src().dispatchEvent(new Event("turbo:morph-element", { bubbles: true }));
      await flushMicrotasks();
      expect(src().getAttribute("data-portaled")).toBe("true");
      expect(src().parentElement?.id).toBe("dest1");
      expect(log).toEqual(["mount:dest1"]);
    });

    it("re-resolves the destination on a morph: a replaced element with the same selector gets the node", async () => {
      setup(twoDestinations());
      const log = record(src());
      await start();
      const node = content();
      const fresh = document.createElement("div");
      fresh.id = "dest1";
      query("#dest1").replaceWith(fresh); // the old destination leaves with the node inside

      src().dispatchEvent(new Event("turbo:morph-element", { bubbles: true }));
      await flushMicrotasks();
      expect(node.parentElement).toBe(fresh);
      expect(placeholders(src())).toHaveLength(1);
      expect(log).toEqual(["mount:dest1", "mount:dest1"]);
    });

    it("leaves content the page removed out of the document, ending the teleport at the next change", async () => {
      setup(twoDestinations());
      const log = record(src());
      await start();
      const node = content();
      node.remove(); // the page takes the teleported content away

      await declareTo("#dest2");
      expect(node.isConnected).toBe(false);
      expect(node.hasAttribute("data-portaled")).toBe(false);
      expect(query("#dest2").children).toHaveLength(1); // the resident alone
      expect(placeholders(src())).toEqual([]);
      expect(log).toEqual(["mount:dest1", "unmount:{}"]);

      // Another pass finds no content, and the element does not take itself for the node.
      await declareTo("#missing");
      await declareTo("#dest1");
      expect(node.isConnected).toBe(false);
      expect(src().parentElement).toBe(document.body);
      expect(log).toEqual(["mount:dest1", "unmount:{}"]);
    });

    it("sends home nothing the page removed when the declaration stops matching", async () => {
      setup(twoDestinations());
      const log = record(src());
      await start();
      const node = content();
      node.remove();

      await declareTo("#missing");
      expect(node.isConnected).toBe(false);
      expect(src().querySelector("#c")).toBeNull();
      expect(placeholders(src())).toEqual([]);
      expect(log).toEqual(["mount:dest1", "unmount:{}"]);
    });

    it("moves content the page moved elsewhere in the document", async () => {
      setup(`${twoDestinations()}<div id="elsewhere"></div>`);
      const log = record(src());
      await start();
      const [placeholder] = placeholders(src());
      query("#elsewhere").append(content()); // still in the document

      await declareTo("#dest2");
      expect(content().parentElement?.id).toBe("dest2");
      expect(placeholders(src())).toEqual([placeholder]);
      expect(log).toEqual(["mount:dest1", "mount:dest2"]);
    });

    it("teleports content that arrives after the page removed the earlier one", async () => {
      setup(twoDestinations());
      const log = record(src());
      await start();
      content().remove();
      await declareTo("#dest2");

      const fresh = document.createElement("div");
      fresh.id = "fresh";
      fresh.setAttribute("data-stimeo--portal-target", "content");
      src().append(fresh);
      await declareTo("#dest1");
      expect(fresh.parentElement?.id).toBe("dest1");
      expect(fresh.getAttribute("data-portaled")).toBe("true");
      expect(placeholders(src())).toHaveLength(1);
      expect(log).toEqual(["mount:dest1", "unmount:{}", "mount:dest1"]);
    });

    it("keeps an element whose content the page removed before any teleport from teleporting itself", async () => {
      setup(
        twoDestinations().replace(
          'data-stimeo--portal-to-value="#dest1"',
          'data-stimeo--portal-to-value="#missing"',
        ),
      );
      const log = record(src());
      await start();
      content().remove();

      await declareTo("#dest1");
      expect(src().parentElement).toBe(document.body);
      expect(query("#dest1").children).toHaveLength(0);
      expect(log).toEqual([]);
    });

    /** A content target the page adds at runtime, as a Stream append or a morph brings it. */
    const freshContent = (): HTMLElement => {
      const element = document.createElement("div");
      element.id = "fresh";
      element.setAttribute("data-stimeo--portal-target", "content");
      return element;
    };
    /**
     * Delivers `contentTargetConnected` the way Stimulus would when the controller
     * declares it, since happy-dom does not reliably run target callbacks.
     */
    const deliverContent = (element: HTMLElement, instance = controller()) => {
      const run: unknown = Reflect.get(instance, "contentTargetConnected");
      if (typeof run === "function") run.call(instance, element);
    };

    it("teleports a content target that arrives while connected, with no declaration change", async () => {
      setup(twoDestinations());
      const log = record(src());
      await start();
      content().remove();
      await declareTo("#dest2"); // ends the teleport of the removed content

      const fresh = freshContent();
      src().append(fresh);
      deliverContent(fresh);
      await flushMicrotasks();
      expect(fresh.parentElement?.id).toBe("dest2");
      expect(fresh.getAttribute("data-portaled")).toBe("true");
      expect(placeholders(src())).toHaveLength(1);
      expect(log).toEqual(["mount:dest1", "unmount:{}", "mount:dest2"]);
    });

    it("keeps the content that stays teleported after an earlier one leaves", async () => {
      setup(twoDestinations());
      const log = record(src());
      await start();
      const original = content();
      const [placeholder] = placeholders(src());
      const successor = original.cloneNode(true) as HTMLElement;
      successor.id = "successor";
      placeholder?.after(successor);
      deliverContent(successor);
      await tick();
      // The arriving target replaced the teleported node, which went back home.
      expect(successor.parentElement?.id).toBe("dest1");
      expect(original.parentElement?.id).toBe("src");
      original.remove();
      await tick();

      expect(successor.parentElement?.id).toBe("dest1");
      expect(successor.getAttribute("data-portaled")).toBe("true");
      expect(placeholders(src())).toHaveLength(1);
      expect(log).toEqual(["mount:dest1", "unmount:{}", "mount:dest1"]);

      // The declaration still moves the node that stays.
      await declareTo("#dest2");
      expect(successor.parentElement?.id).toBe("dest2");
      expect(log).toEqual(["mount:dest1", "unmount:{}", "mount:dest1", "mount:dest2"]);
    });

    it("ends the removed teleport and places the content arriving with it in one batch", async () => {
      setup(twoDestinations());
      const log = record(src());
      await start();
      // A morph drops the teleported node and renders fresh content in the source.
      content().remove();
      const fresh = freshContent();
      src().append(fresh);
      deliverContent(fresh);
      src().dispatchEvent(new Event("turbo:morph-element", { bubbles: true }));
      await flushMicrotasks(); // one pass ends the old teleport and places the fresh content

      expect(fresh.parentElement?.id).toBe("dest1");
      expect(placeholders(src())).toHaveLength(1);
      expect(log).toEqual(["mount:dest1", "unmount:{}", "mount:dest1"]);
    });

    it("teleports again content the page removed and then put back into the source", async () => {
      setup(twoDestinations());
      const log = record(src());
      await start();
      const node = content();
      node.remove();
      src().dispatchEvent(new Event("turbo:morph-element", { bubbles: true }));
      await flushMicrotasks(); // the pass ends the teleport of the removed node
      expect(log).toEqual(["mount:dest1", "unmount:{}"]);

      src().append(node); // the page puts the same node back
      deliverContent(node);
      await flushMicrotasks();
      expect(node.parentElement?.id).toBe("dest1");
      expect(node.getAttribute("data-portaled")).toBe("true");
      expect(log).toEqual(["mount:dest1", "unmount:{}", "mount:dest1"]);
    });

    it("counts as arriving a node the element held when an earlier teleport began", async () => {
      setup(twoDestinations());
      const log = record(src());
      await start();
      const node = content();
      node.remove();
      const fresh = freshContent();
      src().append(fresh);
      deliverContent(fresh);
      await flushMicrotasks();
      expect(fresh.parentElement?.id).toBe("dest1");

      src().append(node); // the page puts the earlier node back while fresh is teleported
      deliverContent(node);
      await flushMicrotasks();
      expect(node.parentElement?.id).toBe("dest1");
      expect(fresh.parentElement?.id).toBe("src");
      expect(log).toEqual([
        "mount:dest1",
        "unmount:{}",
        "mount:dest1",
        "unmount:{}",
        "mount:dest1",
      ]);
    });

    it("places nothing after an unmount listener unloads the controller that ended the teleport", async () => {
      setup(twoDestinations());
      const log = record(src());
      await start();
      src().addEventListener("stimeo--portal:unmount", () => application.unload("stimeo--portal"), {
        once: true,
      });
      content().remove();
      const fresh = freshContent();
      src().append(fresh);
      deliverContent(fresh);
      await flushMicrotasks();
      await flushMicrotasks();

      expect(fresh.parentElement?.id).toBe("src");
      expect(fresh.hasAttribute("data-portaled")).toBe(false);
      expect(placeholders(src())).toEqual([]);
      expect(log).toEqual(["mount:dest1", "unmount:{}"]);
    });

    it("leaves content an unmount listener takes away where the listener put it", async () => {
      setup(twoDestinations('data-stimeo--portal-restore-value="false"'));
      const log = record(src());
      await start();
      const fresh = freshContent();
      src().addEventListener("stimeo--portal:unmount", () => fresh.remove(), { once: true });
      src().append(fresh);
      deliverContent(fresh);
      await flushMicrotasks();

      expect(fresh.isConnected).toBe(false);
      expect(fresh.hasAttribute("data-portaled")).toBe(false);
      expect(query("#dest1").children).toHaveLength(0);
      expect(placeholders(src())).toEqual([]);
      expect(log).toEqual(["mount:dest1", "unmount:{}"]);
    });

    it("places content that arrived while the source was disconnected when it reconnects", async () => {
      setup(twoDestinations());
      const log = record(src());
      await start();
      const instance = controller();

      instance.disconnect(); // an in-page move of the source, in one batch
      content().remove();
      const fresh = freshContent();
      src().append(fresh);
      deliverContent(fresh, instance); // before connect(): Stimulus scans targets first
      instance.connect();
      await flushMicrotasks();

      expect(fresh.parentElement?.id).toBe("dest1");
      expect(placeholders(src())).toHaveLength(1);
      expect(log).toEqual(["mount:dest1", "unmount:{}", "mount:dest1"]);
    });

    it("leaves the window closed when an unmount listener disconnects the controller during connect()", async () => {
      setup(twoDestinations());
      const log = record(src());
      await start();
      const instance = controller();

      instance.disconnect(); // an in-page move of the source, first half
      content().remove(); // the page takes the teleported node away meanwhile
      src().addEventListener("stimeo--portal:unmount", () => instance.disconnect(), { once: true });
      instance.connect(); // the placement ends the removed teleport; the listener tears down

      // Torn down, the controller moves nothing for arriving content or a morph.
      const fresh = freshContent();
      src().append(fresh);
      deliverContent(fresh, instance);
      src().dispatchEvent(new Event("turbo:morph-element", { bubbles: true }));
      await flushMicrotasks();
      expect(fresh.parentElement?.id).toBe("src");
      expect(fresh.hasAttribute("data-portaled")).toBe(false);
      expect(log).toEqual(["mount:dest1", "unmount:{}"]);
    });

    it("moves nothing for a pass when the element holds more content targets than the one it teleported", async () => {
      setup(
        `<div id="dest1"></div>
         <div id="src" data-controller="stimeo--portal" data-stimeo--portal-to-value="#dest1">
           <div data-stimeo--portal-target="content" id="a">A</div>
           <div data-stimeo--portal-target="content" id="b">B</div>
         </div>`,
      );
      const log = record(src());
      await start();
      expect(query("#a").parentElement?.id).toBe("dest1");

      src().dispatchEvent(new Event("turbo:morph-element", { bubbles: true })); // nothing changed
      deliverContent(query("#b"));
      await flushMicrotasks();
      expect(query("#a").parentElement?.id).toBe("dest1");
      expect(query("#b").parentElement?.id).toBe("src");
      expect(log).toEqual(["mount:dest1"]);

      // Content that arrives afterwards still replaces the teleported node.
      const fresh = freshContent();
      src().append(fresh);
      deliverContent(fresh);
      await flushMicrotasks();
      expect(fresh.parentElement?.id).toBe("dest1");
      expect(query("#a").parentElement?.id).toBe("src");
      expect(query("#b").parentElement?.id).toBe("src");
      expect(log).toEqual(["mount:dest1", "unmount:{}", "mount:dest1"]);
    });

    it("moves nothing again for content target callbacks about a node already placed", async () => {
      setup(twoDestinations());
      const log = record(src());
      await start();
      query("#dest1").append(document.createElement("hr")); // the content now sits first

      deliverContent(content());
      deliverContent(content());
      await flushMicrotasks();
      expect(query("#dest1").firstElementChild?.id).toBe("c");
      expect(log).toEqual(["mount:dest1"]);

      // Sent home by a declaration that stops matching, it is back in scope and stays.
      await declareTo("#missing");
      deliverContent(content());
      await flushMicrotasks();
      expect(content().parentElement?.id).toBe("src");
      expect(log).toEqual(["mount:dest1", "unmount:{}"]);
    });

    it("teleports content that replaces the source's children, removing the node it replaces", async () => {
      setup(twoDestinations());
      const log = record(src());
      await start();
      const replaced = content();
      // A Stream update of the source: new children, the placeholder gone with the old ones.
      src().innerHTML = '<div id="fresh" data-stimeo--portal-target="content">new</div>';
      const fresh = query("#fresh");
      deliverContent(fresh);
      await flushMicrotasks();

      expect(fresh.parentElement?.id).toBe("dest1");
      expect(fresh.getAttribute("data-portaled")).toBe("true");
      expect(replaced.isConnected).toBe(false);
      expect(replaced.hasAttribute("data-portaled")).toBe(false);
      expect(query("#dest1").children).toHaveLength(1);
      expect(placeholders(src())).toHaveLength(1);
      expect(log).toEqual(["mount:dest1", "unmount:{}", "mount:dest1"]);

      // Torn down, the fresh content goes back to the spot it arrived at.
      src().setAttribute("data-controller", "");
      await tick();
      expect(fresh.parentElement?.id).toBe("src");
      expect(placeholders(src())).toEqual([]);
    });

    for (const restore of [true, false]) {
      it(`ends a teleport whose placeholder remains as restore says when other content arrives (restore: ${restore})`, async () => {
        setup(twoDestinations(`data-stimeo--portal-restore-value="${restore}"`));
        const log = record(src());
        await start();
        const replaced = content();
        const fresh = freshContent();
        src().append(fresh);
        deliverContent(fresh);
        await flushMicrotasks();

        expect(fresh.parentElement?.id).toBe("dest1");
        if (restore) {
          expect(replaced.previousElementSibling?.id).toBe("before");
          expect(replaced.nextElementSibling?.id).toBe("after");
        } else {
          expect(replaced.isConnected).toBe(false);
        }
        expect(replaced.hasAttribute("data-portaled")).toBe(false);
        expect(placeholders(src())).toHaveLength(1);
        expect(log).toEqual(["mount:dest1", "unmount:{}", "mount:dest1"]);

        // The node sent home reports itself as a target again, and the fresh content stays.
        deliverContent(replaced);
        await flushMicrotasks();
        expect(fresh.parentElement?.id).toBe("dest1");
        expect(log).toEqual(["mount:dest1", "unmount:{}", "mount:dest1"]);
      });
    }

    it("moves a teleported node the page put back in the source to its destination again", async () => {
      setup(twoDestinations());
      const log = record(src());
      await start();
      const node = content();
      const [placeholder] = placeholders(src());
      src().append(node); // back inside the source, still in the document

      deliverContent(node);
      src().dispatchEvent(new Event("turbo:morph-element", { bubbles: true }));
      await flushMicrotasks();
      expect(node.parentElement?.id).toBe("dest1");
      expect(node.getAttribute("data-portaled")).toBe("true");
      expect(placeholders(src())).toEqual([placeholder]);
      expect(log).toEqual(["mount:dest1", "mount:dest1"]);

      // Its home is still the spot the first move recorded.
      src().setAttribute("data-controller", "");
      await tick();
      expect(node.previousElementSibling?.id).toBe("before");
      expect(node.nextElementSibling?.id).toBe("after");
    });

    it("records a new home for a node the page put back in the source without its placeholder", async () => {
      setup(twoDestinations());
      const log = record(src());
      await start();
      const node = content();
      // A morph brings the node back by its id and drops the placeholder it does not render.
      for (const comment of placeholders(src())) comment.remove();
      query("#before").after(node);

      deliverContent(node);
      await flushMicrotasks();
      expect(node.parentElement?.id).toBe("dest1");
      const [home] = placeholders(src());
      expect(home?.previousSibling).toBe(query("#before"));
      expect(log).toEqual(["mount:dest1", "mount:dest1"]);

      src().setAttribute("data-controller", "");
      await tick();
      expect(node.previousElementSibling?.id).toBe("before");
      expect(placeholders(src())).toEqual([]);
    });

    it("leaves a node the page nested deeper inside its destination where it is", async () => {
      setup(
        `${twoDestinations()}`.replace(
          '<div id="dest1"></div>',
          '<div id="dest1"><div id="wrap"></div></div>',
        ),
      );
      const log = record(src());
      await start();
      query("#wrap").append(content());

      deliverContent(content());
      src().dispatchEvent(new Event("turbo:morph-element", { bubbles: true }));
      await flushMicrotasks();
      expect(content().parentElement?.id).toBe("wrap");
      expect(log).toEqual(["mount:dest1"]);
    });

    it("moves a node the page put elsewhere in the document back into its destination at the next pass", async () => {
      setup(`${twoDestinations()}<div id="elsewhere"></div>`);
      const log = record(src());
      await start();
      const [placeholder] = placeholders(src());
      query("#elsewhere").append(content()); // outside both the source and the destination

      src().dispatchEvent(new Event("turbo:morph-element", { bubbles: true }));
      await flushMicrotasks();
      expect(content().parentElement?.id).toBe("dest1");
      expect(content().getAttribute("data-portaled")).toBe("true");
      expect(placeholders(src())).toEqual([placeholder]);
      expect(log).toEqual(["mount:dest1", "mount:dest1"]);
    });

    it("moves a node put back in a source that its destination, body, contains", async () => {
      setup(
        `<div id="src" data-controller="stimeo--portal" data-stimeo--portal-to-value="body">
           <div data-stimeo--portal-target="content" id="c">hi</div>
         </div>`,
      );
      const log = record(src());
      await start();
      expect(content().parentElement).toBe(document.body);
      src().append(content());

      deliverContent(content());
      await flushMicrotasks();
      expect(content().parentElement).toBe(document.body);
      expect(log).toEqual(["mount:body", "mount:body"]);
    });

    it("leaves a node in a destination inside the source where it is", async () => {
      setup(
        `<div id="src" data-controller="stimeo--portal" data-stimeo--portal-to-value="#slot">
           <div data-stimeo--portal-target="content" id="c">hi</div>
           <div id="slot"></div>
         </div>`,
      );
      const log = record(src());
      await start();
      expect(content().parentElement?.id).toBe("slot");

      deliverContent(content());
      src().dispatchEvent(new Event("turbo:morph-element", { bubbles: true }));
      await flushMicrotasks();
      expect(content().parentElement?.id).toBe("slot");
      expect(log).toEqual(["mount:slot"]);
    });

    it("keeps no new home inside the old destination when the page nested the node there", async () => {
      setup(
        `${twoDestinations()}`.replace(
          '<div id="dest1"></div>',
          '<div id="dest1"><div id="wrap"></div></div>',
        ),
      );
      const log = record(src());
      await start();
      const node = content();
      for (const comment of placeholders(src())) comment.remove(); // its home is gone
      query("#wrap").append(node);

      await declareTo("#dest2");
      expect(node.parentElement?.id).toBe("dest2");
      expect(Array.from(query("#wrap").childNodes)).toEqual([]);
      src().setAttribute("data-controller", "");
      await tick();
      // With no spot recorded, the teardown removes the node rather than send it into #wrap.
      expect(node.isConnected).toBe(false);
      expect(log).toEqual(["mount:dest1", "mount:dest2", "unmount:{}"]);
    });

    it("teleports the replacing node, not the one it replaced, when a declaration matches again", async () => {
      setup(twoDestinations());
      const log = record(src());
      await start();
      const replaced = content();
      const fresh = freshContent();
      src().append(fresh);
      deliverContent(fresh);
      await flushMicrotasks();
      expect(replaced.parentElement?.id).toBe("src"); // restore sent it home

      await declareTo("#missing");
      await declareTo("#dest2");
      expect(fresh.parentElement?.id).toBe("dest2");
      expect(replaced.parentElement?.id).toBe("src");
      expect(log).toEqual([
        "mount:dest1",
        "unmount:{}",
        "mount:dest1",
        "unmount:{}",
        "mount:dest2",
      ]);
    });

    it("teleports no node a replacement retired when the page removes the replacing one", async () => {
      setup(twoDestinations());
      const log = record(src());
      await start();
      const replaced = content();
      const fresh = freshContent();
      src().append(fresh);
      deliverContent(fresh);
      await flushMicrotasks();

      fresh.remove();
      src().dispatchEvent(new Event("turbo:morph-element", { bubbles: true }));
      await flushMicrotasks();
      expect(replaced.parentElement?.id).toBe("src");
      expect(replaced.hasAttribute("data-portaled")).toBe(false);
      expect(query("#dest1").children).toHaveLength(0);
      expect(log).toEqual(["mount:dest1", "unmount:{}", "mount:dest1", "unmount:{}"]);
    });

    it("moves a node put back in the source whole, whatever content targets it carries", async () => {
      setup(
        `<div id="dest1"></div>
         <div id="src" data-controller="stimeo--portal" data-stimeo--portal-to-value="#dest1">
           <div data-stimeo--portal-target="content" id="c"><span id="nested"
                data-stimeo--portal-target="content"></span></div>
         </div>`,
      );
      const log = record(src());
      await start();
      const node = content();
      src().append(node);

      deliverContent(node);
      await flushMicrotasks();
      expect(node.parentElement?.id).toBe("dest1");
      expect(query("#nested").parentElement).toBe(node);
      expect(log).toEqual(["mount:dest1", "mount:dest1"]);
    });

    it("keeps a no-content teleport when a content target appears inside it", async () => {
      setup(
        `<div id="dest1"></div>
         <div id="wrap"><div id="src" data-controller="stimeo--portal"
              data-stimeo--portal-to-value="#dest1">x</div></div>`,
      );
      const log = record(src());
      await start();
      const inner = freshContent();
      src().append(inner);

      deliverContent(inner);
      await flushMicrotasks();
      expect(src().parentElement?.id).toBe("dest1");
      expect(inner.parentElement?.id).toBe("src");
      expect(log).toEqual(["mount:dest1"]);
    });

    it("does not bring back content the page removed when the controller tears down", async () => {
      setup(
        `<div id="dest1"></div>
         <div id="src" data-controller="stimeo--portal" data-stimeo--portal-to-value="#dest1">
           <div data-stimeo--portal-target="content" id="c">gone</div>
         </div>
         <div id="kept" data-controller="stimeo--portal" data-stimeo--portal-to-value="#dest1">
           <div data-stimeo--portal-target="content" id="k">kept</div>
         </div>`,
      );
      const log = record(src());
      const keptLog = record(query("#kept"));
      await start();
      const removed = content();
      removed.remove();

      // Dropping the identifier keeps both sources in place: a definite detach for each.
      src().setAttribute("data-controller", "");
      query("#kept").setAttribute("data-controller", "");
      await tick();

      expect(removed.isConnected).toBe(false);
      expect(src().querySelector("#c")).toBeNull();
      expect(placeholders(src())).toEqual([]);
      expect(log).toEqual(["mount:dest1", "unmount:{}"]);
      // A node the page left in place goes home as before.
      expect(query("#k").parentElement?.id).toBe("kept");
      expect(placeholders(query("#kept"))).toEqual([]);
      expect(keptLog).toEqual(["mount:dest1", "unmount:{}"]);
    });

    it("does not put content the page removed back into a source that leaves the document", async () => {
      setup(twoDestinations());
      const log = record(src());
      await start();
      const source = src();
      const removed = content();
      removed.remove();

      source.remove();
      await tick();
      expect(removed.parentNode).toBeNull();
      expect(source.querySelector("#c")).toBeNull();
      expect(placeholders(source)).toEqual([]);
      expect(log).toEqual(["mount:dest1", "unmount:{}"]);
    });

    it("leaves a no-content teleport the page removed out of the document", async () => {
      setup(
        `<div id="dest1"></div>
         <div id="wrap"><div id="src" data-controller="stimeo--portal"
              data-stimeo--portal-to-value="#dest1">x</div></div>`,
      );
      const log = record(src());
      await start();
      const source = src();
      expect(source.parentElement?.id).toBe("dest1");

      source.remove(); // the page takes the teleported element away
      await tick();
      expect(source.isConnected).toBe(false);
      expect(placeholders(query("#wrap"))).toEqual([]);
      expect(source.hasAttribute("data-portaled")).toBe(false);
      expect(log).toEqual(["mount:dest1", "unmount:{}"]);
    });

    it("falls back to insertion when moveBefore refuses the move", async () => {
      setup(twoDestinations());
      await start();
      const refuse = vi.fn(() => {
        throw new DOMException("Cannot move this node", "HierarchyRequestError");
      });
      Object.defineProperty(query("#dest2"), "moveBefore", { configurable: true, value: refuse });

      await declareTo("#dest2");
      expect(refuse).toHaveBeenCalledTimes(1);
      expect(content().parentElement?.id).toBe("dest2");
    });
  });
});

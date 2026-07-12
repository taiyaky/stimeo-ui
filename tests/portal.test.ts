import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PortalController } from "../src/controllers/portal_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { query } from "./helpers/dom";
import { tick } from "./helpers/timing";

/**
 * Behavioral tests for {@link PortalController}: the teleport on connect with a comment
 * placeholder, append / prepend positioning, custom destinations, restore-on-disconnect
 * (and removal when restore is off), invalid-destination tolerance, the mount / unmount
 * events, and the "in-page move vs real detach" discrimination (DetachGate) — including
 * the scoped-application observed-root cases on both markup forms.
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
    application.stop();
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
      mounts.push((e as CustomEvent).detail.target),
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
    src().remove();
    await tick();
    expect(node.isConnected).toBe(false);
    expect(query("#dest").children.length).toBe(0);
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

  it("tolerates an invalid selector without throwing", async () => {
    setup(
      `<div id="src" data-controller="stimeo--portal" data-stimeo--portal-to-value=")(bad">
         <div data-stimeo--portal-target="content" id="c">hi</div>
       </div>`,
    );
    await expect(start()).resolves.not.toThrow();
    expect(content().parentElement?.id).toBe("src");
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
});

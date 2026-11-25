/** Minimal event shape carrying the platform's per-event composition signal. */
export interface CompositionSignal {
  readonly isComposing?: boolean;
}

/** Minimal `input` shape needed to tell a composition echo from a fresh edit. */
export interface ConfirmedInputSignal {
  readonly target: EventTarget | null;
  readonly isTrusted: boolean;
  readonly inputType?: string;
}

/**
 * The `inputType` values an engine reports on an `input` that belongs to a
 * composition rather than to an edit the user just made.
 */
const COMPOSITION_INPUT_TYPES = new Set([
  "insertCompositionText",
  "insertFromComposition",
  "deleteCompositionText",
  "deleteByComposition",
]);

/** Whether a platform input kind belongs to composition rather than ordinary editing. */
export function isCompositionInputType(inputType: string | undefined): boolean {
  return inputType !== undefined && COMPOSITION_INPUT_TYPES.has(inputType);
}

/** The cancelable notice Turbo dispatches before a morph writes one attribute. */
const BEFORE_MORPH_ATTRIBUTE = "turbo:before-morph-attribute";

/** Hooks that keep component-specific work outside {@link CompositionTracker}. */
export interface CompositionTrackerOptions {
  /** Runs after lifecycle state is set for a `compositionstart` event. */
  readonly onStart?: (event: Event) => void;
  /** Runs after lifecycle state is cleared for a `compositionend` event. */
  readonly onEnd?: (event: Event) => void;
  /**
   * Runs once lifecycle state is cleared for a composition that ended without
   * `compositionend`, with the `element` it ran in. Nothing was confirmed: the
   * element holds what a write left (`inPlace` false), or still holds the text the
   * composition left, which the engine stopped composing (`inPlace` true) — text
   * typed against whatever the page declared while it ran.
   *
   * A hook applies the work the composition held back — and only that — at once,
   * keeping the caret where it was. The event that showed the end is then handled as
   * it would be with no composition: the text the element holds is read by whatever
   * reads it next, as the user's edit if an edit reads it. A consumer whose contract
   * judges what an interrupted conversion leaves may also settle that text here, as
   * `stimeo--otp` returns a residual its `pattern` rejects to the prior character: it reports
   * that as a reconciliation, never as the user's edit, and keeps the selection.
   *
   * When the tracker sees the end in a key, edit or focus event it hears, the hook
   * runs in its capture listener before consumer bubble handlers, whoever dispatched
   * the event. When a question ({@link CompositionTracker.isComposing},
   * {@link CompositionTracker.composingElement}) or a Turbo morph notice shows
   * the end, the hook runs in a microtask after them, never inside
   * its caller or a half-applied morph, unless an event the tracker hears comes
   * first. The `compositionstart` listener does not use capture: it runs the hook
   * after setting the new composition and before `onStart`:
   * {@link CompositionTracker.isComposing} is true again, so work held for
   * the old composition stays held for the new.
   */
  readonly onAbandon?: (element: EventTarget, inPlace: boolean) => void;
}

/** One composition in progress. */
interface Composition {
  /** The observed target the composition was heard on. */
  readonly target: EventTarget;
  /** The element composing: the observed field itself, or a field inside an observed ancestor. */
  readonly element: EventTarget;
  /** The live value or editable text the composition last left in the element. */
  text: unknown;
  /** Editable descendants in tree order; value fields have none. */
  nodes: readonly Node[];
  /**
   * In an element without a value, a live range over the conversion's text — or over the
   * whole text node holding the caret, when the input did not say what it composed or that
   * node does not hold it — which collapses as the engine's own range over that text does;
   * `null` while the caret is in no text node of the element.
   */
  spot: Range | null;
  /** The range the next composition input replaces, as its `beforeinput` reported it. */
  replaced: AbstractRange | null;
}

/** The element's live value, or its editable text when its content lives in child nodes. */
const textOf = (element: EventTarget): unknown => {
  if ("value" in element) return element.value;
  return element instanceof Element ? element.textContent : undefined;
};

/** Captures editable node identities, including text nodes, in tree order. */
const nodesOf = (element: EventTarget): readonly Node[] => {
  const nodes: Node[] = [];
  if ("value" in element || !(element instanceof Element)) return nodes;
  const walker = element.ownerDocument.createTreeWalker(element);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) nodes.push(node);
  return nodes;
};

/**
 * `text` with each no-break space read as a space: an engine may store a space it composes as
 * U+00A0 while the `input` reports U+0020.
 */
const folded = (text: string): string => text.replaceAll("\u00a0", " ");

/**
 * Where `data` starts in `node`, its no-break spaces read as spaces: at the start of the
 * range it replaced, or else where it reaches the caret, or -1 when neither holds it.
 */
const startOf = (
  node: Text,
  data: string,
  replaced: AbstractRange | null,
  caret: number,
): number => {
  const text = folded(node.data);
  const composed = folded(data);
  if (replaced?.startContainer === node && text.startsWith(composed, replaced.startOffset)) {
    return replaced.startOffset;
  }
  const start = text.lastIndexOf(composed, caret);
  return start !== -1 && start + composed.length >= caret ? start : -1;
};

/**
 * The conversion's text in an element without a value, in the non-empty text node holding
 * the caret: the `data` a composition input put in place of the range it `replaced`, or the
 * whole node when the input did not say what it composed or the node does not hold it.
 * `null` when the caret is in no such node of the element.
 */
const spotOf = (
  element: EventTarget,
  replaced: AbstractRange | null,
  data: unknown,
): Range | null => {
  if ("value" in element || !(element instanceof Element)) return null;
  const selection = element.ownerDocument.getSelection();
  const node = selection?.focusNode;
  if (!(node instanceof Text) || node.data === "" || !element.contains(node)) return null;
  const range = element.ownerDocument.createRange();
  const start =
    typeof data === "string" && data !== ""
      ? startOf(node, data, replaced, selection?.focusOffset ?? 0)
      : -1;
  if (start === -1) {
    range.selectNodeContents(node);
  } else {
    range.setStart(node, start);
    range.setEnd(node, start + (data as string).length);
  }
  return range;
};

/** The first range a `beforeinput` reports it replaces, where the engine reports one. */
const replacedBy = (event: InputEvent): AbstractRange | null =>
  typeof event.getTargetRanges === "function" ? (event.getTargetRanges()[0] ?? null) : null;

/**
 * Whether something other than the composition changed what it runs in since its last input.
 * With the caret in a text node, only the conversion's text counts: its range collapsed — the
 * text was rewritten, moved or removed — or left the element. Otherwise the element's text and
 * the identities and order of its descendants count.
 */
const rewritten = ({ element, text, nodes, spot }: Composition): boolean => {
  if (spot !== null) {
    return spot.collapsed || !(element instanceof Node && element.contains(spot.startContainer));
  }
  const current = nodesOf(element);
  return (
    textOf(element) !== text ||
    current.length !== nodes.length ||
    current.some((node, index) => node !== nodes[index])
  );
};

/** Whether `element` is the focused element of the document or shadow root it is in. */
const holdsFocus = (element: EventTarget): boolean =>
  element instanceof Node &&
  (element.getRootNode() as Partial<DocumentOrShadowRoot>).activeElement === element;

/**
 * Owns IME composition listeners and transient state for one or more event targets.
 *
 * Some browsers omit `KeyboardEvent.isComposing` on the keydown that confirms a
 * conversion. Tracking `compositionstart` through `compositionend` supplies the
 * missing lifecycle signal without relying on deprecated numeric key codes.
 * Component policy stays with the consumer: filtering, validation, and submission
 * belong in the optional {@link CompositionTrackerOptions.onEnd} callback.
 *
 * The tracker also owns the other half of that lifecycle: **the `input` some
 * engines send after `compositionend` to echo the text just confirmed.** A
 * consumer that ran `onEnd` and then handled the echo would commit the same
 * confirmation twice, so {@link CompositionTracker.consumesConfirmedInput} tells
 * the echo apart and the consumer returns early on it.
 *
 * The first `input` a consumer checks after `compositionend` can echo the
 * confirmation if it targets the same field and either reports a composition
 * `inputType` or is trusted and reports no kind. A plain `input` dispatched by
 * the page, or an `input` reporting an ordinary edit kind, is handled as an
 * edit. The check closes the window regardless of its result. A keydown on
 * an observed target, a new composition, unobserving the confirmed field itself,
 * or disconnecting also closes it. Blur alone leaves it open.
 *
 * **A composition can also end without `compositionend`.** Chromium drops the
 * conversion silently when something other than the IME changes its field's value,
 * or replaces, moves or rewrites the text an editable element's conversion runs over —
 * a Turbo morph, a form reset, a script — and when the field moves or leaves the page,
 * leaving the text it composed. The tracker reads the end from what the engine
 * and the field still say:
 *
 * - **The field holds other text than the composition left.** The IME's edits, and
 *   the user's own between them, arrive as an `input` the engine dispatched
 *   (`isTrusted`) or one that reports the composition, and the tracker takes the
 *   field's text from those. A write by anything else changes the text with no such
 *   `input` — at most a synthetic one — so the composition is over, ended with
 *   {@link CompositionTrackerOptions.onAbandon}, before anyone acts on the field.
 *   An element without a value is read by the conversion's own text: a live range over
 *   the text the last composition input put in place of the range its `beforeinput`
 *   reported, in the text node holding the caret — over that whole node when the input
 *   did not say what it composed or the node does not hold it — which the user's own
 *   edits move as they move the engine's. The composition is over once the range collapses, as the engine's own
 *   range does when that text is rewritten, even to the same text, moved or removed, or
 *   once it leaves the element. Other nodes added, removed or moved, edits around that
 *   text in its node, and attribute changes keep the conversion and its history, as they
 *   keep the engine's. With the caret in no text node of the element, its descendant text
 *   and node identities in tree order are compared instead.
 * - **The engine edits outside a composition.** A `beforeinput` reporting
 *   `isComposing: false` with an `inputType` outside {@link COMPOSITION_INPUT_TYPES}
 *   is an edit the engine no longer counts as composition — unless the `keydown`
 *   right before it reported `isComposing: true`: a key the IME lets through, such
 *   as Backspace, edits the field while the conversion goes on. This is what shows
 *   a composition that ended with its text in place. Only one field composes at a
 *   time, so such an edit on any observed target ends the composition held, with
 *   `onAbandon`. A `keydown` can hold this back but never starts it: the keydown
 *   that confirms a conversion may carry no `isComposing`, and dictation and
 *   autofill edit with no key at all.
 * - **The field stays where it was heard.** A field the consumer observes itself is
 *   the consumer's to release when it moves or leaves, which reads what it holds;
 *   one that keeps focus through the move keeps composing
 *   ({@link CompositionTracker.disconnect}). A field inside an observed ancestor
 *   that leaves the ancestor, or loses focus within its document, ends its
 *   composition quietly; one that stays the document's active element — the window
 *   lost focus — keeps composing.
 * - **No other field composes**: a `compositionstart` ends any composition the
 *   tracker still holds, with `onAbandon`, before the new one starts.
 *
 * The tracker checks this before it answers {@link CompositionTracker.isComposing}
 * or {@link CompositionTracker.composingElement}, and at every key, edit, blur,
 * `compositionstart` and morph it hears — keys, edits and blurs in the capture
 * phase, ahead of the consumer's own handlers. While
 * a composition is live, a Turbo morph leaves its field's value alone: Idiomorph
 * asks through `turbo:before-morph-attribute` before it writes `value`, as an
 * attribute or as the live text, and the tracker cancels that one notice for the
 * element composing, so the morph keeps the conversion, as it keeps focus. The
 * field's other attributes, and other elements, still morph. An element without a
 * value has no single write to cancel — a morph can only be stopped node by node, and
 * the nodes it inserts not at all — so the tracker leaves its morphs alone: keeping
 * what it holds through one is for whoever owns its content. A morph that rewrites the
 * conversion's text ends the conversion, as any other write does.
 *
 * A consumer that observes several fields tells the conversion's own events from
 * edits in the other fields with {@link CompositionTracker.owns}, which holds even
 * while the tracker keeps a composition whose end no event has shown yet.
 *
 * @example
 * ```ts
 * #composition = new CompositionTracker({ onEnd: () => this.filter() });
 *
 * connect(): void {
 *   this.#composition.observe(this.inputTarget);
 * }
 *
 * disconnect(): void {
 *   this.#composition.disconnect();
 * }
 *
 * onInput(event: InputEvent): void {
 *   if (this.#composition.consumesConfirmedInput(event)) return;
 *   if (this.#composition.isComposing(event)) return;
 * }
 *
 * onKeydown(event: KeyboardEvent): void {
 *   if (this.#composition.isComposing(event)) return;
 * }
 * ```
 */
export class CompositionTracker {
  readonly #observedTargets = new Set<EventTarget>();
  /** The composition in progress, if any: only one field composes at a time. */
  #composition: Composition | null = null;
  readonly #onStart: ((event: Event) => void) | undefined;
  readonly #onEnd: ((event: Event) => void) | undefined;
  readonly #onAbandon: ((element: EventTarget, inPlace: boolean) => void) | undefined;
  /** The field whose confirming `input` is still owed, while the window is open. */
  #confirmedTarget: EventTarget | null = null;
  /**
   * Whether the last `keydown` reported a composition, until the `beforeinput`
   * after it: the edit that key announces lands inside the composition.
   */
  #keyComposing = false;
  /** Whether the consumer is connected: from `observe()` until `disconnect()`. */
  #connected = false;
  /** A composition that ended without `compositionend` and whose `onAbandon` has not run yet. */
  #abandoned: { readonly element: EventTarget; readonly inPlace: boolean } | null = null;

  constructor(options: CompositionTrackerOptions = {}) {
    this.#onStart = options.onStart;
    this.#onEnd = options.onEnd;
    this.#onAbandon = options.onAbandon;
  }

  /**
   * Starts lifecycle tracking for `target`; repeated calls are idempotent. The
   * targets one tracker observes do not contain one another: a composition event
   * reaching two of them would be counted as two.
   */
  observe(target: EventTarget): void {
    this.#connected = true;
    if (this.#observedTargets.has(target)) return;
    target.addEventListener("compositionstart", this.#handleStart);
    target.addEventListener("compositionend", this.#handleEnd);
    target.addEventListener("keydown", this.#handleKeydown, true);
    target.addEventListener("beforeinput", this.#handleBeforeInput, true);
    target.addEventListener("input", this.#handleInput, true);
    target.addEventListener("blur", this.#handleBlur, true);
    target.addEventListener(BEFORE_MORPH_ATTRIBUTE, this.#handleBeforeMorphAttribute);
    this.#observedTargets.add(target);
  }

  /**
   * Stops tracking one target. A composition it held ends quietly, unless its element
   * still holds focus — see {@link CompositionTracker.disconnect}.
   */
  unobserve(target: EventTarget): void {
    if (!this.#observedTargets.delete(target)) return;
    this.#release(target);
    if (this.#composition?.target === target) this.#letGo();
    if (this.#confirmedTarget === target) this.#confirmedTarget = null;
  }

  /**
   * Releases every listener and clears state so reconnect starts cleanly.
   *
   * A composition whose element still holds focus is the exception. A move that
   * keeps focus — `moveBefore`, which Turbo's morph uses where the browser provides
   * it — can leave the conversion running, and Stimulus releases the moved target, or
   * the controller around it, and observes it again within the one mutation batch. So
   * the composition waits for its target to be observed again before the turn ends,
   * and goes on; otherwise it ends then — quietly once disconnected, and with
   * {@link CompositionTrackerOptions.onAbandon} for a consumer that only let that one
   * target go. While it waits it is held as it was, and a move that ended the
   * conversion shows at the first check once its target is observed again. A move
   * without `moveBefore`, or a removal, takes focus away.
   */
  disconnect(): void {
    this.#connected = false;
    for (const target of this.#observedTargets) this.#release(target);
    this.#observedTargets.clear();
    this.#letGo();
    this.#confirmedTarget = null;
    this.#keyComposing = false;
    this.#abandoned = null;
  }

  /**
   * True when a composition is live or the current event reports one. A
   * composition that ended without `compositionend` ends here first.
   */
  isComposing(event?: CompositionSignal): boolean {
    this.#settle();
    return event?.isComposing === true || this.#composition !== null;
  }

  /**
   * The element a live composition is running in, or `null`. A composition that
   * ended without `compositionend` ends here first.
   */
  composingElement(): EventTarget | null {
    this.#settle();
    return this.#composition?.element ?? null;
  }

  /**
   * Whether `event` belongs to a composition: it reports one, or it is in the element a
   * live composition runs in. An event in another element — a key there, or a script's
   * write reported with a bare `input` — is an edit outside the composition, even while
   * the tracker holds one whose end it has not seen: only one element composes at a
   * time, and the IME edits nothing else. The composition held stays, since such an
   * event does not show its end. A consumer that observes several fields asks this of
   * each event; {@link CompositionTracker.isComposing} asks of the targets as a whole.
   * A composition that ended without `compositionend` ends here first.
   */
  owns(event: CompositionSignal & { readonly target: EventTarget | null }): boolean {
    const element = this.composingElement();
    return event.isComposing === true || (element !== null && element === event.target);
  }

  /**
   * Whether `event` is the `input` echoing the composition just confirmed.
   *
   * Asking closes the window either way, so one confirmation is folded at most
   * once and a consumer asks once per `input`.
   */
  consumesConfirmedInput(event: ConfirmedInputSignal): boolean {
    const confirmed = this.#confirmedTarget;
    this.#confirmedTarget = null;
    if (confirmed === null || confirmed !== event.target) return false;
    const inputType = event.inputType;
    return inputType ? isCompositionInputType(inputType) : event.isTrusted === true;
  }

  /** Removes every listener {@link CompositionTracker.observe} added to `target`. */
  #release(target: EventTarget): void {
    target.removeEventListener("compositionstart", this.#handleStart);
    target.removeEventListener("compositionend", this.#handleEnd);
    target.removeEventListener("keydown", this.#handleKeydown, true);
    target.removeEventListener("beforeinput", this.#handleBeforeInput, true);
    target.removeEventListener("input", this.#handleInput, true);
    target.removeEventListener("blur", this.#handleBlur, true);
    target.removeEventListener(BEFORE_MORPH_ATTRIBUTE, this.#handleBeforeMorphAttribute);
  }

  /**
   * Lets go of the composition held once its target is no longer observed: it is over
   * unless its element kept focus and its target is observed again this turn.
   */
  #letGo(): void {
    const composition = this.#composition;
    if (composition === null) return;
    if (!holdsFocus(composition.element)) {
      this.#composition = null;
      return;
    }
    queueMicrotask(() => {
      if (this.#composition !== composition || this.#observedTargets.has(composition.target)) {
        return;
      }
      this.#composition = null;
      if (!this.#connected) return;
      this.#abandoned = { element: composition.element, inPlace: true };
      this.#runAbandon();
    });
  }

  /**
   * Ends the composition held if its field left the observed target, taking the
   * composition's text along, or holds a value or editable DOM a write left. One
   * waiting for its target to be observed again is held as it is until then.
   */
  #settle(): void {
    const composition = this.#composition;
    if (composition === null || !this.#observedTargets.has(composition.target)) return;
    const { target, element } = composition;
    if (target instanceof Node && element instanceof Node && !target.contains(element)) {
      this.#composition = null;
    } else if (rewritten(composition)) {
      this.#abandon(false);
    }
  }

  /**
   * Ends the composition held, unconfirmed. Its `onAbandon` runs in a microtask,
   * unless an event the tracker hears runs it first.
   */
  #abandon(inPlace: boolean): void {
    this.#owe(inPlace);
    this.#composition = null;
    queueMicrotask(this.#runAbandon);
  }

  /** Records the `onAbandon` the composition held owes. */
  #owe(inPlace: boolean): void {
    const composition = this.#composition;
    if (composition !== null) this.#abandoned = { element: composition.element, inPlace };
  }

  /** Runs the `onAbandon` an ended composition owes, once. */
  readonly #runAbandon = (): void => {
    const abandoned = this.#abandoned;
    if (abandoned === null) return;
    this.#abandoned = null;
    this.#onAbandon?.(abandoned.element, abandoned.inPlace);
  };

  /** A composition starting while one is held ends the held one, unconfirmed. */
  readonly #handleStart = (event: Event): void => {
    this.#confirmedTarget = null;
    this.#settle();
    this.#owe(true);
    // A listener runs while the event is dispatched, so both targets are set.
    const target = event.currentTarget as EventTarget;
    const element = event.target as EventTarget;
    this.#composition = {
      target,
      element,
      text: textOf(element),
      nodes: nodesOf(element),
      spot: spotOf(element, null, undefined),
      replaced: null,
    };
    this.#runAbandon();
    this.#onStart?.(event);
  };

  readonly #handleEnd = (event: Event): void => {
    this.#runAbandon();
    if (this.#composition?.target === event.currentTarget) this.#composition = null;
    this.#confirmedTarget = event.target;
    this.#onEnd?.(event);
  };

  /**
   * A key on an observed field opens an edit of its own, so no echo is owed; it
   * also says whether the edit it announces lands inside a composition.
   */
  readonly #handleKeydown = (event: Event): void => {
    this.#settle();
    this.#runAbandon();
    this.#confirmedTarget = null;
    this.#keyComposing = (event as KeyboardEvent).isComposing === true;
  };

  /**
   * An edit is about to land: a composition the engine no longer runs ends first. The range
   * the edit reports it replaces is kept for the composition `input` that follows.
   */
  readonly #handleBeforeInput = (event: Event): void => {
    const keyComposing = this.#keyComposing;
    this.#keyComposing = false;
    this.#settle();
    const { isComposing, inputType } = event as InputEvent;
    if (
      this.#composition !== null &&
      !keyComposing &&
      !isComposing &&
      inputType &&
      !isCompositionInputType(inputType)
    ) {
      this.#abandon(true);
    }
    const composition = this.#composition;
    if (composition !== null && event.target === composition.element) {
      composition.replaced = replacedBy(event as InputEvent);
    }
    this.#runAbandon();
  };

  /**
   * Takes the composing field's text and node identities from an `input` the engine
   * dispatched or one that reports the composition, and the conversion's text from a
   * composition input; the user's own edits between keep the range over that text, which
   * moves with them as the engine's does. Any other `input` follows a write the composition
   * did not make.
   */
  readonly #handleInput = (event: Event): void => {
    const composition = this.#composition;
    const { isTrusted, isComposing, inputType } = event as InputEvent;
    if (
      composition !== null &&
      event.target === composition.element &&
      (isTrusted || isComposing || isCompositionInputType(inputType))
    ) {
      composition.text = textOf(composition.element);
      composition.nodes = nodesOf(composition.element);
      if (isCompositionInputType(inputType)) {
        composition.spot = spotOf(
          composition.element,
          composition.replaced,
          (event as InputEvent).data,
        );
      }
      composition.replaced = null;
    } else {
      this.#settle();
    }
    this.#runAbandon();
  };

  /**
   * Checks the composition as a field loses focus, ahead of the consumer's own blur
   * handlers. A field inside an observed ancestor that loses focus within its
   * document keeps its text and composes no more.
   */
  readonly #handleBlur = (event: Event): void => {
    this.#settle();
    this.#runAbandon();
    const composition = this.#composition;
    if (composition === null || composition.target === composition.element) return;
    const { element } = composition;
    if (!(element instanceof Node) || event.target !== element) return;
    const root = element.getRootNode() as Document | ShadowRoot;
    if (root.activeElement !== element) this.#composition = null;
  };

  /** Preserves the composing field's live value when Turbo asks to write it. */
  readonly #handleBeforeMorphAttribute = (event: Event): void => {
    this.#settle();
    const composition = this.#composition;
    if (composition?.target !== event.currentTarget || event.target !== composition.element) return;
    const detail: { readonly attributeName?: unknown } | null = (event as CustomEvent).detail;
    if (detail?.attributeName === "value" && "value" in composition.element) {
      event.preventDefault();
    }
  };
}

import type { Diagnostic } from "./types";

/** The controller a page seats once to receive every spoken message. */
export const ANNOUNCER_IDENTIFIER = "stimeo--announcer";

/**
 * Controllers that reach assistive tech through the shared announcer.
 *
 * A message they need spoken cannot ride a live region of their own: a region
 * only announces what changes *after* assistive tech already knows about it,
 * which a region that appears with its first message cannot satisfy. They hand
 * the message to the announcer instead, so a page without one is silent — the
 * visual state still updates and every other check still passes.
 *
 * Membership is "can speak", not "always speaks": several gate their message on
 * an opt-in Value, and one bridges only the messages present at load. A run that
 * uses them without opting in loses nothing by being reminded once.
 */
export const ANNOUNCING_CONTROLLERS: readonly string[] = [
  "stimeo--auto-submit",
  "stimeo--character-counter",
  "stimeo--countdown",
  "stimeo--direct-upload",
  "stimeo--empty-state",
  "stimeo--flash",
  "stimeo--form-field",
  "stimeo--frame-loading",
  "stimeo--meter",
  "stimeo--multi-select",
  "stimeo--nested-form",
  "stimeo--network-status",
  "stimeo--progress",
  "stimeo--skeleton",
  "stimeo--spinner",
  "stimeo--submit-once",
  "stimeo--tags-input",
];

/** One scanned source and the path to report it under. */
export interface ScannedSource {
  readonly file: string;
  readonly source: string;
}

/** Where a controller identifier was found, as 1-based editor coordinates. */
interface Hit {
  readonly file: string;
  readonly identifier: string;
  readonly line: number;
  readonly column: number;
}

/** Resolves a source offset to the 1-based line and column an editor shows. */
function positionAt(source: string, index: number): { line: number; column: number } {
  const before = source.slice(0, index);
  const line = before.split("\n").length;
  const lastBreak = before.lastIndexOf("\n");
  return { line, column: index - lastBreak };
}

/** First announcing controller mentioned by a source, in document order. */
function firstAnnouncingHit(scanned: ScannedSource): Hit | null {
  let best: Hit | null = null;
  let bestIndex = Number.POSITIVE_INFINITY;
  for (const identifier of ANNOUNCING_CONTROLLERS) {
    const index = scanned.source.indexOf(identifier);
    if (index === -1 || index >= bestIndex) continue;
    bestIndex = index;
    best = { file: scanned.file, identifier, ...positionAt(scanned.source, index) };
  }
  return best;
}

/**
 * Reports a run where something speaks but nothing listens.
 *
 * Seating is a property of the **run**, not of a file: an application usually
 * puts the announcer in a layout, so the page that speaks and the page that
 * listens are different sources. Judging one file at a time would flag every
 * such page, so this runs once over everything that was scanned and stays quiet
 * as soon as any of it seats an announcer. Warning severity for the same
 * reason: a layout outside the scanned paths can still be the seat.
 *
 * The identifier is matched as source text rather than parsed markup, so a
 * seat written through a Ruby hash, a helper, or a partial counts. That errs
 * toward silence, which is the right direction for a hint.
 */
export function announcerSeatingDiagnostic(
  sources: readonly ScannedSource[],
): { file: string; diagnostic: Diagnostic } | null {
  let speaker: Hit | null = null;
  for (const scanned of sources) {
    if (scanned.source.includes(ANNOUNCER_IDENTIFIER)) return null;
    if (!speaker) speaker = firstAnnouncingHit(scanned);
  }
  if (!speaker) return null;

  return {
    file: speaker.file,
    diagnostic: {
      code: "missing-announcer",
      severity: "warning",
      message: `"${speaker.identifier}" speaks through the shared announcer, and none of the scanned files seats one.`,
      line: speaker.line,
      column: speaker.column,
      length: speaker.identifier.length,
      suggestion: `Add an element with data-controller="${ANNOUNCER_IDENTIFIER}" (and an assertive/polite target) to the layout, or include the layout in the checked paths.`,
    },
  };
}

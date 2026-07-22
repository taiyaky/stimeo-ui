import { cableControllers } from "../cable";
import { stimeoControllers } from "../index";
import { positioningControllers } from "../positioning";
import { a11yRules } from "./a11y_rules";
import { compositionRules } from "./composition_rules";
import { keyboardRules } from "./keyboard_rules";
import { managedAriaRules } from "./managed_aria_rules";
import { structureRules } from "./structure_rules";
import type { ControllerManifest, Manifest } from "./types";

/**
 * Current manifest *format* version. Bump on breaking schema changes.
 *
 * v2 adds `actions` and `events` to every controller entry (the public
 * action/event surface, declared via `static actions` / `static events`).
 * v3 adds `a11y` — the stage-3 accessibility requirements the consumer's markup
 * must satisfy.
 * v4 adds `or` alternatives to a11y requirements, plus `keyboard` (authored
 * focusability prerequisites) and `managedAria` (author-futile attributes,
 * reported as warnings) to every controller entry.
 * v5 adds `compositions` — conditional cross-controller value-alignment rules
 * (e.g. sortable's sort axis vs a co-located roving's `orientation`).
 */
export const SCHEMA_VERSION = 5;

/**
 * Minimal structural view of a Stimulus controller class, exposing only the
 * static metadata the Inspector reflects. Reading these requires no
 * instantiation and no DOM.
 */
interface ReflectableController {
  readonly targets?: readonly string[];
  readonly values?: Readonly<Record<string, unknown>>;
  readonly actions?: readonly string[];
  readonly events?: readonly string[];
}

/**
 * Builds the Inspector manifest by reflecting over the official controllers.
 *
 * Reflected data (`targets`, `values`, `actions`, `events`) is read from each
 * class's `static targets` / `static values` / `static actions` /
 * `static events`; structure data (`requiredTargets`) and accessibility data
 * (`a11y`) come from the hand-written {@link structureRules} / {@link a11yRules}.
 * Keeping the sources separate means the reflected names always track the
 * controllers, while required-ness and ARIA contracts stay explicit, reviewable
 * decisions.
 *
 * The core controllers and the opt-in {@link positioningControllers} and
 * {@link cableControllers} are reflected, so `stimeo check` recognizes every
 * controller shipped through those public entrypoints. Reflecting positioning imports
 * `@floating-ui/dom` here, but only at **build time** for manifest generation —
 * `manifest.ts` is not a shipped browser artifact. The core entrypoint
 * (`dist/index.js` / `import "stimeo-ui"`) still never imports it; only the opt-in
 * `stimeo-ui/positioning` subpath ships `@floating-ui/dom`, keeping the core install
 * dependency-free.
 *
 * @param packageVersion - The `stimeo-ui` version to stamp onto the manifest
 *   so consumers can confirm it matches their installed package.
 */
export function buildManifest(packageVersion: string): Manifest {
  const controllers: Record<string, ControllerManifest> = {};

  const allControllers = {
    ...stimeoControllers,
    ...positioningControllers,
    ...cableControllers,
  };
  const allStructureRules = {
    ...structureRules,
  };
  const allA11yRules = {
    ...a11yRules,
  };
  const allManagedAriaRules = {
    ...managedAriaRules,
  };
  for (const [identifier, ctor] of Object.entries(allControllers)) {
    const reflect = ctor as unknown as ReflectableController;
    const rule = allStructureRules[identifier];

    controllers[identifier] = {
      targets: [...(reflect.targets ?? [])],
      values: Object.keys(reflect.values ?? {}),
      actions: [...(reflect.actions ?? [])],
      events: [...(reflect.events ?? [])],
      requiredTargets: [...(rule?.requiredTargets ?? [])],
      a11y: [...(allA11yRules[identifier] ?? [])],
      keyboard: [...(keyboardRules[identifier] ?? [])],
      managedAria: [...(allManagedAriaRules[identifier] ?? [])],
      compositions: [...(compositionRules[identifier] ?? [])],
    };
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    packageVersion,
    controllers,
  };
}

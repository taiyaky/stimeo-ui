import { AvatarController } from "../src/controllers/avatar_controller";
import { CarouselController } from "../src/controllers/carousel_controller";
import { ClipboardController } from "../src/controllers/clipboard_controller";
import { CountdownController } from "../src/controllers/countdown_controller";
import { DrawerController } from "../src/controllers/drawer_controller";
import { EmptyStateController } from "../src/controllers/empty_state_controller";
import { FilterController } from "../src/controllers/filter_controller";
import { FlashController } from "../src/controllers/flash_controller";
import { LocalTimeController } from "../src/controllers/local_time_controller";
import { MeterController } from "../src/controllers/meter_controller";
import { NestedFormController } from "../src/controllers/nested_form_controller";
import { OverflowIndicatorController } from "../src/controllers/overflow_indicator_controller";
import { OverflowMenuController } from "../src/controllers/overflow_menu_controller";
import { PointerDragController } from "../src/controllers/pointer_drag_controller";
import { PreviewGuardController } from "../src/controllers/preview_guard_controller";
import { ProgressController } from "../src/controllers/progress_controller";
import { RelativeTimeController } from "../src/controllers/relative_time_controller";
import { ResizableController } from "../src/controllers/resizable_controller";
import { ScrollAreaController } from "../src/controllers/scroll_area_controller";
import { ScrollVisibilityController } from "../src/controllers/scroll_visibility_controller";
import { ScrollspyController } from "../src/controllers/scrollspy_controller";
import { SeparatorController } from "../src/controllers/separator_controller";
import { SmartStickyHeaderController } from "../src/controllers/smart_sticky_header_controller";
import { StickToBottomController } from "../src/controllers/stick_to_bottom_controller";
import { ToastController } from "../src/controllers/toast_controller";
import { defineMorphRecovery, type MorphFixture } from "./helpers/morph_lifecycle";

const fixtures: MorphFixture[] = [
  {
    id: "avatar",
    controller: AvatarController,
    attrs: "",
    html: '<img data-stimeo--avatar-target="image"><span data-stimeo--avatar-target="fallback">A</span>',
    selector: "",
    output: "data-state",
  },
  {
    id: "carousel",
    controller: CarouselController,
    attrs: "",
    html: '<div id="viewport" data-stimeo--carousel-target="viewport"><div id="out" data-stimeo--carousel-target="slide">A</div><div data-stimeo--carousel-target="slide">B</div></div><button data-stimeo--carousel-target="picker"></button><button data-stimeo--carousel-target="picker"></button>',
    selector: "#viewport",
    output: "aria-live",
  },
  {
    id: "clipboard",
    controller: ClipboardController,
    attrs: 'data-stimeo--clipboard-feedback-duration-value="0"',
    html: '<span id="out" data-stimeo--clipboard-target="feedback">server fallback</span>',
    selector: "#out",
    output: "text",
  },
  {
    id: "countdown",
    controller: CountdownController,
    attrs:
      'data-stimeo--countdown-deadline-value="2099-01-01T00:00:00Z" data-stimeo--countdown-autostart-value="false"',
    html: '<span id="out" data-stimeo--countdown-target="days"></span>',
    selector: "#out",
    output: "text",
  },
  {
    id: "drawer",
    controller: DrawerController,
    attrs: "",
    html: '<div id="out" data-stimeo--drawer-target="panel"></div>',
    selector: "#out",
    output: "data-placement",
  },
  {
    id: "empty-state",
    controller: EmptyStateController,
    attrs: "",
    html: '<ul data-stimeo--empty-state-target="list"></ul><p data-stimeo--empty-state-target="empty"></p>',
    selector: "",
    output: "data-count",
  },
  {
    id: "filter",
    controller: FilterController,
    attrs: "",
    html: '<p data-stimeo--filter-target="item"></p><p id="out" data-stimeo--filter-target="empty"></p>',
    selector: "#out",
    output: "hidden",
  },
  {
    id: "flash",
    controller: FlashController,
    attrs: 'data-stimeo--flash-duration-value="0"',
    html: '<div data-stimeo--flash-target="region"><p id="out" data-flash-type="notice" data-stimeo--flash-target="message">Saved</p></div>',
    selector: "#out",
    output: "data-flash-state",
  },
  {
    id: "local-time",
    controller: LocalTimeController,
    attrs: 'datetime="2026-01-01T00:00:00Z" data-stimeo--local-time-locale-value="en"',
    html: "Fallback",
    selector: "",
    output: "text",
  },
  {
    id: "nested-form",
    controller: NestedFormController,
    attrs: "",
    html: '<template data-stimeo--nested-form-target="template"><div></div></template><div data-stimeo--nested-form-target="list"></div>',
    selector: "",
    output: "data-nested-count",
  },
  {
    id: "overflow-indicator",
    controller: OverflowIndicatorController,
    attrs: "",
    html: '<div id="out" data-stimeo--overflow-indicator-target="viewport"></div>',
    selector: "#out",
    output: "data-overflow-end",
  },
  {
    id: "overflow-menu",
    controller: OverflowMenuController,
    attrs: "",
    html: '<div data-stimeo--overflow-menu-target="items"></div><div id="out" data-stimeo--overflow-menu-target="more"><button></button></div>',
    selector: "#out",
    output: "hidden",
  },
  {
    id: "pointer-drag",
    controller: PointerDragController,
    attrs: "",
    html: '<div id="out" data-stimeo--pointer-drag-target="handle"></div>',
    selector: "#out",
    output: "tabindex",
  },
  {
    id: "preview-guard",
    controller: PreviewGuardController,
    attrs: "",
    html: "Private",
    selector: "",
    output: "data-preview-hidden",
  },
  {
    id: "progress",
    controller: ProgressController,
    attrs: 'data-stimeo--progress-value-value="25"',
    html: "",
    selector: "",
    output: "aria-valuenow",
  },
  {
    id: "meter",
    controller: MeterController,
    attrs: 'data-stimeo--meter-value-value="25"',
    html: "",
    selector: "",
    output: "aria-valuenow",
  },
  {
    id: "relative-time",
    controller: RelativeTimeController,
    attrs: 'datetime="2026-01-01T00:00:00Z" data-stimeo--relative-time-locale-value="en"',
    html: "Fallback",
    selector: "",
    output: "text",
  },
  {
    id: "resizable",
    controller: ResizableController,
    attrs: 'data-stimeo--resizable-value-value="40"',
    html: '<div id="out" data-stimeo--resizable-target="separator"></div>',
    selector: "#out",
    output: "aria-valuenow",
  },
  {
    id: "scroll-area",
    controller: ScrollAreaController,
    attrs: "",
    html: '<div data-stimeo--scroll-area-target="viewport"></div>',
    selector: "",
    output: "data-scroll",
  },
  {
    id: "scroll-visibility",
    controller: ScrollVisibilityController,
    attrs: "",
    html: '<button id="out" data-stimeo--scroll-visibility-target="element"></button>',
    selector: "#out",
    output: "hidden",
  },
  {
    id: "scrollspy",
    controller: ScrollspyController,
    attrs: "",
    html: '<a id="out" href="#section" aria-current="location" data-stimeo--scrollspy-target="link">Section</a>',
    selector: "#out",
    output: "aria-current",
  },
  {
    id: "separator",
    controller: SeparatorController,
    attrs: 'data-stimeo--separator-focusable-value="true" data-stimeo--separator-value-value="40"',
    html: "",
    selector: "",
    output: "aria-valuenow",
  },
  {
    id: "smart-sticky-header",
    controller: SmartStickyHeaderController,
    attrs: "",
    html: "",
    selector: "",
    output: "data-header-hidden",
  },
  {
    id: "stick-to-bottom",
    controller: StickToBottomController,
    attrs: "",
    html: '<div data-stimeo--stick-to-bottom-target="content"></div><button id="out" data-stimeo--stick-to-bottom-target="hasNew"></button>',
    selector: "#out",
    output: "hidden",
  },
  {
    id: "toast",
    controller: ToastController,
    attrs: 'data-stimeo--toast-duration-value="100000"',
    html: '<div data-stimeo--toast-target="list"><p id="out" data-stimeo--toast-target="item" data-state="visible">Saved</p></div>',
    selector: "#out",
    output: "data-paused",
  },
];

defineMorphRecovery(fixtures);

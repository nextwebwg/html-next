/**
 * The `transitions` extension's runtime, imported only by compiled components that use it.
 *
 * Every participating element carries `view-transition-name` (its own identity through
 * `match-element`, or its `$transition-name`) and a `view-transition-class` naming its
 * `$transition` value, as ordinary style bindings. The rules each component registers animate
 * those classes, so the browser plays every animation and this module never touches a
 * pseudo-element. What it adds is the one thing CSS cannot: running an update inside
 * `document.startViewTransition()`.
 *
 * One coordinator per document collects every compiled instance whose pending update reads what
 * decides a participating region, then releases their flushes together inside one transition. A
 * parent's update reaches its children's schedulers in later microtasks, so the update waits one
 * task before the browser captures the new state. An update that turns out to add, remove and
 * move nothing skips its transition.
 */

import { ABSENT, NONCONFORMING, toText, type Value } from "./expression.js";
import { documentState } from "./generated-lifecycle.js";
import type { ReactiveScheduler } from "./reactivity.js";

interface Coordinator {
  /** 0 idle, 1 waiting for the update callback, 2 inside it. */
  phase: 0 | 1 | 2;
  /** The held instances' own flushes, run together inside the transition's update. */
  readonly held: (() => void)[];
  /** A participating region or list changed structure during the update. */
  changed: boolean;
  /** Bumped per transition, so a skipped transition's cleanup leaves a newer one alone. */
  generation: number;
  /** Every registered component's rules; their pseudo-element selectors match only during a transition. */
  readonly rules: CSSStyleSheet;
  readonly registered: Set<string>;
  /** Present only during this coordinator's transitions: the rest of the page stays live. */
  readonly during: CSSStyleSheet;
  readonly reduced: MediaQueryList;
}

let coordinator: Coordinator | undefined | null;

/** The document's coordinator, or null where the browser has no view transitions. */
function current(): Coordinator | null {
  if (coordinator !== undefined) return coordinator;
  if (typeof document === "undefined" || typeof document.startViewTransition !== "function") return coordinator = null;
  const state = documentState(document) as { transitions?: Coordinator };
  if (state.transitions === undefined) {
    const rules = new CSSStyleSheet();
    const during = new CSSStyleSheet();
    during.replaceSync(":root { view-transition-name: none; } ::view-transition { pointer-events: none; }");
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, rules];
    state.transitions = {
      phase: 0, held: [], changed: false, generation: 0, rules, registered: new Set(), during,
      reduced: matchMedia("(prefers-reduced-motion: reduce)"),
    };
  }
  return coordinator = state.transitions;
}

/** Registers a component's transition rules once per document. */
export function transitionStyles(css: string): void {
  const state = current();
  if (state === null || state.registered.has(css)) return;
  state.registered.add(css);
  state.rules.replaceSync([...state.registered].join("\n"));
}

/**
 * Holds a compiled instance's flushes whose changes reach what decides a participating region.
 * The scheduler's microtask calls `this.flush()`, so the instance's flush runs through the hold
 * first, and the scheduler carries no transition code. The instance's pending change bits say what
 * the flush will render: a bit per replaced root, and the nested bit for any write below a root.
 */
export function holdTransitions(instance: { readonly q: ReactiveScheduler; readonly d: () => number }, mask: number): void {
  const { q: scheduler, d: pending } = instance;
  const flush = scheduler.flush.bind(scheduler);
  scheduler.flush = () => {
    if ((pending() & mask) === 0 || !hold(flush)) flush();
  };
}

function hold(flush: () => void): boolean {
  const state = current();
  // Inside the update callback, a flush runs at once: it belongs to the transition already capturing.
  if (state === null || state.phase === 2 || state.reduced.matches) return false;
  // A write while held queues another microtask, which asks again: hold each flush once.
  if (!state.held.includes(flush)) state.held.push(flush);
  if (state.phase === 0) start(state);
  return true;
}

function start(state: Coordinator): void {
  state.phase = 1;
  state.changed = false;
  const generation = ++state.generation;
  if (!document.adoptedStyleSheets.includes(state.during)) {
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, state.during];
  }
  // ponytail: one document transition at a time; a new one skips a running one, so a quick
  // reversal jumps. `Element.startViewTransition` runs them side by side where it ships.
  const transition = document.startViewTransition(async () => {
    state.phase = 2;
    try {
      for (const flush of state.held.splice(0)) {
        // A failing flush reports as it would have from its own microtask; the rest still run.
        try { flush(); } catch (error) { queueMicrotask(() => { throw error; }); }
      }
      await new Promise((resolve) => setTimeout(resolve));
    } finally {
      state.phase = 0;
    }
    if (!state.changed) transition.skipTransition();
  });
  transition.ready.catch(() => {});
  void transition.finished.finally(() => {
    if (state.generation !== generation) return;
    document.adoptedStyleSheets = document.adoptedStyleSheets.filter((sheet) => sheet !== state.during);
  });
}

/** Marks a participating region whose content was added, removed or replaced during an update. */
export function transitionChanged(): void {
  if (coordinator?.phase === 2) coordinator.changed = true;
}

interface RowList {
  readonly r: readonly { readonly n: Node }[];
}

/** A participating list's row nodes before an update, read only inside a transition's update. */
export function transitionRows(list: RowList): readonly Node[] | undefined {
  return coordinator?.phase === 2 ? list.r.map((row) => row.n) : undefined;
}

/** Marks the update changed when the list gained, lost or reordered rows since `before`. */
export function transitionRowsChanged(list: RowList, before: readonly Node[] | undefined): void {
  if (before !== undefined && (before.length !== list.r.length || list.r.some((row, index) => row.n !== before[index]))) {
    coordinator!.changed = true;
  }
}

/** A bound `style` attribute on a participating element, written without dropping its view-transition properties. */
export function writeTransitionStyle(element: Element & ElementCSSInlineStyle, value: string | null): void {
  const { style } = element;
  const name = style.getPropertyValue("view-transition-name");
  const cls = style.getPropertyValue("view-transition-class");
  if (value === null) element.removeAttribute("style");
  else element.setAttribute("style", value);
  style.setProperty("view-transition-name", name);
  style.setProperty("view-transition-class", cls);
}

// Keywords the property reads as itself rather than as a name.
const KEYWORDS = new Set(["none", "auto", "match-element", "initial", "inherit", "unset", "revert", "revert-layer", "default"]);

/**
 * A `$transition-name` value as a `view-transition-name`. Any value names the element; an absent,
 * null, empty or nonconforming one falls back to the element's own identity.
 */
export function transitionName(value: Value): string {
  if (value === ABSENT || value === NONCONFORMING || value === null || value === "") return "match-element";
  const text = toText(value);
  if (KEYWORDS.has(text)) return `hn-${text}`;
  return typeof CSS === "undefined" ? text : CSS.escape(text);
}

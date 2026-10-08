import { fail, type DiagnosticLocation } from "./diagnostics.js";
import { parseDuration } from "./duration.js";
import type { ComponentDefinition, ElementTransition, TemplateNode } from "./template.js";

/** The `transitions` extension's name, as builds and diagnostics spell it. */
export const TRANSITIONS_EXTENSION = "transitions";

/** Every optional language extension a build can enable. */
export const LANGUAGE_EXTENSIONS: readonly string[] = [TRANSITIONS_EXTENSION];

/** Keyframes the extension provides. Each describes arriving; leaving plays it in reverse. */
export const BUILT_IN_TRANSITIONS = ["fade", "fly", "scale", "blur"] as const;

/** A parsed `$transition` value. Absent fields keep the browser's defaults. */
export interface TransitionTiming {
  /** A built-in or `@keyframes` name; absent for the browser's default crossfade. */
  readonly keyframes?: string;
  readonly duration?: number;
  readonly easing?: string;
  readonly delay?: number;
}

const EASING_KEYWORDS = new Set(["linear", "ease", "ease-in", "ease-out", "ease-in-out", "step-start", "step-end"]);
const EASING_FUNCTION_RE = /^(?:cubic-bezier|steps|linear)\([^()]*\)$/;
const IDENT_RE = /^-?[A-Za-z_][\w-]*$/;
// CSS-wide keywords and `none` cannot name keyframes.
const RESERVED_NAMES = new Set(["none", "initial", "inherit", "unset", "revert", "revert-layer", "default"]);

/**
 * Reads a `$transition` value the way CSS reads the `animation` shorthand: one keyframes name,
 * an easing, and up to two times (duration, then delay), in any order. An empty value is the
 * browser's default crossfade.
 */
export function parseTransitionValue(value: string, source: string, location?: DiagnosticLocation): TransitionTiming {
  const result: { -readonly [K in keyof TransitionTiming]: TransitionTiming[K] } = {};
  const invalid = (detail: string): never =>
    fail("HT025", `\`$transition="${value}"\` ${detail}; write a keyframes name, then an optional duration, easing, and delay, as in \`fly 200ms ease-out\`.`, source, location);
  for (const token of value.trim().match(/[^\s(]+(?:\([^()]*\))?/g) ?? []) {
    if (/\d(?:ms|s)$/.test(token)) {
      const time = parseDuration(token) ?? invalid(`has an unreadable time \`${token}\``);
      if (result.duration === undefined) result.duration = time;
      else if (result.delay === undefined) result.delay = time;
      else invalid("has more than two times");
    } else if (EASING_KEYWORDS.has(token) || EASING_FUNCTION_RE.test(token)) {
      if (result.easing !== undefined) invalid("has more than one easing");
      result.easing = token;
    } else if (IDENT_RE.test(token) && !RESERVED_NAMES.has(token)) {
      if (result.keyframes !== undefined) invalid("has more than one keyframes name");
      result.keyframes = token;
    } else {
      invalid(`has an unknown part \`${token}\``);
    }
  }
  return result;
}

/** Every element of a definition that uses the extension, in document order. */
export function transitionElements(definition: ComponentDefinition): ElementTransition[] {
  const found: ElementTransition[] = [];
  const visit = (node: TemplateNode): void => {
    if (node.kind === "text") return;
    if (node.kind === "slot") {
      node.fallback?.forEach(visit);
      return;
    }
    if (node.transition !== undefined) found.push(node.transition);
    node.children.forEach(visit);
  };
  visit(definition.template);
  return found;
}

const BUILT_IN_KEYFRAMES: Readonly<Record<string, string>> = {
  fade: "from { opacity: 0; }",
  fly: "from { opacity: 0; translate: 0 1rem; }",
  scale: "from { opacity: 0; scale: 0.95; }",
  blur: "from { opacity: 0; filter: blur(0.5rem); }",
};

/** The `view-transition-class` a value's elements carry: values that read alike share one. */
export function transitionClass(timing: TransitionTiming): string {
  const text = JSON.stringify([timing.keyframes, timing.duration, timing.easing, timing.delay]);
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193);
  return `hn-t${(hash >>> 0).toString(36)}`;
}

/**
 * The document-level rules that animate a value's class. An arriving element (a new picture with
 * no old one) plays the keyframes forwards, a leaving one plays them in reverse, and the browser's
 * own move takes the value's timing. Built-in keyframes are prefixed, so an author's `@keyframes
 * fade` stays the author's.
 */
export function transitionCss(timing: TransitionTiming, cls: string): string {
  const rules: string[] = [];
  const time = [
    timing.duration === undefined ? "" : `animation-duration: ${timing.duration}ms;`,
    timing.easing === undefined ? "" : `animation-timing-function: ${timing.easing};`,
    timing.delay === undefined ? "" : `animation-delay: ${timing.delay}ms;`,
  ].filter(Boolean).join(" ");
  if (time !== "") rules.push(`::view-transition-group(.${cls}) { ${time} }`);
  if (timing.keyframes !== undefined) {
    const builtIn = BUILT_IN_KEYFRAMES[timing.keyframes];
    const name = builtIn === undefined ? timing.keyframes : `hn-${timing.keyframes}`;
    if (builtIn !== undefined) rules.push(`@keyframes ${name} { ${builtIn} }`);
    const animation = `${name} ${timing.duration ?? 250}ms ${timing.easing ?? "ease"} ${timing.delay ?? 0}ms both`;
    rules.push(`::view-transition-new(.${cls}):only-child { animation: ${animation}; }`);
    rules.push(`::view-transition-old(.${cls}):only-child { animation: ${animation} reverse; }`);
  }
  return rules.join("\n");
}

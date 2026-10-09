/**
 * The rendering module converted Svelte components share: the helpers their markup renders and
 * binds values with, and the checks their handlers write through. They are the same for every
 * component, so they ship once beside the components rather than inside each one; a bundler keeps
 * only the ones a component imports. It is a `.svelte.ts` module because its attachments use runes.
 */
import type { GeneratedArtifact } from "../generate.js";
import { HOST_STATE_TOKENS_SOURCE } from "./host-state-source.js";
import { formatSvelteScript } from "./vue-format.js";
import { expressionHelpersSource } from "./vue-lowering.js";

/** Where the module sits, relative to the package root, and how a component imports it. */
export const SVELTE_RENDER_PATH = "svelte/render.svelte.ts";
export const SVELTE_RENDER_SPECIFIER = "./render.svelte";

// Props converted components pass each other, which never reach the DOM. A NUL cannot appear in an
// authored HTML attribute or a declared public prop name.
export const SLOTS_PROP = "\0html-next:slots";
export const ROOT_OWNER_PROP = "\0html-next:root-owner";
export const DECORATIONS_PROP = "\0html-next:decorations";
export const BINDING_INPUTS_PROP = "\0html-next:binding-inputs";
export const LITERAL_INPUTS_PROP = "\0html-next:literal-inputs";
export const NATIVE_BINDINGS_PROP = "\0html-next:native-bindings";
const INTERNAL_PROPS = [ROOT_OWNER_PROP, DECORATIONS_PROP, BINDING_INPUTS_PROP, LITERAL_INPUTS_PROP, SLOTS_PROP];

/** Helpers a component calls by these names; the expression helpers come from its lowering. */
export const SVELTE_RENDER_COMPONENTS = ["formatValue", "acceptsWrite", "isString", "isNumber", "isInteger", "isBoolean", "rootAttributes",
  "retainedValue", "retainedStructuralValue", "writePath", "checkedSlot", "setProperty",
  "decorate", "hostStateTokens"] as const;

const SOURCE = `import { createAttachmentKey } from "svelte/attachments";

${expressionHelpersSource()}

/**
 * The root's attributes, as one spread: the consumer's, without the props converted components pass
 * each other, plus the root's \`data-component\` token. A root that is another component forwards
 * its native bindings to it. An attachment writes \`constructor\` and \`__proto__\`, which Svelte's
 * spread reads through the prototype.
 */
export function rootAttributes(rest: () => Record<string, unknown>, tag: string, options: { forwardBindings?: boolean; omit?: readonly string[]; clientOmit?: readonly string[]; server?: () => Record<string, unknown> } = {}): () => Record<string, unknown> {
  const attach = createAttachmentKey();
  const prototype = prototypeAttributes(rest);
  const attrs = $derived.by(() => {
    const props = rest();
    const attrs = Object.assign(Object.create(null) as Record<string | symbol, unknown>, props);
    for (const name of [...${JSON.stringify(INTERNAL_PROPS)}, ...(options.forwardBindings ? [] : [${JSON.stringify(NATIVE_BINDINGS_PROP)}]), ...(options.omit ?? [])]) Reflect.deleteProperty(attrs, name);
    if (typeof document === "undefined") {
      for (const [name, value] of Object.entries(options.server?.() ?? {})) if (value !== undefined) attrs[name] = value;
    } else {
      for (const name of [...(options.clientOmit ?? []), "constructor", "__proto__"]) Reflect.deleteProperty(attrs, name);
    }
    attrs["data-component"] = [props["data-component"], tag].filter(Boolean).join(" ");
    attrs[attach] = prototype;
    // The attachment key is a symbol, which Svelte's element types leave out.
    return attrs as Record<string, unknown>;
  });
  return () => attrs;
}

function prototypeAttributes(rest: () => Record<string, unknown>) {
  return (element: Element) => {
    for (const name of ["constructor", "__proto__"]) {
      let written = false;
      $effect(() => {
        const props = rest();
        const value: unknown = props[name];
        const present = Object.keys(props).includes(name) && value != null && value !== false;
        if (present) element.setAttribute(name, String(value));
        else if (written) element.removeAttribute(name);
        written = present;
      });
    }
  };
}

/** A value that keeps its last accepted value while an expression is invalid. */
export function retainedValue<T>(initial: T): (candidate: unknown) => T {
  let previous = initial;
  return (candidate: unknown) => {
    if (candidate === Symbol.for("html-next.invalid-result")) return previous;
    previous = candidate as T;
    return previous;
  };
}

/** A structural value that keeps its last accepted value, and whether it has had one. */
export function retainedStructuralValue(): <T>(candidate: T | symbol) => { ready: boolean; value: T } {
  let ready = false;
  let previous: unknown;
  return function <T>(candidate: T | symbol) {
    if (candidate !== Symbol.for("html-next.invalid-result")) { ready = true; previous = candidate; }
    return { ready, value: previous as T };
  };
}

/** Writes one nested path of a state value in place, as Svelte's deep state expects. */
export function writePath(root: unknown, path: readonly unknown[], value: unknown): void {
  let target = root;
  for (const [index, key] of path.entries()) {
    if (typeof key !== "string" && typeof key !== "number" || target === null || typeof target !== "object") return;
    if (index === path.length - 1) (target as Record<string | number, unknown>)[key] = value;
    else target = (target as Record<string | number, unknown>)[key];
  }
}

/** A scoped slot's snippet; plain children cannot fill it (HR007). */
export function checkedSlot<T>(slot: T | null | undefined, name: string): T | undefined {
  if (slot === null) {
    const message = "Scoped slot \\u0060" + name + "\\u0060 requires a consumer <template slot=\\"" + name + "\\">.";
    throw Object.assign(new Error("HR007: " + message), { name: "HtmlDiagnosticError", diagnostic: Object.freeze({ code: "HR007", message }) });
  }
  return slot;
}

/** An attachment that keeps a DOM property in step with its value. */
export function setProperty(name: string, read: () => unknown) {
  return (element: Element) => {
    let initialized = false;
    $effect(() => {
      const value = read();
      if (value === Symbol.for("html-next.invalid-result")) return;
      // Native scroll setters run while live roots are detached and have no initial layout effect.
      const first = !initialized; initialized = true;
      if (first && (name === "scrollTop" || name === "scrollLeft")) return;
      Reflect.set(element, name, value);
    });
  };
}

/** An attachment that toggles classes and sets style properties from their values. */
export function decorate(decorations: readonly { readonly kind: "class" | "style"; readonly name: string; readonly read: () => unknown }[]) {
  return (element: Element) => {
    for (const decoration of decorations) $effect(() => {
      const value = decoration.read();
      if (value === Symbol.for("html-next.invalid-result")) return;
      if (decoration.kind === "class") element.classList.toggle(decoration.name, Boolean(value));
      else (element as HTMLElement).style.setProperty(decoration.name, value == null ? "" : String(value));
    });
  };
}

export ${HOST_STATE_TOKENS_SOURCE.trim()}
`;

export function svelteRenderArtifact(version: string): GeneratedArtifact {
  return Object.freeze({ path: SVELTE_RENDER_PATH, content: formatSvelteScript(`// Generated by HTML Next ${version} for Svelte 5. Do not edit.\n${SOURCE}`, "render.svelte.ts") });
}

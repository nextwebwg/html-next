import type { StencilComponentInventory } from "./stencil.js";
import { transformGlobalStyles } from "../style.js";

export interface LoomaStyleRoot {
  readonly tag: string;
  readonly element: string;
  readonly classes: readonly string[];
  readonly props: readonly string[];
}

function escapePattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function kebabCase(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

/** Re-targets Looma's public light-DOM fallback CSS to HTML Next provenance roots. */
export function migrateLoomaStyles(css: string, roots: readonly LoomaStyleRoot[]): string {
  let output = css;
  for (const root of [...roots].sort((left, right) => right.tag.length - left.tag.length)) {
    const tag = escapePattern(root.tag);
    for (const prop of root.props.map(kebabCase).sort((left, right) => right.length - left.length)) {
      output = output.replace(new RegExp(`\\b${tag}\\[${escapePattern(prop)}(?=[\\s~|^$*!=\\]])`, "g"), `${root.tag}[data-${prop}`);
    }
  }
  output = transformGlobalStyles(output);
  for (const root of roots) {
    const marker = `:is(:where([data-component-root~="${root.tag}"]), ${root.tag})`;
    const escapedMarker = escapePattern(marker);
    const rootSubject = `(${escapedMarker}(?:\\[[^\\]]+\\]|:[\\w-]+(?:\\([^)]*\\))?)*)`;
    output = output.replace(new RegExp(`${rootSubject}\\s*>\\s*${escapePattern(root.element)}(?=[.#[:\\s,{])`, "g"), "$1");
    for (const className of root.classes) {
      output = output.replace(new RegExp(`${rootSubject}\\s*>\\s*\\.${escapePattern(className)}(?=[.#[:\\s,{])`, "g"), `$1.${className}`);
    }
  }
  return output;
}

export function loomaStyleRoots(
  inventory: readonly StencilComponentInventory[],
  definitions: ReadonlyMap<string, { readonly element: string; readonly classes: readonly string[] }>,
): readonly LoomaStyleRoot[] {
  return Object.freeze(inventory.map((component) => {
    const definition = definitions.get(component.tag);
    if (definition === undefined) throw new Error(`No reviewed definition exists for <${component.tag}>.`);
    return Object.freeze({
      tag: component.tag,
      element: definition.element,
      classes: definition.classes,
      props: Object.freeze(component.props.map((prop) => prop.name)),
    });
  }));
}

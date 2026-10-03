import type { GeneratedArtifact } from "../generate.js";
import { nativeControlModule } from "./react-control.js";

const SOURCE = `
const authoredOptions = new WeakMap<HTMLOptionElement, boolean>();
if (typeof document !== "undefined") {
  for (const option of document.querySelectorAll<HTMLOptionElement>('option[data-html-next-option-default]')) {
    authoredOptions.set(option, option.getAttribute('data-html-next-option-default') === 'true');
    option.removeAttribute('data-html-next-option-default');
  }
}

export function controlDefaults(element: Element, defaults: BoundDefaults): BoundDefaults {
  if (!(element instanceof HTMLSelectElement)) return defaults;
  return { ...defaults, options: Array.from(element.options, (option) => authoredOptions.get(option) ?? option.defaultSelected) };
}

/** DOM observation supplies option-list changes that don't change the bound state. */
export function observeBoundOptions(element: Element, sync: () => void): () => void {
  if (!(element instanceof HTMLSelectElement)) return () => {};
  let previous = Array.from(element.options, (option) => [option, option.value] as const);
  const observer = new MutationObserver(() => {
    const next = Array.from(element.options, (option) => [option, option.value] as const);
    if (next.length === previous.length && next.every(([option, value], index) => previous[index]?.[0] === option && previous[index]?.[1] === value)) return;
    previous = next;
    sync();
  });
  observer.observe(element, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ['value'] });
  return () => observer.disconnect();
}
`;

export function svelteControlArtifact(version: string): GeneratedArtifact {
  return Object.freeze({ path: "svelte/control.ts", content: nativeControlModule(version) + SOURCE });
}

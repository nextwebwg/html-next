import type { GeneratedArtifact } from "../generate.js";
import { nativeControlModule } from "./react-control.js";
import { OPTION_WATCH_SOURCE } from "./shared-generated.js";

export const CONTROL_CAPTURE_CONTEXT = "\0html-next:control-capture";

const SOURCE = `
import { getContext, setContext } from "svelte";

/** Public context keeps the capture before DOM claims and once per generated subtree. */
export function prepareHydrationControls(): void {
  if (typeof document === 'undefined') return;
  const capture = getContext<{ prepared: boolean }>(${JSON.stringify(CONTROL_CAPTURE_CONTEXT)}) ??
    setContext(${JSON.stringify(CONTROL_CAPTURE_CONTEXT)}, { prepared: false });
  if (capture.prepared) return;
  capture.prepared = true;
  captureHydrationControls(document, true);
}

const authoredOptions = new WeakMap<HTMLOptionElement, boolean>();
if (typeof document !== "undefined") {
  for (const option of document.querySelectorAll<HTMLOptionElement>('option[data-html-next-option-default]')) {
    authoredOptions.set(option, option.getAttribute('data-html-next-option-default') === 'true');
    option.removeAttribute('data-html-next-option-default');
  }
}

export function controlDefaults(element: Element, defaults: BoundDefaults): BoundDefaults {
  if (!(element instanceof HTMLSelectElement)) return defaults;
  const options = Array.from(element.options, (option) => {
    const marker = option.getAttribute('data-html-next-option-default');
    if (marker !== null) {
      // Libraries may load before another server-rendered subtree is inserted.
      authoredOptions.set(option, marker === 'true');
      option.removeAttribute('data-html-next-option-default');
    }
    return authoredOptions.get(option) ?? option.defaultSelected;
  });
  return { ...defaults, options };
}

${OPTION_WATCH_SOURCE}
/** DOM observation supplies option-list changes that don't change the bound state. */
export function observeBoundOptions(element: Element, sync: () => void): () => void {
  if (!(element instanceof HTMLSelectElement)) return () => {};
  let previous = Array.from(element.options, (option) => [option, option.value] as const);
  return watchOptions(element, () => {
    const next = Array.from(element.options, (option) => [option, option.value] as const);
    if (next.length === previous.length && next.every(([option, value], index) => previous[index]?.[0] === option && previous[index]?.[1] === value)) return;
    previous = next;
    sync();
  });
}
`;

export function svelteControlArtifact(version: string): GeneratedArtifact {
  return Object.freeze({ path: "svelte/control.ts", content: nativeControlModule(version) + SOURCE });
}

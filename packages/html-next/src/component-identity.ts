/** Rendered identity is separate from the definition carried by a template. */
export const COMPONENT_ATTRIBUTE = "component";
// Lifecycle walks inspect only roots with registered records, so this coarse native query is enough.
export const COMPONENT_LIFECYCLE_SELECTOR = "[component],[data-component]";
export const COMPONENT_ROOT_SELECTOR = ':is([component]:not(template), [data-component]:not([component]))';

/** A present canonical attribute wins even when its value is empty. */
export function componentIdentity(element: Element): string {
  return element.getAttribute("component") ?? element.getAttribute("data-component") ?? "";
}

/** Native selector matching owns compatibility and precedence for scoped CSS. */
export function componentOwnerSelector(tag: string, namespace = ""): string {
  const element = namespace === "" ? "" : `${namespace}*`;
  return `:is(${element}[component~="${tag}"]:not(template), ${element}[data-component~="${tag}"]:not([component]))`;
}

/** Derives a PascalCase component name from a lowercase custom-element tag. */
export function componentName(tag: string): string {
  let name = "";
  let upper = true;
  for (const character of tag) {
    if (character === "-") {
      upper = true;
    } else {
      name += upper ? character.toUpperCase() : character;
      upper = false;
    }
  }
  return name;
}

/** A framework component's function prop for a request: `mention-query` is `mentionQuery`. */
export function requestPropName(name: string): string {
  return name.replace(/-([a-z0-9])/g, (_, letter: string) => letter.toUpperCase());
}

export function kebabCase(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

/**
 * The attribute that records a component's explicit prop on its root. The component's tag
 * namespaces it, as it does `data-<tag>-state`, so an authored `data-*` attribute never collides.
 */
export function propAttribute(tag: string, name: string): string {
  return `data-${tag}-prop-${kebabCase(name)}`;
}

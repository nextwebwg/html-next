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

export function kebabCase(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

import {
  DOM_INTERFACES,
  DOM_TAG_INTERFACES,
} from "./generated/dom-properties.js";

export function getDomInterface(tagName: string): string | undefined {
  return DOM_TAG_INTERFACES[tagName.toLowerCase()];
}

export function resolveDomProperty(
  tagName: string,
  propertyName: string,
): string | undefined {
  const interfaceName = getDomInterface(tagName);
  if (interfaceName === undefined) return undefined;
  const key = propertyName.toLowerCase();
  return resolveFromInterface(interfaceName, key);
}

function resolveFromInterface(
  interfaceName: string,
  key: string,
): string | undefined {
  const contract = DOM_INTERFACES[interfaceName];
  if (contract === undefined) return undefined;
  const own = contract.properties[key];
  if (own !== undefined) return own;
  for (const parent of contract.extends) {
    const inherited = resolveFromInterface(parent, key);
    if (inherited !== undefined) return inherited;
  }
  return undefined;
}

import type { AttributeBinding, TemplateAttribute } from "../template.js";
import { quote } from "./shared.js";

export function isStyleWrite(attribute: TemplateAttribute): boolean {
  return attribute.kind === "literal" && attribute.name === "style"
    || attribute.kind === "attribute" && !attribute.twoWay && (attribute.target === "style" || attribute.target === undefined && attribute.name === "style");
}

/** Fold a component invocation's CSS writes before its receiving prop accepts the attribute text. */
export function styleWriteRules(attributes: readonly TemplateAttribute[], read: (attribute: AttributeBinding, fallback?: string) => string, forwarded: string): string {
  const rules: string[] = [];
  for (const attribute of attributes) {
    if (attribute.kind === "forward") {
      rules.push(`{ kind: "attribute" as const, name: "style", read: () => Object.hasOwn(forwardedAttributes(${forwarded}), "style") ? ${forwarded}.style : Symbol.for("html-next.no-attribute") }`);
    } else if (isStyleWrite(attribute)) {
      if (attribute.kind === "literal") {
        if (attributes.some(binding => binding.kind === "attribute" && binding.target === undefined && binding.name === "style")) continue;
        rules.push(`{ kind: "attribute" as const, name: "style", read: () => ${quote(attribute.value)} }`);
      } else if (attribute.kind === "attribute") {
        const literal = attribute.target === undefined ? attributes.find(entry => entry.kind === "literal" && entry.name === "style") : undefined;
        rules.push(`{ kind: ${quote(attribute.target ?? "attribute")} as const, name: ${quote(attribute.name)}, read: () => ${read(attribute, literal?.kind === "literal" ? literal.value : undefined)}${literal?.kind === "literal" ? `, fallback: ${quote(literal.value)}` : ""} }`);
      }
    }
  }
  return `[${rules.join(", ")}]`;
}

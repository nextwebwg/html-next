import { asciiLowerCase, kebabCase } from "../names.js";
import { normalizeType } from "../type-system.js";
import type { PropContract } from "../types.js";
import { literalValueSource } from "./shared.js";
import { propInputOrder } from "./backend.js";

/** Input metadata for an authored forwarding operation at a known component boundary. */
export function invocationSchema(props: Readonly<Record<string, PropContract>>, alias?: (name: string) => string): string {
  return literalValueSource(Object.fromEntries(propInputOrder(Object.entries(props).map(([name, contract]) => ({ name, contract })))
    .map(({ name, contract }) => [name, {
      attributes: [...new Set([name, kebabCase(name), ...alias === undefined ? [] : [alias(kebabCase(name))]].map(asciiLowerCase))],
      type: contract.select === undefined ? normalizeType(contract.type) : { kind: "selected", ...contract.select,
        options: contract.select.options.map(option => ({ ...option, type: normalizeType(option.type) })) },
      default: contract.default ?? null,
    }])));
}

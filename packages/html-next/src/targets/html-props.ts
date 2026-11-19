import { HTML_LITERAL_SOURCE } from "../generated/html-literal-source.js";

/** Shared HTML coercion for generated component inputs. */
export const HTML_PROPS_SOURCE = HTML_LITERAL_SOURCE + `
/** Apply HTML input coercions before the shared strict validator. */
function parseHtmlProp(value: unknown, type: TypeNode, structured?: (value: unknown) => unknown): Parsed {
  if (type.kind === "union") {
    for (const member of type.members) { const result = parseHtmlProp(value, member, structured); if (result.ok) return result; }
    return issue("$", "Must match the selected type.");
  }
  if (type.kind === "constrained") {
    const result = parseHtmlProp(value, type.base, structured);
    return result.ok ? parse(result.value, type, "$") : result;
  }
  if (type.kind === "terminal" && typeof value === "string") {
    if (type.name === "boolean") value = value === "" || value === "true" ? true : value === "false" ? false : value;
    else if (type.name === "number" || type.name === "integer") {
      const valid = type.name === "integer" ? /^-?\\d+$/.test(value) : /^-?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][+-]?\\d+)?$/.test(value);
      if (valid) value = Number(value);
    }
  }
  if (structured !== undefined && ["list", "record", "object"].includes(type.kind)) value = structured(value);
  return parse(value, type, "$");
}

export function htmlPropValue(value: unknown, type: TypeNode | null, structured?: (value: unknown) => unknown): unknown {
  if (type === null) return value;
  const result = parseHtmlProp(value, type, structured);
  return result.ok ? result.value : value;
}

const HTML_ATTRIBUTE_INPUT = Symbol.for("html-next.html-attribute-input");
/** Preserve a typed prop while a framework normalizes its native style input. */
export function preservePropInput(input: Record<string, unknown>, name: string): Record<string, unknown> {
  if (!Object.hasOwn(input, name) || input[name] == null) return input;
  return { ...input, [name]: { __htmlNextPropInput: input[name], readHtml: (value: unknown, type: TypeNode) => parse(value, type, "$") } };
}

function readHtmlAttributeInput(value: unknown, type: TypeNode): Parsed {
  return parseHtmlProp(value, type, parseHtmlLiteral);
}
type InvocationInputSchema = Readonly<Record<string, { readonly attributes: readonly string[]; readonly default: unknown;
  readonly type: TypeNode | { readonly kind: "selected"; readonly from: string; readonly options: readonly { readonly value: string | number | boolean; readonly type: TypeNode }[] } }>>;

/** Preserve the HTML form of forwarded prop inputs until all ordered writes have been folded. */
export function htmlAttributeInputs(input: Readonly<Record<string, unknown>>, schema: InvocationInputSchema): Record<string, unknown> {
  const lower = (value: string): string => value.replace(/[A-Z]/g, letter => letter.toLowerCase());
  return Object.fromEntries(Object.entries(input).map(([attribute, value]) => {
    const normalized = lower(attribute);
    const prop = Object.keys(schema).find(name => schema[name]!.attributes.includes(normalized));
    return prop === undefined ? [attribute, value] : [prop, { [HTML_ATTRIBUTE_INPUT]: value, readHtml: readHtmlAttributeInput }];
  }));
}

/** Resolve HTML inputs using the receiving prop's final selector and declared HTML conversion. */
export function invocationProps(input: Record<string, unknown>, schema: InvocationInputSchema, records: readonly string[] = [BINDING_INPUTS_PROP]): Record<string, unknown> {
  let result = input;
  for (const [name, prop] of Object.entries(schema)) {
    const value = input[name];
    if (value === null || typeof value !== "object" || !Object.hasOwn(value, HTML_ATTRIBUTE_INPUT)) continue;
    if (result === input) result = { ...input };
    for (const key of records) {
      const record = result[key];
      if (record !== null && typeof record === "object" && Object.hasOwn(record, name)) {
        result[key] = Object.fromEntries(Object.entries(record).filter(([key]) => key !== name));
      }
    }
    let type: TypeNode;
    if (prop.type.kind === "selected") {
      const selector = schema[prop.type.from];
      const supplied = result[prop.type.from] ?? selector?.default;
      const effective = selector === undefined || selector.type.kind === "selected" || parse(supplied, selector.type, "$").ok ? supplied : selector.default;
      type = selectedPropNode(effective, prop.type.options);
    } else type = prop.type;
    result[name] = htmlPropValue((value as Record<symbol, unknown>)[HTML_ATTRIBUTE_INPUT], type, parseHtmlLiteral);
    result[BINDING_INPUTS_PROP] = { ...(result[BINDING_INPUTS_PROP] as object | undefined),
      [name]: () => ({ value, status: READY_INPUT }) };
  }
  return result;
}

/** Composed targets pass the HTML input to the receiver's existing accepted-value check. */
export function invocationInput(input: Record<string, unknown>, name: string, fallback: unknown = input[name]): unknown {
  const bindings = input[BINDING_INPUTS_PROP] as InputBindings | undefined;
  return bindings?.[name]?.().value ?? fallback;
}

`;

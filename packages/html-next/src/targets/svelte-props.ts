/** Target-neutral typed-prop rules, emitted only for Svelte components with props. */
import { HTML_LITERAL_SOURCE } from "../generated/html-literal-source.js";
import type { GeneratedArtifact } from "../generate.js";
import { typedPropsModule } from "./vue-props.js";
import { DECLARED_EVENT_TYPE_SOURCE, DECLARED_REFERENCE_TYPE_SOURCE } from "./shared-generated.js";

export function sveltePropsArtifact(version: string): GeneratedArtifact {
  return Object.freeze({ path: "svelte/props.ts", content: typedPropsModule(version) + HTML_LITERAL_SOURCE + DECLARED_EVENT_TYPE_SOURCE + DECLARED_REFERENCE_TYPE_SOURCE + `
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

interface BoundInput { readonly value: unknown; readonly raw: unknown; readonly html: boolean }
interface ParentInput { readonly value: unknown; readonly attribute: string | undefined }

/** The invocation is HTML until an accepted parent write replaces its input handle. */
export function retainedBindingInput(initialize: (value: unknown) => void, fallback: unknown, structured?: (value: unknown) => unknown):
  (read: (() => ParentInput | symbol) | undefined, initial: () => BoundInput, type: Parameters<typeof acceptsBindingDestination>[1]) => BoundInput {
  let initialized = false;
  let previous: BoundInput | undefined;
  const retain = (value: unknown, raw: unknown, html: boolean): BoundInput => {
    if (previous === undefined || !Object.is(previous.value, value) || !Object.is(previous.raw, raw) || previous.html !== html) previous = { value, raw, html };
    return previous;
  };
  return (read, initial, type) => {
    if (read === undefined) { initialized = false; const input = initial(); return retain(input.value, input.raw, input.html); }
    const candidate = read();
    const accepted = typeof candidate !== "symbol" && acceptsBindingDestination(candidate.value, type);
    if (!initialized) {
      if (accepted && (type === null || parse(candidate.value, type, "$").ok)) retain(candidate.value, candidate.value ?? null, false);
      else if (typeof candidate === "symbol") previous = initial();
      else {
        const raw = candidate.attribute;
        const result = raw === undefined ? { ok: true as const, value: fallback }
          : type === null ? { ok: true as const, value: raw } : parseHtmlProp(raw, type, structured);
        retain(result.ok ? result.value : fallback, raw ?? null, raw !== undefined);
      }
      initialize(previous!.value);
      initialized = true;
    }
    if (accepted) return retain(candidate.value, candidate.value ?? null, false);
    return previous!;
  };
}

` });
}

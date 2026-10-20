import { parseTypedValue, parseTypeExpression, selectedPropType, serializePropTarget, type ComponentDefinition } from "@nextwebwg/html-next";
import type { ComponentBindingModule } from "./component-module.js";
import { moduleDefinition } from "./component-module.js";
import { bindingsModule } from "./provider-preparation.js";
import { privateFailure, readPrivate, type ServerReaders, type ServerReadContext } from "./private-readers.js";
import type { BindingInputFrame } from "@nextwebwg/html-next/bindings";
import type { ReadCodec } from "./read-channel.js";

export interface PrivateReadRegistration {
  readonly definition: ComponentDefinition;
  readonly common: () => Promise<ComponentBindingModule>;
  readonly readers: () => Promise<ServerReaders>;
}
export type ReadRequestContext = Omit<ServerReadContext, "sample">;

function failure(status: number, message: string, code?: string): Response {
  return new Response(JSON.stringify({ error: { name: "ReadError", message }, ...code === undefined ? {} : { code } }),
    { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
const invalid = (): never => { throw new Response("Invalid component inputs.", { status: 400 }); };
function record(value: unknown): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return invalid();
  return value as Readonly<Record<string, unknown>>;
}

/** These are untrusted public inputs, never authorization claims or private producer state. */
function inputs(definition: ComponentDefinition, input: unknown): BindingInputFrame {
  const frame = record(input); const props = record(frame.props); const state = record(frame.state);
  if (Object.keys(frame).some(key => key !== "props" && key !== "state")) return invalid();
  const values = Object.fromEntries(Object.entries(props).map(([name, value]) => {
    const prop = definition.contract.props[name];
    if (!Object.hasOwn(definition.contract.props, name)) return invalid();
    return [name, value == null ? prop!.default ?? value : value];
  }));
  for (const [name, value] of Object.entries(values)) {
    const prop = definition.contract.props[name]!;
    const type = selectedPropType(definition.contract, prop, { ...state, ...values });
    if (type === null) return invalid();
    if (value != null && !parseTypedValue(value, type, `$${name}`, "value").ok) return invalid();
    try { serializePropTarget({ ...prop, type }, value, name, definition.contract.tag); } catch { return invalid(); }
  }
  const declarations = new Map<string, NonNullable<ComponentDefinition["declarations"]>[number]>();
  for (const declaration of definition.declarations ?? []) if (declaration.kind === "state" || declaration.kind === "computed" || declaration.kind === "context") {
    declarations.set(declaration.kind === "context" ? declaration.as ?? declaration.name : declaration.name, declaration);
  }
  for (const [name, value] of Object.entries(state)) {
    const declaration = declarations.get(name);
    if (declaration === undefined) return invalid();
    if (declaration.kind === "state" || declaration.kind === "computed") {
      const type = declaration.shape ?? declaration.type;
      if (type !== undefined && !parseTypedValue(value, typeof type === "string" ? parseTypeExpression(type) : type, `$${name}`, "value").ok) return invalid();
    }
  }
  return { props: values, state };
}

function selection(frame: BindingInputFrame, definition: ComponentDefinition) {
  const props = Object.create(null) as Record<string, unknown>;
  const state = Object.create(null) as Record<string, unknown>;
  for (const name of Object.keys(definition.contract.props)) Object.defineProperty(props, name, { enumerable: true, get() {
    if (!Object.hasOwn(frame.props, name)) return invalid();
    return frame.props[name];
  } });
  for (const declaration of definition.declarations ?? []) if (["state", "computed", "context"].includes(declaration.kind)) {
    const name = declaration.kind === "context" ? declaration.as ?? declaration.name : declaration.name;
    Object.defineProperty(state, name, { enumerable: true, get() {
      if (!Object.hasOwn(frame.state, name)) return invalid();
      return frame.state[name];
    } });
  }
  return { props, context: { state } };
}
function immediate(value: unknown): unknown {
  if (value !== null && (typeof value === "object" || typeof value === "function") && "then" in value && typeof value.then === "function") {
    void Promise.resolve(value).catch(() => {});
    throw new TypeError("A binding selector must return synchronously.");
  }
  return value;
}

/** The existing application pipeline owns methods, origin policy and middleware before this handler. */
export async function privateReadResponse(request: Request, base: string, sources: ReadonlyMap<string, PrivateReadRegistration>,
  context: (url: URL) => ReadRequestContext): Promise<Response> {
  request.signal.throwIfAborted();
  let packet: Readonly<Record<string, unknown>>;
  try { packet = record(await request.json()); } catch { return failure(400, "Invalid component read packet."); }
  if (packet.version !== 1 || Object.keys(packet).some(key => !["version", "source", "tag", "name", "url", "inputs"].includes(key)) ||
      typeof packet.source !== "string" || typeof packet.tag !== "string" || typeof packet.name !== "string" || typeof packet.url !== "string") return failure(400, "Invalid component read packet.");
  const registered = sources.get(packet.source);
  if (registered === undefined) return failure(409, "Component code changed. Reload this page.", "stale_source");
  if (registered.definition.contract.tag !== packet.tag) return failure(404, "Unknown component reader.");
  let url: URL;
  try { url = new URL(packet.url, request.url); } catch { return failure(400, "Invalid page URL."); }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.host !== new URL(request.url).host || !url.pathname.startsWith(base) || url.pathname.startsWith("//")) return failure(400, "Invalid page URL.");
  const codec = await import(bindingsModule) as ReadCodec;
  let decoded: unknown;
  try { decoded = codec.decodeHydrationValue(packet.inputs); codec.encodeHydrationValue(decoded); }
  catch { return failure(400, "Invalid component inputs."); }
  try {
    const readers = await registered.readers();
    const reader = Object.hasOwn(readers, packet.name) ? readers[packet.name] : undefined;
    if (reader === undefined) return failure(404, "Unknown component reader.");
    const frame = inputs(registered.definition, decoded);
    const common = moduleDefinition(await registered.common());
    const provider = common.props?.[packet.name];
    if (provider === undefined || provider === false || typeof provider.input !== "function") throw new TypeError("A private reader requires a common input selector.");
    const selected = selection(frame, registered.definition);
    if (provider.when !== undefined && !immediate(provider.when(selected.props, selected.context))) return failure(409, "This binding is not active.", "inactive_binding");
    const input = codec.decodeHydrationValue(codec.encodeHydrationValue(immediate(provider.input(selected.props, selected.context))));
    const sample = codec.decodeHydrationValue(codec.encodeHydrationValue(immediate(provider.sample?.(selected.props, selected.context))));
    const operation: ServerReadContext = { ...context(url), sample };
    operation.signal.throwIfAborted();
    const value = await readPrivate(reader, input, operation);
    operation.signal.throwIfAborted();
    const prop = registered.definition.contract.props[packet.name];
    if (prop === undefined) throw new TypeError("Private reader output is not a declared prop.");
    const type = selectedPropType(registered.definition.contract, prop, { ...frame.state, ...frame.props });
    if (type === null) throw new TypeError("Private reader output has no selected type.");
    if (value != null && !parseTypedValue(value, type, `$${packet.name}`, "value").ok) throw new TypeError("Private reader output does not satisfy its declared type.");
    serializePropTarget({ ...prop, type }, value, packet.name, packet.tag);
    return new Response(JSON.stringify({ value: codec.encodeHydrationValue(value) }), { headers: { "content-type": "application/json", "cache-control": "no-store" } });
  } catch (error) {
    if (request.signal.aborted) throw request.signal.reason;
    const failure = await privateFailure(error);
    return new Response(JSON.stringify({ error: { name: failure.name, message: failure.message } }),
      { status: failure.status ?? 500, headers: { "content-type": "application/json", "cache-control": "no-store" } });
  }
}

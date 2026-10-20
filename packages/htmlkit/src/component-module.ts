import type { BindingConnection, BindingDefinition, BindingHost, BindingModule, BindingProvider } from "@nextwebwg/html-next/bindings";
import type { ComponentHost } from "@nextwebwg/html-next/runtime";

/** Environment companions may replace a reader while retaining the common selector and policy. */
export interface ComponentBindingDefinition<H extends BindingHost = ComponentHost> {
  readonly props?: Readonly<Record<string, Partial<BindingProvider<any, any, any, any>> | false>>;
  readonly connect?: BindingDefinition<H>["connect"];
}
export type ComponentBindingModule<H extends BindingHost = ComponentHost> = ComponentBindingDefinition<H> & { readonly create?: never } |
  { readonly create: () => ComponentBindingDefinition<H>; readonly props?: never; readonly connect?: never };

function definition<H extends BindingHost>(module: ComponentBindingModule<H>): ComponentBindingDefinition<H> {
  if (module.create !== undefined && (typeof module.create !== "function" || module.props !== undefined || module.connect !== undefined)) {
    throw new TypeError("A component module exports create, or props and connect; do not mix the two forms.");
  }
  const value = module.create === undefined ? module : module.create();
  if (value !== null && typeof value === "object" && "then" in value) {
    void Promise.resolve(value).catch(() => {});
    throw new TypeError("A component create factory must return synchronously.");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      value.connect !== undefined && typeof value.connect !== "function" ||
      value.props !== undefined && (value.props === null || typeof value.props !== "object" || Array.isArray(value.props))) {
    throw new TypeError("A component module must provide { props, connect } synchronously.");
  }
  return value;
}

/** Both hooks start on connection; completed cleanups run in reverse order and late ones still close. */
export function connectModules<H extends BindingHost>(common: BindingDefinition<H>["connect"], local: BindingDefinition<H>["connect"]): BindingDefinition<H>["connect"] {
  if (common === undefined) return local;
  if (local === undefined) return common;
  return (host: H, context: BindingConnection) => {
    context.signal.throwIfAborted();
    const stops: (void | (() => void))[] = [];
    let closed = false;
    const close = (): void => {
      if (closed) return;
      closed = true;
      context.signal.removeEventListener("abort", close);
      try { stops[1]?.(); } finally { stops[0]?.(); }
    };
    context.signal.addEventListener("abort", close, { once: true });
    const start = (connect: NonNullable<BindingDefinition<H>["connect"]>, index: number) => {
      try {
        return Promise.resolve(connect(host, context)).then(cleanup => {
          if (cleanup !== undefined && typeof cleanup !== "function") throw new TypeError("A component connect must return cleanup or undefined.");
          if (closed) cleanup?.(); else stops[index] = cleanup;
        });
      } catch (error) { return Promise.reject(error); }
    };
    return Promise.all([start(common, 0), start(local, 1)]).then(() => close, error => { close(); throw error; });
  };
}

/** HTMLKit composition only; the binding library retains instance, source and activation ownership. */
export function componentModule<H extends BindingHost>(common: ComponentBindingModule<H> = {}, local: ComponentBindingModule<H> = {}, deferClientReads = false): BindingModule<H> {
  return { create() {
    const base = definition(common); const environment = definition(local);
    const props: Record<string, Partial<BindingProvider<any, any, any, any>> | false> = { ...base.props };
    for (const [name, patch] of Object.entries(environment.props ?? {})) {
      if (patch !== false && (patch === null || typeof patch !== "object" || Array.isArray(patch))) throw new TypeError(`Binding ${name} must be a provider or false.`);
      const previous = props[name];
      props[name] = patch === false ? false : { ...previous === false ? {} : previous, ...patch };
    }
    if (deferClientReads) for (const [name, provider] of Object.entries(props)) {
      if (provider !== false && provider.load === undefined && provider.subscribe === undefined) props[name] = {
        ...provider, initial: provider.initial === "manual" ? "manual" : "browser",
        load() { throw new TypeError(`Binding ${name} has no server reader.`); },
      };
    }
    const connect = connectModules(base.connect, environment.connect);
    return { props: props as NonNullable<BindingDefinition<H>["props"]>, ...connect === undefined ? {} : { connect } };
  } };
}

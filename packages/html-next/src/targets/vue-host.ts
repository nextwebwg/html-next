/**
 * The one module every converted Vue component shares: the controller host and the event dispatcher.
 * Both are the same for every component, so they ship once beside the components rather than being
 * repeated in each `<script setup>`; only a component's own values, refs, and event types are
 * generated. It depends on Vue alone.
 */
import { formatVue } from "./vue-format.js";

/** Where the shared module sits, relative to the package root, and how a component imports it. */
export const VUE_HOST_PATH = "vue/host.ts";
export const VUE_HOST_SPECIFIER = "./host";

/** Whether a converted component imports the shared module, so a build knows to ship it. */
export function importsVueHost(source: string): boolean {
  return new RegExp(`from ['"]${VUE_HOST_SPECIFIER}['"]`).test(source);
}

const SOURCE = `
import { computed, onBeforeUnmount, onMounted, shallowRef, watchEffect } from "vue";

/** A reactive value the host reads: Vue's ref, shallowRef, computed, and useTemplateRef all match. */
export interface Readable<T> {
  readonly value: T;
}

export interface ComponentHostOptions {
  /** The component's root element. */
  readonly root: Readable<HTMLElement | null>;
  /** Dispatches a declared component event. */
  readonly dispatch: (name: string, detail?: unknown) => boolean;
  /** The component's props, which a controller reads through \`host.state\`. */
  readonly props?: Readonly<Record<string, unknown>>;
  /** Template refs, by the ref name the component declared. */
  readonly refs?: Readonly<Record<string, Readable<HTMLElement | null>>>;
  /** Declared state, which a controller reads and writes. */
  readonly state?: Readonly<Record<string, { value: any }>>;
  /** Declared computed values, which a controller reads. */
  readonly computed?: Readonly<Record<string, Readable<unknown>>>;
}

/**
 * The controller host, built from Vue refs, effects, and lifecycle. Reads and writes reach the
 * component's own refs, so a controller's change renders as any other Vue change does, and the
 * effects and listeners it opens close when the component unmounts.
 */
export function useComponentHost(
  controller: ((host: never) => unknown) | undefined,
  options: ComponentHostOptions,
) {
  const { root, dispatch, props, refs = {}, state = {}, computed: computedValues = {} } = options;
  const stops: Array<() => void> = [];
  const read = (name: string): unknown =>
    Object.hasOwn(state, name)
      ? state[name]!.value
      : Object.hasOwn(computedValues, name)
      ? computedValues[name]!.value
      : props?.[name];
  const host = {
    get element(): Element {
      return root.value as Element;
    },
    state: new Proxy({} as Record<string, unknown>, {
      get: (_target, name) => typeof name === "string" ? read(name) : undefined,
      set: (_target, name, value) => {
        if (typeof name !== "string" || !Object.hasOwn(state, name)) {
          throw new TypeError(\`Only declared state is writable; \\\`\${String(name)}\\\` is not.\`);
        }
        state[name]!.value = value;
        return true;
      },
    }),
    refs: Object.defineProperties(
      {},
      Object.fromEntries(
        Object.entries(refs).map(([name, ref]) => [name, { enumerable: true, get: () => ref.value as Element }]),
      ),
    ) as Readonly<Record<string, Element>>,
    elements: new Proxy({} as Record<string, Element | RadioNodeList | undefined>, {
      get: (_target, name) => {
        if (typeof name !== "string" || root.value === null) return undefined;
        const form = root.value instanceof HTMLFormElement ? root.value : root.value.querySelector("form");
        return form?.elements.namedItem(name) ?? root.value.querySelector(\`[name="\${CSS.escape(name)}"]\`) ?? undefined;
      },
    }),
    signal<T>(initialValue: T) {
      // shallowRef holds the controller's own value and notifies only when it changes.
      const value = shallowRef(initialValue);
      return {
        get: (): T => value.value,
        set: (next: T): void => {
          value.value = next;
        },
        update: (next: (current: T) => T): void => {
          value.value = next(value.value);
        },
      };
    },
    computed<T>(compute: () => T) {
      const value = computed(compute);
      return { get: (): T => value.value };
    },
    effect(run: () => void | (() => void)): () => void {
      const stop = watchEffect((onCleanup) => {
        const cleanup = run();
        if (typeof cleanup === "function") onCleanup(cleanup);
      }, { flush: "post" });
      stops.push(stop);
      return stop;
    },
    on(event: string, listener: EventListener): () => void {
      const element = root.value;
      element?.addEventListener(event, listener);
      const off = (): void => element?.removeEventListener(event, listener);
      stops.push(off);
      return off;
    },
    dispatch,
  };

  let cleanup: void | (() => void);
  let started: Promise<void> | undefined;
  onMounted(() => {
    started = Promise.resolve(controller?.(host as never)).then((result) => {
      if (typeof result === "function") cleanup = result as () => void;
    });
  });
  onBeforeUnmount(() => {
    for (const stop of stops.splice(0)) stop();
    if (typeof cleanup === "function") cleanup();
  });
  /** \`ready\` settles once the controller has started; a method exposed by the component awaits it. */
  return { host, ready: (): Promise<void> | undefined => started };
}

export interface DispatchOptions {
  /** Each declared event's bubbles, composed, and cancelable. */
  readonly declared?: Readonly<Record<string, EventInit>>;
  /** Each declared event's detail check, from its declared type. */
  readonly checks?: Readonly<Record<string, (detail: unknown) => boolean>>;
  /** Props an event's detail reports, which also emit \`update:<prop>\` for \`v-model:<prop>\`. */
  readonly modeled?: readonly string[];
}

/** Dispatches a component event to Vue listeners and, for controllers and page code, on the root. */
export function createDispatch(
  root: Readable<HTMLElement | null>,
  emit?: (name: string, detail: unknown) => void,
  options: DispatchOptions = {},
): (name: string, detail?: unknown) => boolean {
  const { declared = {}, checks = {}, modeled = [] } = options;
  // One change can be reported by more than one event — a choice is both a select and a change —
  // and each carries the new value. The prop updates once per change: a value already reported in
  // this turn of the event loop is not reported again.
  const reported = new Map<string, unknown>();
  return (name, detail) => {
    const check = checks[name];
    if (detail !== undefined && check !== undefined && !check(detail)) {
      throw new TypeError(\`HR002: Event \\\`\${name}\\\` detail does not satisfy its declared type.\`);
    }
    emit?.(name, detail);
    if (detail !== null && typeof detail === "object") {
      for (const prop of modeled) {
        if (!(prop in detail)) continue;
        const value = (detail as Record<string, unknown>)[prop];
        if (reported.has(prop) && Object.is(reported.get(prop), value)) continue;
        if (reported.size === 0) queueMicrotask(() => reported.clear());
        reported.set(prop, value);
        emit?.(\`update:\${prop}\`, value);
      }
    }
    return root.value?.dispatchEvent(
      new CustomEvent(name, { bubbles: true, composed: true, ...declared[name], detail }),
    ) ?? true;
  };
}
`;

/** The shared module's source, formatted the way the converted components are. */
export function vueHostModule(version: string): string {
  return formatVue(`// Generated by HTML Next ${version} for Vue 3.5. Do not edit.\n${SOURCE.trimStart()}`, "host.ts");
}

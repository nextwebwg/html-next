import { computed as tansuComputed, get, writable } from "@amadeus-it-group/tansu";
import { computed as angularComputed, signal as angularSignal } from "@angular/core";
import { createWatch, type Watch } from "@angular/core/primitives/signals";
import { computed as preactComputed, effect as preactEffect, signal as preactSignal } from "@preact/signals-core";
import { reactive, stabilize } from "@reactively/core";
import { abortVar, atom, batch as reatomBatch, computed as reatomComputed, context, effect as reatomEffect } from "@reatom/core";
import { createEffect as xEffect, createMemo as xMemo, createRoot as xRoot, createSignal as xSignal, flushSync } from "@solidjs/signals";
import { computed as alienComputed, effect as alienEffect, effectScope, signal as alienSignal } from "alien-signals";
import { c as anodFactory, root as anodRoot, signal as anodSignal } from "anod";
import { autorun, computed as mobxComputed, observable, runInAction } from "mobx";
// Pota's package entry loads browser globals, while this benchmark runs in Node.
import * as pota from "pota/src/lib/reactivity/primitives/solid.js";
import S from "s-js";
import { Signal as PolyfillSignal } from "signal-polyfill";
// Node resolves Solid's default export to its server build, so use the client runtime explicitly.
// @ts-expect-error Solid does not expose declarations for this conditional runtime file.
import * as solid from "solid-js/dist/solid.cjs";
// @ts-expect-error Svelte's benchmark adapter intentionally exercises its internal signal runtime.
import * as svelte from "svelte/internal/client";
import { computed as vueComputed, onEffectCleanup, ReactiveEffect, ref } from "@vue/reactivity";

export interface BenchmarkSignal<T> {
  readonly read: () => T;
  readonly write: (value: T) => void;
}

export interface BenchmarkComputed<T> {
  readonly read: () => T;
}

export interface BenchmarkFramework {
  readonly name: string;
  readonly signal: <T>(initialValue: T) => BenchmarkSignal<T>;
  readonly computed: <T>(compute: () => T) => BenchmarkComputed<T>;
  readonly effect: (run: () => void | (() => void)) => () => void;
  readonly run: (run: () => void) => void;
}

function alienSignals(): BenchmarkFramework {
  return {
    name: "alien-signals",
    signal(initialValue) {
      const value = alienSignal(initialValue);
      return { read: () => value(), write: (next) => value(next) };
    },
    computed(compute) {
      const value = alienComputed(compute);
      return { read: () => value() };
    },
    effect: alienEffect,
    run(run) {
      effectScope(run)();
    },
  };
}

function preactSignals(): BenchmarkFramework {
  return {
    name: "@preact/signals-core",
    signal(initialValue) {
      const value = preactSignal(initialValue);
      return { read: () => value.value, write: (next) => { value.value = next; } };
    },
    computed(compute) {
      const value = preactComputed(compute);
      return { read: () => value.value };
    },
    effect: preactEffect,
    run: (run) => run(),
  };
}

function reactively(): BenchmarkFramework {
  let owned: unknown[] = [];
  return {
    name: "@reactively/core",
    signal(initialValue) {
      const value = reactive(initialValue);
      owned.push(value);
      return {
        read: () => value.value,
        write(next) {
          value.value = next;
          stabilize();
        },
      };
    },
    computed(compute) {
      const value = reactive(compute);
      owned.push(value);
      return { read: () => value.value };
    },
    effect(run) {
      const value = reactive(run, { effect: true });
      owned.push(value);
      stabilize();
      return () => {
        const node = value as unknown as { effect: boolean; removeParentObservers(): void };
        node.effect = false;
        node.removeParentObservers();
      };
    },
    run(run) {
      try {
        run();
      } finally {
        for (const value of owned) {
          const node = value as { effect: boolean; removeParentObservers(): void; state: number };
          node.effect = false;
          node.state = 0;
          try { node.removeParentObservers(); } catch { /* cleanup is best effort */ }
        }
        owned = [];
        try { stabilize(); } catch { /* cleanup is best effort */ }
      }
    },
  };
}

function tansu(): BenchmarkFramework {
  return {
    name: "tansu",
    signal(initialValue) {
      const value = writable(initialValue);
      return { read: () => get(value), write: (next) => value.set(next) };
    },
    computed(compute) {
      const value = tansuComputed(compute);
      return { read: () => get(value) };
    },
    effect(run) {
      const value = tansuComputed(run);
      return value.subscribe(() => undefined);
    },
    run: (run) => run(),
  };
}

function signalPolyfill(): BenchmarkFramework {
  let enqueue = true;
  const watcher = new PolyfillSignal.subtle.Watcher(() => {
    if (!enqueue) return;
    enqueue = false;
    queueMicrotask(flush);
  });
  function flush(): void {
    enqueue = true;
    for (const value of watcher.getPending()) {
      try { value.get(); } catch { /* benchmark surfaces its own correctness failures */ }
    }
    watcher.watch();
  }
  return {
    name: "signal-polyfill (TC39)",
    signal(initialValue) {
      const value = new PolyfillSignal.State(initialValue);
      return { read: () => value.get(), write(next) { value.set(next); flush(); } };
    },
    computed(compute) {
      const value = new PolyfillSignal.Computed(compute);
      return { read: () => value.get() };
    },
    effect(run) {
      let cleanup: void | (() => void);
      const value = new PolyfillSignal.Computed(() => {
        cleanup?.();
        cleanup = run();
      });
      watcher.watch(value);
      value.get();
      return () => {
        watcher.unwatch(value);
        cleanup?.();
      };
    },
    run: (run) => run(),
  };
}

function vueReactivity(): BenchmarkFramework {
  return {
    name: "@vue/reactivity",
    signal(initialValue) {
      const value = ref(initialValue);
      return { read: () => value.value as typeof initialValue, write: (next) => { value.value = next; } };
    },
    computed(compute) {
      const value = vueComputed(compute);
      return { read: () => value.value };
    },
    effect(run) {
      const value = new ReactiveEffect(() => {
        const cleanup = run();
        if (cleanup !== undefined) onEffectCleanup(cleanup);
      });
      value.scheduler = () => {
        if (value.dirty) value.run();
      };
      value.run();
      return () => value.stop();
    },
    run: (run) => run(),
  };
}

function mobx(): BenchmarkFramework {
  return {
    name: "mobx",
    signal(initialValue) {
      const value = observable.box(initialValue);
      return { read: () => value.get(), write: (next) => runInAction(() => value.set(next)) };
    },
    computed(compute) {
      const value = mobxComputed(compute);
      return { read: () => value.get() };
    },
    effect: autorun,
    run: (run) => run(),
  };
}

function reatom(): BenchmarkFramework {
  return {
    name: "@reatom/core",
    signal(initialValue) {
      const value = atom(initialValue);
      return {
        read: () => value(),
        write: (next) => reatomBatch(() => value.set(next), true),
      };
    },
    computed(compute) {
      const value = reatomComputed(() => reatomBatch(compute));
      return { read: value };
    },
    effect(run) {
      return reatomEffect(() => {
        const cleanup = reatomBatch(run);
        if (cleanup !== undefined) abortVar.subscribe(cleanup);
      }).unsubscribe;
    },
    run(run) {
      try { context.start(run); } finally { context.reset(); }
    },
  };
}

function svelteSignals(): BenchmarkFramework {
  return {
    name: "svelte",
    signal(initialValue) {
      const value = svelte.state(initialValue);
      return { read: () => svelte.get(value), write(next) { svelte.set(value, next); svelte.flush(); } };
    },
    computed(compute) {
      const value = svelte.derived(compute);
      return { read: () => svelte.get(value) };
    },
    effect(run) {
      return svelte.effect_root(() => svelte.render_effect(run));
    },
    run(run) {
      const dispose = svelte.effect_root(run);
      svelte.flush();
      dispose();
    },
  };
}

function solidSignals(): BenchmarkFramework {
  return {
    name: "solid-js",
    signal(initialValue) {
      const [read, write] = solid.createSignal(initialValue);
      return { read, write };
    },
    computed(compute) {
      return { read: solid.createMemo(compute) };
    },
    effect(run) {
      let dispose = (): void => undefined;
      solid.createRoot((stop: () => void) => {
        dispose = stop;
        solid.createComputed(() => {
          const cleanup = run();
          if (cleanup !== undefined) solid.onCleanup(cleanup);
        });
      });
      return dispose;
    },
    run(run) {
      solid.createRoot((dispose: () => void) => { run(); dispose(); });
    },
  };
}

function solidXSignals(): BenchmarkFramework {
  return {
    name: "@solidjs/signals",
    signal(initialValue) {
      const [read, write] = xSignal(initialValue as never);
      return {
        read: read as () => typeof initialValue,
        write(value) {
          (write as (value: typeof initialValue) => void)(value);
          try { flushSync(); } catch { /* no pending work */ }
        },
      };
    },
    computed(compute) {
      return { read: xMemo(compute) };
    },
    effect(run) {
      let dispose = (): void => undefined;
      xRoot((stop) => {
        dispose = stop;
        xEffect(() => {
          run();
          return undefined;
        }, () => undefined);
        flushSync();
      });
      return dispose;
    },
    run(run) {
      xRoot((dispose) => { run(); flushSync(); dispose(); });
    },
  };
}

function sjs(): BenchmarkFramework {
  interface SApi {
    <T>(compute: () => T): () => T;
    cleanup(cleanup: () => void): void;
    data<T>(value: T): { (): T; (next: T): T };
    root(run: (dispose: () => void) => void): void;
  }
  const sApi = S as unknown as SApi;
  return {
    name: "S.js",
    signal(initialValue) {
      const value = sApi.data(initialValue);
      return { read: () => value(), write: (next) => value(next) };
    },
    computed(compute) {
      const value = sApi(compute);
      return { read: () => value() };
    },
    effect(run) {
      let dispose = (): void => undefined;
      sApi.root((stop) => {
        dispose = stop;
        sApi(() => {
          const cleanup = run();
          if (cleanup !== undefined) sApi.cleanup(cleanup);
        });
      });
      return dispose;
    },
    run(run) {
      sApi.root((dispose) => { run(); dispose(); });
    },
  };
}

function potaSignals(): BenchmarkFramework {
  const { signal, memo, renderEffect, root, cleanup } = pota as unknown as {
    signal<T>(value: T): readonly [() => T, (next: T) => void];
    memo<T>(compute: () => T): () => T;
    renderEffect(run: () => void): void;
    root(run: (dispose: () => void) => void): void;
    cleanup(run: () => void): void;
  };
  return {
    name: "pota",
    signal(initialValue) {
      const [read, write] = signal(initialValue);
      return { read, write };
    },
    computed(compute) {
      return { read: memo(compute) };
    },
    effect(run) {
      let dispose = (): void => undefined;
      root((stop) => {
        dispose = stop;
        renderEffect(() => {
          const next = run();
          if (next !== undefined) cleanup(next);
        });
      });
      return dispose;
    },
    run(run) {
      root((dispose) => { run(); dispose(); });
    },
  };
}

function angularSignals(): BenchmarkFramework {
  const queue = new Set<Watch>();
  const flush = (): void => {
    for (const watch of queue) {
      queue.delete(watch);
      watch.run();
    }
  };
  return {
    name: "@angular/core",
    signal(initialValue) {
      const value = angularSignal(initialValue);
      return { read: () => value(), write(next) { value.set(next); flush(); } };
    },
    computed(compute) {
      const value = angularComputed(compute);
      return { read: () => value() };
    },
    effect(run) {
      let cleanup: void | (() => void);
      let watch: Watch;
      watch = createWatch(() => {
        cleanup?.();
        cleanup = run();
      }, () => queue.add(watch), true);
      watch.run();
      return () => { watch.destroy(); cleanup?.(); };
    },
    run: (run) => run(),
  };
}

function anodSignals(): BenchmarkFramework {
  let currentContext: { val(value: unknown): unknown } | undefined;
  let currentFactory: typeof anodFactory | { compute: typeof anodFactory.compute; effect: typeof anodFactory.effect } = anodFactory;
  return {
    name: "anod",
    signal(initialValue) {
      const value = anodSignal(initialValue);
      return {
        read: () => currentContext === undefined ? value.get() : currentContext.val(value) as typeof initialValue,
        write: (next) => value.set(next),
      };
    },
    computed(compute) {
      const value = currentFactory.compute((contextValue: typeof currentContext) => {
        const previous = currentContext;
        currentContext = contextValue;
        try { return compute(); } finally { currentContext = previous; }
      });
      return { read: () => currentContext === undefined ? value.get() : currentContext.val(value) as ReturnType<typeof compute> };
    },
    effect(run) {
      const value = currentFactory.effect((contextValue: typeof currentContext & { cleanup(run: () => void): void }) => {
        const previousContext = currentContext;
        const previousFactory = currentFactory;
        currentContext = contextValue;
        currentFactory = contextValue as unknown as typeof currentFactory;
        try {
          const cleanup = run();
          if (cleanup !== undefined) contextValue.cleanup(cleanup);
        } finally {
          currentContext = previousContext;
          currentFactory = previousFactory;
        }
      });
      return () => value.dispose();
    },
    run(run) {
      anodRoot((contextValue) => {
        const previous = currentFactory;
        currentFactory = contextValue;
        try { run(); } finally { currentFactory = previous; }
      });
    },
  };
}

export const thirdPartyFrameworks: readonly (() => BenchmarkFramework)[] = [
  alienSignals,
  preactSignals,
  reactively,
  tansu,
  signalPolyfill,
  vueReactivity,
  mobx,
  reatom,
  svelteSignals,
  solidSignals,
  solidXSignals,
  sjs,
  potaSignals,
  angularSignals,
  anodSignals,
];

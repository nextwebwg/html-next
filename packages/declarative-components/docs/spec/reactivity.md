# Reactivity, handlers, and data

## Reactive declarations

State is per component instance. Computed values are pure expressions over declared dependencies.
Creating a computed value does not evaluate it. A direct read evaluates and caches it; repeated reads
reuse that cache until a dependency changes. A dependency change only marks an unobserved computed
value dirty. Computed values feeding a connected render or effect refresh in dependency order during
the next microtask flush. A chain may refresh to establish its final value, but an equal final value
does not rerun the consuming render or effect.
Consequently, a computed declaration that is never read or rendered performs no computation.

External property changes, controller writes, control bindings, data transitions, and declarative handlers enter the same scheduler. Disconnect runs owned cleanup. Reconnection creates no duplicate listener, observer, timer, or request.

One change set may propagate through at most 100 dependency-ordered queue rounds. Crossing that
depth clears pending work and reports `HR006`. Cyclic write graphs therefore terminate with a
stable diagnostic while independent wide fan-out continues normally. This bounds causality depth,
not the number of independent effects in one round.

## Structural regions

Conditional, match, `with`, and list constructs own bounded DOM ranges. A keyed list preserves node and component identity by key during insertion, deletion, filtering, sorting, and reordering. A removed branch disposes its effects and controller lifetime. Loop locals cannot escape their region.

## Handlers and lifecycle

Named handlers contain an ordered set of declarative guard, state-write, validation, focus, and dispatch steps. Event modifiers define capture, passive, once, default prevention, propagation, button, and key filtering without embedding JavaScript in markup.

`on:connect` runs after the lowered or hydrated root is connected and runs again after a later reconnection. `on:disconnect` runs before owned effects and listeners are paused. Lifecycle attributes are consumed by the runtime and are not emitted as executable HTML attributes.

Controllers receive a host adapter for declared props, state, refs, named native form controls, dispatch, effects, connection, and cleanup. `connect`, `disconnect`, and adopted/hydrated lifecycle hooks use that same adapter in browser and generated targets.

The controller is the default export of the ES module named by the owning `template[component]`. The platform supplies the host when the instance connects; controller source does not import a platform library or register a tag.

Browser mutation discovery applies this lifecycle to instances and inline definitions added after boot. Newly lowered or reconnected roots connect once; removed roots disconnect and dispose owned effects, listeners, timers, and pending work. A definition becoming available after its invocation must trigger the same lowering and connection sequence. The observer ignores its own completed work and preserves a connection for moves that remain inside the same document within one mutation batch. Generated/AOT targets express these transitions through their target lifecycle and do not install a discovery `MutationObserver`.

Hydration discovers a server root through its `data-component-root` lineage and reconstructs props from their canonical `data-*` reflection. A compatible root is adopted rather than replaced. A repairable mismatch is reconciled only inside the component-authored range while projected nodes and compatible focused controls retain identity, live values, selection, and focus. When safe bounded repair cannot establish the expected structure, the server DOM remains inert, the controller does not run, and `HR005` is reported.

## Controller host and effects

The controller host exposes the connected invocation as `host.element`; a live read view as
`host.state`; declared `$ref` elements as `host.refs`; named native form controls as `host.elements`;
and `host.signal`, `host.computed`, `host.on`, `host.effect`, and `host.dispatch` operations.
`host.signal(initialValue)` creates component-local writable reactive state. `host.computed(callback)`
creates a lazy cached getter whose dependencies are the signals, computed getters, and `host.state`
paths read during its latest evaluation. Both participate in `host.effect` dependency tracking, and
computed values are paused, resumed, and disposed with the component. These primitives let ordinary
ES modules build lifecycle-owned controller composables without importing a second reactive runtime.
Signals own no scheduled work; their storage remains readable while disconnected. Pausing a computed
removes its subscriptions and automatic work, while an explicit `get()` still performs an untracked
read. Reconnection makes the next tracked read rebuild the dependency set.
`host.state` reads props, state, declarative computed values, and resources, but only paths rooted at
a declared `state` are writable. Controller-local signals do not silently create template identifiers;
a controller must explicitly project them into names declared by the component when template access
is required. Page code cannot retrieve the private host through the component element.

`host.effect(callback)` exists for effects on systems outside runtime-owned DOM, such as charts, observers, media objects, and imperative native APIs. Declarative template bindings subscribe directly to their compiled dependencies and do not run through controller effects.

An effect runs once while connecting and tracks the `host.state` paths read during its most recent successful run. A dependency change marks it dirty; repeated writes coalesce, and it reruns in the ordered microtask flush after state and computed values settle. If the callback returns a disposer, that disposer runs before rerun. Disconnection runs the current disposer, removes observations, and prevents detached work. Reconnection runs the effect once and establishes a fresh dependency set. The stop function returned by `host.effect` performs the same cleanup permanently and is idempotent.

### Resource composables

Controller-local primitives are sufficient for an SWR-style resource without making requests part
of computed evaluation. The computed request key remains lazy and pure; the effect owns the request
and returns its cancellation; signals publish the request state.

```ts
import type {
  ComponentHost,
  ControllerComputed,
  ControllerSignal,
} from "@nextwebwg/declarative-components/runtime";

interface Resource<T> {
  readonly data: ControllerSignal<T | undefined>;
  readonly error: ControllerSignal<unknown | undefined>;
  readonly isValidating: ControllerSignal<boolean>;
  readonly isLoading: ControllerComputed<boolean>;
  mutate(): void;
}

function useResource<T>(
  host: ComponentHost,
  key: ControllerComputed<string | null>,
  fetcher: (url: string, signal: AbortSignal) => Promise<T>,
): Resource<T> {
  const data = host.signal<T | undefined>(undefined);
  const error = host.signal<unknown | undefined>(undefined);
  const isValidating = host.signal(false);
  const hasValue = host.signal(false);
  const revision = host.signal(0);
  const isLoading = host.computed(() => isValidating.get() && !hasValue.get());

  host.effect(() => {
    revision.get();
    const url = key.get();
    if (url === null) {
      isValidating.set(false);
      return;
    }

    const request = new AbortController();
    let live = true;
    isValidating.set(true);
    error.set(undefined);
    void fetcher(url, request.signal).then((value) => {
      if (!live) return;
      data.set(value);
      hasValue.set(true);
    }, (reason: unknown) => {
      if (live) error.set(reason);
    }).finally(() => {
      if (live) isValidating.set(false);
    });

    return () => {
      live = false;
      request.abort();
    };
  });

  return {
    data,
    error,
    isValidating,
    isLoading,
    mutate: () => revision.update((value) => value + 1),
  };
}
```

A component controller derives the key from declared inputs and explicitly projects the resource
into state roots that its template is allowed to read:

```ts
export default function controller(host: ComponentHost) {
  const key = host.computed(() => {
    const query = String(host.state.query ?? "").trim();
    return query === "" ? null : `/api/search?q=${encodeURIComponent(query)}`;
  });
  const result = useResource(host, key, async (url, signal) => {
    const response = await fetch(url, { signal });
    if (!response.ok) throw new Error(`Search failed (${response.status})`);
    return await response.json() as readonly SearchResult[];
  });

  host.effect(() => {
    host.state.results = result.data.get() ?? [];
    host.state.loading = result.isLoading.get();
    host.state.refreshing = result.isValidating.get();
    const error = result.error.get();
    host.state.error = error instanceof Error ? error.message : null;
  });
}
```

`query`, `results`, `loading`, `refreshing`, and `error` are declared prop or state roots in the
component definition. That explicit bridge preserves declaration validation and keeps controller
locals private. Shared stale-value caching and request deduplication belong in the composable's
module-level cache; they do not require a second reactive runtime or a different host contract.

The public contract exposes values and lifetime-bound reactions, not raw `Signal.State`, `Signal.Computed`, or `Signal.Watcher` objects. A runtime may use TC39 Signals internally, but signal identity and APIs are not observable and cannot bypass declared writability, types, or connection ownership.

## Data resources

A declared read serializes URI-template and query parameters, cancels stale work, and exposes `pending`, `value`, `error`, and `ok`. Debounce and polling use owned timers and stop on disconnect. The core decodes the response without imposing an application schema. A host-provided adapter may validate, coerce, or project the decoded value before publication; a thrown adapter error becomes the resource error and no value is published.

## Native form participation

Form controls authored by a component remain native controls. When a component instance is inside an author-owned `form`, its rendered controls participate in that form through the platform's normal form-owner, successful-controls, validation, and submission behavior. A component may also render a complete native form when that is its public purpose.

```html conforming
<form action="/posts" method="post">
  <x-slug-field></x-slug-field>
  <button type="submit">Save post</button>
</form>
```

If `x-slug-field` renders `<input name="slug">`, that control belongs to the outer form without the component creating, finding, or submitting a second form.

The HTML Forms proposal defines optional request enhancement as a separate package and contract. An application can apply that enhancement to a form containing component-rendered controls without making Declarative Components depend on Forms.

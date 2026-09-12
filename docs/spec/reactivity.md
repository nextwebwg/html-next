# Reactivity, handlers, data, and forms

## Reactive declarations

State is per component instance. Computed values are pure expressions over declared dependencies. Synchronous writes mark dependent computations and effects dirty; one microtask flush evaluates them in dependency order and updates each dirty effect once.

External property changes, controller writes, form/input bindings, data transitions, and declarative handlers enter the same scheduler. Disconnect runs owned cleanup. Reconnection creates no duplicate listener, observer, timer, or request.

## Structural regions

Conditional, match, `with`, and list constructs own bounded DOM ranges. A keyed list preserves node and component identity by key during insertion, deletion, filtering, sorting, and reordering. A removed branch disposes its effects and controller lifetime. Loop locals cannot escape their region.

## Handlers and lifecycle

Named handlers contain an ordered set of declarative guard, state-write, validation, focus, and dispatch steps. Event modifiers define capture, passive, once, default prevention, propagation, button, and key filtering without embedding JavaScript in markup.

Controllers receive a host adapter for declared props, state, refs, named native form controls, dispatch, effects, connection, and cleanup. `connect`, `disconnect`, and adopted/hydrated lifecycle hooks use that same adapter in browser and generated targets.

Hydration adopts a provenance-compatible server tree. A repairable mismatch is reconciled only inside the component-authored range while projected nodes and compatible focused controls retain identity, live values, selection, and focus. When safe bounded repair cannot establish the expected structure, the server DOM remains inert, the controller does not run, and a diagnostic is reported.

## Controller host and effects

The controller host exposes the connected invocation as `host.element`; a live read view as `host.state`; declared `$ref` elements as `host.refs`; named native form controls as `host.elements`; and `host.on`, `host.effect`, and `host.dispatch` operations. `host.state` reads props, state, computed values, and resources, but only paths rooted at a declared `state` are writable. Page code cannot retrieve the private host through the component element.

`host.effect(callback)` exists for effects on systems outside runtime-owned DOM, such as charts, observers, media objects, and imperative native APIs. Declarative template bindings subscribe directly to their compiled dependencies and do not run through controller effects.

An effect runs once while connecting and tracks the `host.state` paths read during its most recent successful run. A dependency change marks it dirty; repeated writes coalesce, and it reruns in the ordered microtask flush after state and computed values settle. If the callback returns a disposer, that disposer runs before rerun. Disconnection runs the current disposer, removes observations, and prevents detached work. Reconnection runs the effect once and establishes a fresh dependency set. The stop function returned by `host.effect` performs the same cleanup permanently and is idempotent.

The public contract exposes values and lifetime-bound reactions, not raw `Signal.State`, `Signal.Computed`, or `Signal.Watcher` objects. A runtime may use TC39 Signals internally, but signal identity and APIs are not observable and cannot bypass declared writability, types, or connection ownership.

## Data and forms

A declared read serializes URI-template and query parameters, cancels stale work, and exposes `pending`, `value`, `error`, and `ok`. Debounce and polling use owned timers and stop on disconnect. Typed response validation happens before the value becomes observable.

Enhanced forms preserve the native successful-controls set, submitter, validation, method, encoding, and navigation fallback. Enhancement is additive: when the runtime or request fails before interception, the native submission remains usable. An enhanced request participates in cancellation and exposes the same state shape as a declared read.

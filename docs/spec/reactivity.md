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

## Data and forms

A declared read serializes URI-template and query parameters, cancels stale work, and exposes `pending`, `value`, `error`, and `ok`. Debounce and polling use owned timers and stop on disconnect. Typed response validation happens before the value becomes observable.

Enhanced forms preserve the native successful-controls set, submitter, validation, method, encoding, and navigation fallback. Enhancement is additive: when the runtime or request fails before interception, the native submission remains usable. An enhanced request participates in cancellation and exposes the same state shape as a declared read.

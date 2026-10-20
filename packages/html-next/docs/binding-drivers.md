# Binding driver API

`@nextwebwg/html-next/bindings` is a JavaScript library over the renderer's typed input SDK. It owns data-source policy; the [public component proposal](https://nextwebwg.org/declarative-components/) defines component syntax and browser lifecycle. Importing the library loads no renderer, component parser, or server implementation.

## A browser module

`bindModule` returns an ordinary named `connect` function. Export it from the module referenced by a component's `module` attribute:

```ts
import { bindModule, type BindingProvider } from '@nextwebwg/html-next/bindings';

type Product = { name: string };
const product: BindingProvider<{ productId: number }, number, Product> = {
  input: ({ productId }) => productId,
  async load(id, { fetch, signal }) {
    const response = await fetch(`/api/products/${id}`, { signal });
    if (!response.ok) throw new Error('Product unavailable');
    return response.json();
  },
};

export const { connect } = bindModule({
  props: { product },
  connect(_host, { signal, refresh }) {
    window.addEventListener('online', () => { void refresh('product'); }, { signal });
  },
});
```

The output name identifies a declared prop. Caller-supplied inputs bypass that prop's provider, including its selectors and subscriptions. A declared default remains available while the provider works. A null input resolves through that default; it still counts as supplied when it comes from the caller. An undefined caller update releases ownership.

The synchronous `input` selector captures the inputs a read needs. `load` receives an isolated copy and an operation signal. Reading the selector's retained props object later in `load` is an error. Its returned value passes through the renderer's existing type checks and validity boundary.

Selectors stop when they read an unavailable declaration; they do not receive a placeholder outside its declared type. They can run again before a request is sent or its result is published, so keep them free of effects. These checks refuse obsolete results even before queued observer cleanup has run. Host-supplied context getters remain getters and participate in the owning renderer's tracking.

Selectors can also read declared state, computed values and context aliases through the component's existing state namespace: `input: (_props, { state }) => state.query`. Reads follow their normal reactive dependencies and availability. An unused conditional branch does not block a read. When only a computed prerequisite's pending/error status changes, that status reaches the dependent output without another load for the same selected input. For explicit TypeScript annotations, the fourth `BindingProvider` parameter describes this state namespace.

## Instance and operation lifetimes

A module can instead supply `create()`, returning `{ props, connect }`. Use it for passive instance-local closures or memo tables. Start active work in `load`, `subscribe`, or `connect`. Mixing `create` with static `props` or `connect` is an error; asynchronous factories are also rejected.

The adapter retains the factory result and completed read identities across browser deactivation. Each activation gets a fresh signal and reacquires the current input capabilities. Deactivation cancels reads, timers and subscriptions. A late result cannot publish, and a late setup cleanup cannot stop a newer activation. Browser behavior runs while data is pending.

A behavior-only module needs no providers or typed-input adapter. Its factory and browser cleanup have the same instance and activation lifetimes; preparation produces an empty read record and does not run browser behavior.

`bindModule(source, { overrides })` replaces only named providers. `false` disables that provider. Other providers and the source module's browser behavior remain in place. Supplying ordinary component props is the simpler fixture path when no alternate supplier is needed.

## Provider policies

| Field | Behavior |
| --- | --- |
| `when` | Synchronous eligibility predicate evaluated before `input`. |
| `sample` | Synchronous data captured when an operation starts; changes do not trigger another read. |
| `initial` | `render` by default; `browser` defers initial reads to browser activation; `manual` waits for `refresh(name)`. |
| `debounce` | Delays automatic browser reads. Explicit refresh bypasses it. |
| `timeout` | Cancels the current read at its deadline. Omission or zero disables the timer. |
| `poll` | Browser interval after a read settles; reads do not overlap. Cannot accompany `initial: 'manual'`. |
| `keepPrevious` | Retains accepted data as stale when selected inputs change. |
| `revalidate` | `'activate'` requests a fresh read on browser activation. |
| `subscribe` | Browser subscription with the selected input and a guarded `publish`. May instead use `{ input, open }` for a distinct subscription selector. Returns optional cleanup, synchronously or asynchronously. |

Durations accept nonnegative milliseconds or the existing duration strings. Failed refreshes retain accepted data and expose the error. A handled failure is retried when inputs change or an explicit refresh, polling, or activation policy requests another read. Stream-only providers can omit `load`; preparation does not open browser subscriptions.

Retained stale values can remain visible, but a new dependent read waits for a current prerequisite. Polling resumes after that prerequisite becomes current. An unavailable `sample` fails the current read with `InputUnavailableError`; changing a sampled field does not retry it automatically. Subscription-selector failures appear on the binding while an independent initial load can still provide usable data.

## Application preparation and adoption

An application host that already owns a rendered component instance can prepare its providers separately from browser behavior:

```ts
const bindings = bindModule(source);
const prepared = await bindings.prepare(host, {
  phase: 'request', // or 'build'
  signal: request.signal,
  source: buildRevision,
  services: requestServices,
});
try {
  const bindingState = prepared.snapshot();
  // Transfer bindingState alongside the renderer's serialized instance record.
  // The renderer record holds accepted props, ownership and availability.
} finally {
  prepared.dispose();
}
```

Preparation never calls the module's `connect`. This primitive does not load companion files, cross a worker boundary, or implement an HTTP endpoint. Those responsibilities belong to the application host.

The returned preparation handle exposes `names`, `snapshot()` and `dispose()`. `names` lists configured
output props, including deferred reads and excluding disabled providers. An application host can use
it to distinguish a required input owned by a provider from an input with no supplier. This does not
make a pending value available or change the component's constraint validity. Dispose the preparation
in `finally`, including when serializing the renderer record fails.

On browser adoption, pass the instance's transferred state through `bindModule(source, { browser: host => ({ source: buildRevision, snapshot: stateFor(host) }) })`. Matching source revisions, selected inputs and renderer input revisions avoid duplicate reads, including handled failures. An intervening accepted fixture write invalidates the read identity even if it is released before the driver starts. Snapshots contain read identities and public failures, not another copy of accepted output data.

A host retaining an existing component can offer another preparation through `adopt`:

```ts
bindings.adopt(host, {
  snapshot: nextReadIdentities,
  inputs: nextNativeInputSnapshots,
  update: () => adoptRenderedProps(host.root, nextRenderedRoot),
});
```

The application obtains `snapshot` from the new preparation and `inputs` from the matching renderer
record: each input is its accepted value and availability status. The synchronous `update` applies
new caller props through the renderer's existing channel. Omission releases a previous caller fixture,
but leaves a producer's current value alone. HTMLKit supplies this integration automatically.

Adoption reuses the logical instance, factory, connection, and local state. A matching source revision
and current selected input allow the source to accept prepared output through the typed input SDK.
Dependent outputs wait for their native prerequisites. An existing browser attempt for the same input
stays authoritative, including live publications, pending reads, and handled failures; an older server
baseline cannot replace it. Changing inputs or explicitly refreshing requests new work. A caller-owned
value or incompatible input prevents adoption. Offering data before activation does not start browser
behavior or another read.

For a custom host integration, construct `BindingScope` with `componentInputs(host)`, provider definitions, and an explicit phase. `activate` starts ownership, `settled` waits for current reads, `deactivate` retains passive instance data, and `dispose` ends the scope permanently. `settled` does not wait for a subscription's first publication or promise that browser DOM updates have committed. `snapshot` requires an application-supplied source revision.

The input SDK distinguishes writable props (`names`) from readable props and declarations (`readNames`). `read`, `status` and synchronous `capture` can observe those declarations. Source acquisition, caller ownership and accepted-input revisions remain prop operations.

An application transport can call the operation's optional `captureInputs()` synchronously inside
`load` to obtain the prop and state declarations read by `input`, `when`, and `sample`. Unread fields
are excluded, so an unrelated opaque UI value does not prevent a private read. The captured frame
is detached data; changing a returned copy does not change the component or a later returned copy.
`captureInputs(additionalNames)` adds declared prerequisites such as a selected type's discriminator
without discarding earlier captures. Capture all required fields before awaiting. The bindings entry
also exports the existing `encodeHydrationValue` and `decodeHydrationValue` codec for a host's transfer
format. These functions do not make a browser frame trustworthy; its receiving application validates
the frame and authorizes private work independently.

# Request-time server rendering design

HTMLKit's first production adapter is static. A future request adapter should reuse the route
manifest, layout chain, loader result contract, component graph, and HTML Next rendering/adoption
path. Authored pages must not change when a route moves from prerendering to request-time delivery.
Page entry names, route patterns, and browser bundle locations stay separate in both adapters.
Named/default layout selection and `htmlkit:page` selection resolve before loader execution;
declarative head metadata belongs to each selected component carrier, is rendered from that layer's props, and is merged by the same
identity rules in either adapter. No browser head subscription is required for document navigation.
This is a tooling implementation design, not a component-language specification.

## Shared work and adapter responsibilities

`Application.fetch(request)` is the request entry point that a production adapter will build on.
Today the development server serves every page through it, and CI runs it on Deno and Bun. It still
supplies the static `prerender` context described below.

The current application pipeline already separates route matching and static entry enumeration.
`entries()` is a deployment operation; `render()` matches a concrete pathname and runs a fresh
layout/page loader chain. Both file and registered routes become the same `ApplicationRoute`.

A request adapter will compile Node loader modules into a server artifact and browser entry/CSS
maps into a client artifact. It will not run the Vite development server in production. The shared
render kernel will accept a resolved route, parameters, a context factory, and a cancellation signal.
The current static context factory supplies a canonical URL and rejects request access. A new
request factory will supply the actual URL and native `Request` with `phase: 'request'`. Extending
the public `LoadContext` to a discriminated union lets loaders narrow before using request inputs.
Existing static loaders continue to work unchanged.

```text
Request
  -> adapter validates method and deployment base
  -> manifest matches pathname, with literals before parameters
  -> fresh request context and layout/page loader results
  -> props/state serialized into standard component invocations
  -> HTML Next renderComponents in an independent DOM worker
  -> document plus prebuilt browser/CSS URLs
  -> Response (including status, headers, and cancellation policy)
```

The deployment adapter owns HTTP status/headers, host validation, cookies, redirects, errors,
request limits, and response delivery. The platform owns matching, composition, public input
serialization, and browser entry selection. HTML Next owns component semantics and each render's
DOM realm. Endpoint/action APIs, redirects returned by loaders, streaming, and adapters for edge
runtimes require later implementation decisions; this delivery invents none of those contracts.

## Isolation and public data

For simultaneous `/items/alice/` and `/items/bob/` requests, matching creates distinct parameter
objects. Each request gets its own `Request`, abort signal, parent-data chain, loader results,
invocation markup, and initial state map. HTML Next renders each in an independent worker with a
separate DOM and browser constructors. Only immutable build metadata and asset manifests may be
shared. One request's result must never enter a global route-data or rendered-output cache.

The DOM worker does **not** isolate application loader globals. Today's static/development loaders
are trusted application code and Vite caches their modules. A Node request adapter must either
enforce stateless loader modules or execute loader chains in request-isolated workers. The proposed
first adapter uses request-isolated loader workers, with a structured-clone protocol for URL,
method, approved headers, parameters, and loader results. It reconstructs a native `Request`
inside that worker. Do not pass live request bodies, privileged platform handles, or browser
controllers across that protocol. Size limits, termination on abort, and worker disposal belong
to the adapter and must be tested before it becomes production-supported. Pooling is deferred.

`data` is private to the loader chain. Only explicit `props` and `state` become public, through
the existing HTML Next type validation, attribute serialization, and rendered continuation records.
Titles, descriptions, and native metadata attributes are escaped by the document assembler. Head
bindings reuse HTML Next's parser and renderer through inert binding carriers, since actual head
elements are forbidden in component bodies. Only declared props enter that scope: browser reads,
controller execution, and mutable browser state do not become server head dependencies.
Browser entries import controllers
and parsed definitions, never server loaders or their imports. Authentication/session values must
stay in private loader data unless deliberately reduced to public presentation values.

Tests for the future adapter must prove two concurrent requests with distinct cookies and params
cannot contaminate each other's HTML, even when an application tries to store data in module
globals. They must also prove canceled requests dispose loader/render workers, private values do
not appear in HTML or browser assets, and static/request renderings with equal public input adopt
with equal observable behavior. No caching should be added before its keys and privacy policy are
explicitly reviewed.

## Native mechanisms and the remaining gap

Native `URL`, `Request`, `Response`, `fetch`, and `AbortSignal` cover URL parsing, HTTP values,
network reads, and cancellation. Native anchors and document navigation cover the first routing
experience. HTML Next already provides named-slot composition, typed props/state, isolated Node
DOM rendering, rendered continuation serialization, MutationObserver-based adoption, controller
connection/disposal, and browser read resumption. Vite supplies module resolution, TypeScript
transformation, asset bundling, and development watching.

The remaining platform layer is application policy: file/registered route discovery and matching,
layout ordering, server loader sequencing, document metadata, deployment URL composition, and
adapter output. No custom browser observer, parser, reactive scheduler, or hydration engine is
needed. Production request delivery and isolation of application loaders remain the future
adapter's concrete work; static generation does not pretend to supply a reader's request.

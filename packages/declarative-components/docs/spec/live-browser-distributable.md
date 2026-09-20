# Live browser distributable

The live browser distributable is the no-build execution mode. Linking its public entry point gives
a page the complete implemented Declarative Components capability profile for definitions and
instances that are present now or introduced later.

## Inputs and graph boundary

The page supplies trusted root definitions through inline component templates, component links, or
the public loader API. Definitions, instances, and their declared dependencies may appear after the
loader starts, so the input graph remains open for the lifetime of the document.

The loader must accept every conforming source construct in the current support profile without an
application manifest or a build-time capability inventory. Application-selected roots establish
the resource entry set; relative component resources use ordinary URL resolution while Fetch,
CORS, CSP, and native ESM enforce the platform's loading policy.

## Capability contract

One public browser entry must make the complete implemented capability profile available,
including component discovery, native-root lowering, projection, props, state, computed values,
effects, handlers, structural directives, declared requests, declared type enforcement, scoped styles,
controllers, resource graphs, and hydration.

The implementation may load an internal module only when a definition needs its capability. The
public entry still promises that any later conforming graph can obtain that capability with
deterministic CSP, loading, and failure behavior.

## Runtime ownership

The browser owns HTML parsing, inert template contents, DOM identity, selectors, events, form
controls, constraint validation for native controls, URL resolution, Fetch, native ESM, CORS, CSP,
microtask scheduling, cancellation, and connection state.

The distributable owns proposal grammar, normalized semantics, dependency tracking that the
platform does not express, structural reconciliation, component
style transformation, controller hosting, component-resource policy, stable diagnostics, and
balanced component lifecycle.

Document-wide infrastructure must be shared. Component discovery observes added nodes against the
registered component tags. Lowered roots carry the shared component-root marker used for connection
transitions. A component disconnect runs its registered cleanup once; a reconnect installs one
fresh active lifecycle without duplicating effects or handlers.

## Output artifacts

The required artifact is an ESM browser entry that starts or exposes the live loader. A release may
also publish:

- a monolithic full-capability file;
- capability chunks reached through that same public entry;
- source maps, types, and integrity metadata;
- a documented low-level loading and lifecycle API.

Internal packaging must not require authors to select a feature build for an arbitrary future
graph.

## Failure behavior

Syntax, type, graph, policy, and lifecycle failures must use the stable diagnostic codes defined by
the language modules. A definition must be validated before authored content becomes live.

Resource failures report the requested and canonical resource identity without exposing sensitive
response data. Unsupported CSP or loading conditions fail at the capability boundary that needs
them. A failed component must not leave active effects, handlers, requests, controller cleanup, or
partially registered public methods behind.

## Optimization boundary

A live-distributable reduction is valid when it applies to arbitrary future graphs and preserves
the complete capability contract. Valid techniques include composing native browser facilities,
sharing realm or document infrastructure, removing duplicate representations, improving universal
algorithms, and progressively loading complete capabilities behind the public entry.

The live result is measured independently from closed-graph feature removal. Every retained custom
subsystem must record the native mechanisms considered, the semantic gap it fills, its bundle
contribution, representative runtime cost, and any required owner decision.

## Measurement contract

The release measurement bundles the public browser entry with production minification and the
documented browser target. It reports raw and gzip bytes, module contribution metadata, and the
complete capability assertion.

Runtime measurements cover initial discovery, definition normalization, first mount, reactive
fan-out, mutation-heavy discovery, keyed movement, disconnect/reconnect cleanup, declared request
cancellation, and hydration adoption. A size win must satisfy the repository's combined size and
hot-path performance guardrail.

## Conformance scenarios

1. Start the public entry with inline and linked definitions already present; every supported
   capability mounts and updates through the live path.
2. Add a previously unseen definition and instances after startup; the loader resolves the new
   graph without a manifest or restart.
3. Detach, move, adopt, and reconnect lowered roots; identity and authored state are preserved where
   specified, and cleanup remains balanced.
4. Reject invalid resources and platform-denied loads before activation with the specified
   diagnostic and no leaked live work.
5. Hydrate server-lowered DOM while preserving node identity, edits, focus, selection, and current
   control state.

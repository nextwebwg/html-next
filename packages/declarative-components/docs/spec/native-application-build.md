# Native application or library build

The native build compiles a known application or component-library graph to native DOM modules. It
can replace an application's framework runtime or produce independently consumable library entries.

## Inputs and graph boundary

An application build receives one or more application entries. A library build receives the
public component entries and ordinary module, type, style, and asset exports the package intends to
publish.

The build follows component, controller, style, schema, and statically discoverable module edges
without executing authored code. An unknown runtime component boundary must be declared as a
universal-runtime boundary, a dynamic capability chunk, or a diagnostic condition.

## Capability contract

The compiler derives the union of language capabilities used across the complete input graph.
Application output must support every capability reachable from its entries. Library output must
support every capability reachable from each published entry while keeping those entries
independently consumable.

The generated result preserves the shared semantic model: native roots, projection, public
properties and methods, reactivity, requests, forms, validation, styles, controllers, lifecycle,
and hydration must match the live distributable for the same graph and inputs.

## Runtime ownership

Generated modules express markup, properties, events, scheduling, DOM updates, and lifecycle
directly through Web Platform facilities. Build-scoped support supplies only semantics used by the
graph that the browser does not provide directly.

The build computes support once for the graph. Component modules may import granular helpers, but
the emitted application or library must deduplicate equivalent support and preserve one uniform
public host contract. Controller authors receive the same host shape regardless of which internal
helpers the graph requires.

## Output artifacts

An application build emits executable application entries, component modules, shared support,
styles, controllers, static assets, types, and a machine-readable inventory.

A library build emits stable public entries, granular internal imports suitable for consumer
deduplication, package exports, types, styles, controllers, preserved ordinary modules, and an
inventory of direct and transitive edges. The inventory is build evidence, not a second component
authoring format.

## Failure behavior

The build must report source-located diagnostics for invalid language constructs, missing or
ambiguous entries, graph cycles that violate the resource rules, unsafe path escapes, unsupported
dynamic boundaries, and output collisions.

The compiler must not emit a partially valid public package after an error. An application may emit
diagnostic artifacts only when the command explicitly requests them. Generated runtime failures use
the same public events, error values, and cleanup rules as live execution.

## Optimization boundary

The compiler may specialize against the complete declared graph: remove unused capabilities,
precompute normalized declarations, inline constants, share support across entries, and let the
consumer bundler remove unreachable library code.

Specialization belongs to the graph, not to a claim that each component owns a separate runtime.
An isolated capability fixture attributes feature cost; it does not define the application or
library architecture. Dynamic boundaries count every capability they promise to load.

## Measurement contract

Application measurements name the entry graph, total capability union, emitted application
boundary, shared support, raw bytes, gzip bytes, build time, initial mount, reactive updates,
mutation handling, and hydration.

Library measurements report full package output and representative consumer subsets. They identify
shared support before and after consumer bundling and verify that independently imported entries do
not duplicate equivalent runtime machinery. Capability fixtures are reported in a separate
attribution group.

## Conformance scenarios

1. Build several mutually dependent application entries; their capability union emits shared
   support once and runs without the live source parser.
2. Build a library, consume one entry and then several entries, and verify stable exports plus
   bundler deduplication.
3. Compare live and native execution for the same fixtures, inputs, events, lifecycle transitions,
   errors, and hydrated DOM.
4. Include a declared dynamic boundary and verify its universal runtime or capability chunk loads
   with the specified policy and failure behavior.
5. Reject an undeclared dynamic component edge with a source-located diagnostic before publishing
   partial output.


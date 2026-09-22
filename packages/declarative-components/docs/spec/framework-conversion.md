# Framework conversion

Framework conversion translates a Declarative Components application or library graph into React,
Vue, or Svelte components while that target owns rendering, reactivity, lifecycle, and hydration.

## Inputs and graph boundary

The converter receives application entries or component-library entries, a target framework and
supported version, and output/package settings. It follows the same component, controller, style,
and static module graph as the native build.

Unknown runtime component edges require a declared target-native dynamic import, a universal
interop boundary, or a build diagnostic. The converter records the target and graph boundary in its
output inventory.

## Capability contract

Generated target components must preserve the shared semantic model: the same native root,
projected-content identity, properties (as attributes), events, methods, declared type behavior, state results,
requests, styles, lifecycle, controller behavior, and hydration outcome.

Target-native conventions may shape private implementation and generated source. They must not add
wrapper elements, change public names, substitute framework-only event semantics, or make target
objects part of the component's portable public contract.

## Runtime ownership

React, Vue, or Svelte owns its normal render scheduling, reactive dependency tracking, list
reconciliation, component lifecycle, SSR attachment, and hydration. The converter expresses the
normalized component plan through those facilities.

Converted output has **no runtime dependency on HTML Next**: it imports only the target framework
and the component's own modules (its controller and preserved ordinary modules), never an HTML Next
package, runtime, or bridge. HTML Next either runs a component itself or converts it; once converted,
it is gone. Anything the target cannot express directly is generated as target-native source in the
output, not imported:

- the controller host (`host.element`, `host.state`, `host.refs`, `host.effect`, `host.dispatch`)
  is generated per component from the target's own state, effect, event, and lifecycle facilities;
- diagnostics are reported at conversion time;
- styles compile to the target's own scoping (for Vue, `<style scoped>`), with `:host`,
  `:host-state()`, and `:slotted()` mapped by the converter.

Because the target owns the DOM, a controller used in converted output must not add or remove
nodes: it may read and write host state, set attributes, properties, and focus, and add listeners.
Structure belongs in the template, driven by state. Controllers receive the elements they need
through `host.element` and `host.refs` rather than querying the DOM.

## Output artifacts

Application conversion emits target application entries, generated components, target-native
styles or imported CSS, controller adapters, types, static assets, and an inventory.

Library conversion emits independently consumable component entries, package exports appropriate
to the target, declaration files, styles, controllers, preserved ordinary modules, and dependency
metadata. Generated source must remain compatible with the target's standard compiler and bundler
pipeline.

## Failure behavior

Conversion reports source-located diagnostics for unsupported target versions, unrepresentable
language semantics, unsafe resource edges, output collisions, and target package conflicts. It must
not silently approximate behavior.

Runtime failures preserve the shared public error, event, type, cancellation, and cleanup
contract. Target error boundaries may observe those failures but cannot replace required component
events or leave effects, requests, or controllers active after disposal.

## Optimization boundary

The converter should use target-native rendering, reactivity, lifecycle, event, list, and hydration
facilities before adding bridge code. It may specialize against the complete application or library
graph and target version.

Optimization must preserve portable public behavior. Framework package cost, generated application
code, and HTML Next bridge cost are separate quantities; excluding the target framework from the
bridge figure must be explicit.

## Measurement contract

Each result names the framework and version, application or library graph, included capabilities,
SSR and hydration mode, production compiler settings, and bundle boundary.

Measurements report generated code, HTML Next bridges, target framework/runtime, total production
output, build time, server render when applicable, initial client mount, hydration, reactive
updates, keyed changes, and disposal. Library measurements include representative single-entry and
multi-entry consumer bundles.

## Conformance scenarios

1. Convert one shared fixture graph to React, Vue, and Svelte and compare native roots, projection,
   props, events, methods, state results, declared types, native form behavior, styles, and diagnostics.
2. Server-render and hydrate each target while preserving DOM identity, form edits, focus, and
   selection.
3. Exercise target-native reactive updates, keyed reorders, controller cleanup, and request
   cancellation without importing the general live browser runtime.
4. Bundle one and several entries from a converted library and verify stable exports plus shared
   bridge deduplication.
5. Reject a semantic gap the target adapter cannot preserve with a source-located conversion
   diagnostic rather than emitting an approximation.

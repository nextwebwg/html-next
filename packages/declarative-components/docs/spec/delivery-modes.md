# Delivery modes

Declarative Components defines one component language with three delivery modes. The source
contract and observable result stay stable; each mode chooses a different place to parse the
source, resolve the graph, and supply runtime behavior.

## Mode selection

| Mode | Choose it when | Primary input | Primary output |
| --- | --- | --- | --- |
| [Live browser distributable](live-browser-distributable.md) | Definitions or instances may arrive after page load, or the application wants no component build step | An open component graph selected by the page at runtime | One browser entry point with the complete implemented capability profile |
| [Native application or library build](native-application-build.md) | The application or library entries are available to a build | A closed entry graph plus any declared dynamic boundary | Native DOM modules and shared graph-scoped support |
| [Framework conversion](framework-conversion.md) | React, Vue, or Svelte owns rendering and lifecycle | A component graph and a target framework | Target-native components plus semantic bridges |

A deployment has one primary mode for each component graph. It may contain graphs produced by
different modes, provided their public component contracts do not collide.

## Shared semantic model

Every mode must normalize source according to [syntax and diagnostics](syntax.md), then preserve
the behavior defined by the component, expression, reactivity, loading, type, and style
modules. Normalization may happen in the browser, during a native build, or during framework
conversion.

For the same definition and inputs, conforming modes must agree on:

- the authored native root and projected-content identity;
- public attributes, properties, events, methods, slots, declared types, and native form behavior;
- state, computed values, effects, and declared request results;
- connection, disconnection, reconnection, controller cleanup, and hydration;
- scoped styles and observable diagnostics.

Target-private module layout, helper names, scheduling internals, and unobservable intermediate
representations are implementation details.

## Capability profile

The support profile describes language behavior, not a packaging tier. A capability marked
`required` or `experimental` must behave consistently in every delivery mode that claims support
for it.

The live distributable carries the complete implemented profile because its future graph is open.
A native build carries the capability union of its input graph and declared dynamic boundary. A
framework conversion expresses that same union through target-native facilities and semantic
bridges.

## Graph boundaries

The application selects trusted graph roots. Relative component, controller, style, and
static module edges extend the graph under the loading and security rules.

The live mode resolves edges as definitions arrive. Build modes resolve concrete edges before
emission and record unresolved or dynamic edges in their artifacts. A runtime-selected edge must
have an explicit delivery contract: universal support, a declared dynamic chunk, or a diagnostic.

## Conformance and measurements

The shared conformance corpus states observable cases once. Each delivery harness runs the
applicable cases at its own boundary:

- live tests begin at the public browser entry point;
- native-build tests begin at application or library entries;
- framework tests begin at generated target entries.

Every size or performance result must name its delivery mode, input graph assumptions, included
capabilities, browser targets, and bundle boundary. Capability fixtures attribute the cost of one
feature; they do not define a per-component runtime architecture and do not substitute for a
whole-product measurement.

## Delivery specifications

- [Live browser distributable](live-browser-distributable.md)
- [Native application or library build](native-application-build.md)
- [Framework conversion](framework-conversion.md)

# HTML Next reference specification

This directory is the implementation-pinned specification for `@nextwebwg/declarative-components`. It defines the behavior that the browser polyfill and generated targets must share. The public Working Draft may explain and motivate the proposal; conformance is determined here and by the linked support profile and tests.

The key words **must**, **must not**, **should**, and **may** are normative. A feature is shipped only when [`support.json`](support.json) labels it `required` or `experimental` and its conformance tests pass. A `deferred` entry reserves no runtime behavior.

## Modules

- [Delivery modes](delivery-modes.md)
  - [Live browser distributable](live-browser-distributable.md)
  - [Native application or library build](native-application-build.md)
  - [Framework conversion](framework-conversion.md)
- [Syntax and diagnostics](syntax.md)
- [Components](components.md)
  - [Rendered form](rendered-form.md)
- [Expressions](expressions.md)
- [Reactivity, handlers, data, and forms](reactivity.md)
- [Loading and security](loading-and-security.md)
- [Types and validation](types-and-validation.md)
- [Styling](styling.md)
- [Targets, packages, migration, and conformance](targets-and-conformance.md)

## Conformance model

An implementation conforms to this revision when it accepts every required conforming fixture, rejects every required diagnostic fixture with the specified code, and produces the same observable native DOM, properties, events, validity, focus behavior, and styles for every applicable target. Serialization details that cannot be observed by a consumer are not part of target equivalence.

The source HTML is the component contract. Build inventories and package metadata describe emitted artifacts and dependency edges; they are not a second component-authoring format.

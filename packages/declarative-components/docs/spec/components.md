# Components

## Component roots

Each definition produces one public root. A native root preserves the element's built-in focus, form, event, and accessibility behavior. A delegated root invokes another declared component and adds its own lineage and style without adding a wrapper. Polymorphic roots are limited to declared safe native choices and must retain a stable public contract.

An invocation lowers to the root itself. Framework targets must not add a semantic wrapper merely to host reactivity.

## Dynamic browser discovery

Inline `template[component]` definitions and component instances may be inserted after the browser runtime starts. The runtime observes additions to the application document, validates and registers new definitions in the same document-level registry, and lowers newly connected instances. An instance inserted before its definition remains available for lowering when that definition becomes available. Definitions remain registered after their inert carriers are consumed or removed; adding another definition for that tag is a duplicate, not a replacement operation.

Mutation delivery batches discovery. The runtime must not interpret its own lowering mutations as new definitions or connect one instance twice. Registered custom elements retain precedence at the time of lowering. Moving an instance within the same document before a mutation batch is delivered preserves its connection; removal across batches disconnects it, and later reinsertion reconnects the same root.

Discovery uses the same dependency resolver and trust rules as startup loading. It does not make inserted definition content executable or treat sanitized content as a definition source. See [Loading and security](loading-and-security.md).

This observation is a browser-runtime responsibility. Ahead-of-time compilation discovers definitions from its input graph and emits target lifecycle integration; compiled/AOT components do not use `MutationObserver` for registration or instance discovery.

## Properties

A property declaration gives a public name, type, optional default, requiredness, reflection behavior, and binding target. Scalar values may be sourced from invocation attributes. Structured values and functions are property-only inputs. Changes made through the lowered root's public property participate in the same update batch as local state writes.

A controlled property is authoritative while present. Its paired `default-*` value initializes local state only when the controlled property is absent. User interaction updates local state and dispatches the declared change event; it does not mutate an externally controlled property.

Every effective public value is reflected on the lowered root as `data-<lowercase-name>` so server output can reconstruct the instance scope. Values, including structured values, use the type's canonical serializer at this reflection boundary; this does not turn structured invocation attributes into an authoring syntax. External writes to a reflected attribute are parsed through the declared type and enter the same scheduler. Absence removes the reflected attribute. Property-to-attribute reflection must not create a feedback loop.

## Slots

Definitions support a default slot, named slots, fallback content, and expression-bound slot names used inside structural regions. Projected nodes retain consumer ownership and identity. Fallback renders only while the corresponding projection is empty.

Framework adapters may expose a scoped slot as a function and project each returned node into a data-derived native slot. That adapter operation must remain equivalent to authoring the resulting named slot nodes directly.

```html conforming
<template component="x-result-list">
  <defs><prop name="rows" type="list(object)"></prop></defs>
  <ul>
    <li $each="row of rows" $key="row.id">
      <slot :name="format('row-%s', row.id)">Unnamed result</slot>
    </li>
  </ul>
</template>
```

Expected outcome: each row selects consumer content carrying the corresponding `slot="row-…"`; a missing row projection renders `Unnamed result`, and keyed updates retain the identity of projected nodes.

## Events

A component event has a name, a typed detail value, bubbling/composed/cancelable flags, and a documented trigger. Declarative handlers and controllers dispatch through the same host operation. Framework targets translate native event detail into their idiomatic callback or emit surface without changing the payload.

## Public methods

A public method declaration names an operation, parameter types, return type, and the controller export that implements it. The generated custom element and framework ref expose that method after connection. Calls made before a controller is ready either await readiness when the declared return is asynchronous or reject with a stable not-ready diagnostic; they are never silently dropped.

Public methods exist for imperative operations that cannot be modeled as property changes, such as focusing an internal native control or requesting asynchronous validation. They do not provide undeclared access to controller internals.

# Components

## Component roots

Each definition produces one public root. A native root preserves the element's built-in focus, form, event, and accessibility behavior. A delegated root invokes another declared component and adds its own lineage and style without adding a wrapper. Polymorphic roots are limited to declared safe native choices and must retain a stable public contract.

An invocation lowers to the root itself. Framework targets must not add a semantic wrapper merely to host reactivity.

## Properties

A property declaration gives a public name, type, optional default, requiredness, reflection behavior, and binding target. Scalar values may be sourced from attributes. Structured values and functions are property-only and never stringified into attributes. Changes made after connection participate in the same update batch as local state writes.

A controlled property is authoritative while present. Its paired `default-*` value initializes local state only when the controlled property is absent. User interaction updates local state and dispatches the declared change event; it does not mutate an externally controlled property.

Reflected values serialize through the type's canonical serializer. Absence removes the reflected attribute. Reflection must not create an attribute/property feedback loop.

## Slots

Definitions support a default slot, named slots, fallback content, and expression-bound slot names used inside structural regions. Projected nodes retain consumer ownership and identity. Fallback renders only while the corresponding projection is empty.

Framework adapters may expose a scoped slot as a function and project each returned node into a data-derived native slot. That adapter operation must remain equivalent to authoring the resulting named slot nodes directly.

```html conforming
<template component="x-result-list">
  <defs><prop name="rows" type="list(object)"></prop></defs>
  <ul>
    <for each="row in rows" key="row.id">
      <li><slot :name="format('row-%s', row.id)">Unnamed result</slot></li>
    </for>
  </ul>
</template>
```

## Events

A component event has a name, a typed detail value, bubbling/composed/cancelable flags, and a documented trigger. Declarative handlers and controllers dispatch through the same host operation. Framework targets translate native event detail into their idiomatic callback or emit surface without changing the payload.

## Public methods

A public method declaration names an operation, parameter types, return type, and the controller export that implements it. The generated custom element and framework ref expose that method after connection. Calls made before a controller is ready either await readiness when the declared return is asynchronous or reject with a stable not-ready diagnostic; they are never silently dropped.

Public methods exist for imperative operations that cannot be modeled as property changes, such as focusing an internal native control or requesting asynchronous validation. They do not provide undeclared access to controller internals.

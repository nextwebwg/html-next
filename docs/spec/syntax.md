# Syntax and diagnostics

## Component definition grammar

A definition is one inert `template[component]` carrier. Its `component` value must be a valid autonomous custom-element name. A source may also contain `link[rel=component]` dependency edges. The carrier may declare `status`, `summary`, `controller`, one declaration region, one component root, and one scoped `style`.

The declaration region may contain property, state, computed, data, handler, event, and public-method declarations. Names share a flat component scope unless a construct explicitly creates a local loop or `with` scope. Duplicate declarations and undeclared expression roots are errors.

```html conforming
<template component="x-counter" controller="./counter.js">
  <defs>
    <prop name="value" type="number" default="0"></prop>
    <state name="count" from="value"></state>
    <computed name="label" value="format(count)"></computed>
  </defs>
  <button type="button"><value of="label"></value></button>
</template>
```

Parser recovery must not silently change the definition's author-observable tree. A carrier whose root or declaration layout is ambiguous is rejected.

## Diagnostics

Every rejected source produces a stable `HN-<family>-<number>` code, a human-readable message, and source provenance. Node and browser adapters must report the same code for the same normalized invalid input. Adding detail to a message is compatible; changing the condition associated with a code is not.

```html diagnostic HN-SYN-001
<template component="not-a-custom-element"><button></button></template>
```

Definition validation completes before any authored node becomes live and before any controller is imported. A graph error names both the referring source and the rejected edge.

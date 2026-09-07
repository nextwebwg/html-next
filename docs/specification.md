# HTML7 technical specification

Status: Draft, early release
Version: 0.1.0-dev
Last updated: 2026-09-06

This document specifies the initial architecture and the component-generation subset of
HTML7. It separates normative requirements from future design intent so that the first
implementation can be useful to Looma without implying that the full language already
exists.

The key words **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, and **MAY** are to be
interpreted as requirement levels within this project. They are not statements about the
HTML Living Standard.

## 1. Purpose

HTML7 is a markup-first application language that extends HTML's authoring model with
typed reusable components, templates, imports, declarative control flow, explicit data
sources, and reactive bindings.

An HTML7 source artifact has two conforming execution paths:

1. an ahead-of-time compiler that emits ordinary artifacts for Vanilla DOM, React, Vue,
   Svelte, and future targets; and
2. an in-browser interpreter that reads the same definitions and lowers them against the
   live DOM.

The two paths MAY use different implementation techniques, but MUST preserve equivalent
observable semantics.

HTML7 is independent from Looma. Looma is the initial production-grade component
vocabulary and conformance corpus. Looma packages may ship generated artifacts without
shipping the HTML7 browser runtime.

## 2. Design principles

### 2.1 Markup is the language

Canonical component structure MUST be authored as markup. Framework-specific component
functions, JSX, hooks, Vue reactivity, and Svelte runes MUST NOT appear in canonical
HTML7 source.

### 2.2 The browser parser is part of the language environment

Syntax intended for direct browser interpretation MUST survive the HTML parser with the
information required for execution. The compiler MUST reproduce relevant browser
normalization so that compilation does not accidentally create a second language.

### 2.3 Native semantics are preserved

When a component can lower to a native element, it SHOULD do so. A button component
SHOULD produce a real `<button>`, not a generic host that simulates button behavior.
Native form association, focus, accessibility, attributes, properties, and events remain
owned by the browser.

### 2.4 Dependencies are explicit

Expressions MUST resolve through declared component props, state, computed values, data
sources, imports, filters, or local template bindings. Ambient JavaScript globals are not
part of the expression scope.

### 2.5 Contracts are data

Component contracts MUST be inspectable without executing application code. Compilers,
framework generators, documentation tooling, browser runtimes, and tests consume the
same normalized contract.

### 2.6 Generated projections are disposable

React, Vue, Svelte, Vanilla, API-reference, schema, and conformance outputs are build
artifacts. Authors edit the HTML7 source and regenerate projections; generated files are
not independent sources of truth.

## 3. Conformance profiles

HTML7 defines profiles so partial implementations do not silently claim full language
support.

### 3.1 Component Generation MVP

The initial implementation supports:

- one component definition per source file;
- a declarative JSON component contract;
- one native root element per component template;
- literal attributes;
- one-way prop-to-attribute bindings using `:name="prop"`;
- explicit prop-to-property bindings using `.name="prop"`;
- a default `<slot></slot>`;
- component-scoped source CSS copied to a shared generated stylesheet;
- Vanilla DOM, React, Vue, and Svelte source generation;
- generated contract JSON and Markdown API reference;
- initial in-browser lowering of existing component invocations;
- static platform-property resolution generated at library build time; and
- exact DOM snapshot parity for the supported primitive subset.

The MVP does not support local state, computed values, external data, control flow,
filters, actions, event remapping, named slots, compound components, server hydration,
or reactive updates after browser lowering. These features are reserved by later
sections but MUST produce explicit unsupported-feature diagnostics in an MVP compiler.

### 3.2 Future profiles

Future profiles may add, independently:

- template control flow;
- the full expression grammar;
- declarative state and computed values;
- external data sources and parameters;
- reactive browser updates;
- component imports and composition;
- compound native output and behavior controllers;
- SSR and hydration;
- target capability negotiation; and
- restricted static or email output.

## 4. Source artifact

### 4.1 File representation

An HTML7 component definition is a UTF-8 HTML source artifact. The recommended filename
form is `<component-name>.html`; `.html7.html` MAY be used where an explicit marker is
helpful. The language does not depend on a proprietary tokenizer.

The Component Generation MVP accepts one top-level `<html7-component>` element:

```html
<html7-component>
  <script type="application/html7-contract+json">
    {
      "version": 1,
      "name": "Button",
      "tag": "looma-button",
      "status": "early",
      "summary": "A native button with Looma presentation.",
      "nativeElement": "button",
      "props": {
        "variant": {
          "type": { "enum": ["outline", "solid", "destructive", "ghost"] },
          "default": "outline",
          "target": { "attribute": "data-lm-variant" },
          "description": "Visual treatment."
        }
      }
    }
  </script>

  <template>
    <button data-looma :data-lm-variant="variant">
      <slot></slot>
    </button>
  </template>

  <style>
    button[data-looma] { box-sizing: border-box; }
  </style>
</html7-component>
```

The wrapper, contract script, and template are definition-time nodes. They are not part
of an instantiated component's output.

### 4.2 Definition discovery

An implementation MUST find the direct child contract, template, and style blocks by
element name and contract MIME type, not by source formatting or child position.

An MVP source file MUST contain exactly:

- one `<html7-component>`;
- one direct child `<script type="application/html7-contract+json">`; and
- one direct child `<template>`.

It MAY contain zero or one direct child `<style>`. Other direct children are errors in
the MVP.

### 4.3 JSON contract block

The contract block uses JSON rather than executable JavaScript so that it can be parsed
under strict Content Security Policy and interpreted in a browser without `eval()`.
Comments and trailing commas are not valid in the MVP.

`defineContract(value)` is the public TypeScript/JavaScript API that validates,
normalizes, and freezes the same data shape. The HTML parser passes the parsed JSON value
to this function. Programmatic tooling MAY call it directly; the source format does not
depend on executing it.

## 5. Component contract

### 5.1 Top-level fields

The MVP contract has the following fields:

| Field | Required | Meaning |
| --- | --- | --- |
| `version` | yes | Contract schema version; currently `1`. |
| `name` | yes | PascalCase generated component identifier. |
| `tag` | yes | Lowercase component invocation tag containing a hyphen. |
| `status` | yes | `early`, `experimental`, `stable`, or `deprecated`. |
| `summary` | yes | Consumer-facing one-sentence description. |
| `nativeElement` | yes | Native HTML root emitted by the MVP. |
| `props` | yes | Map of public component prop names to prop contracts. |

Unknown top-level fields are errors in schema version 1. This keeps misspellings from
silently disappearing. Schema evolution MUST occur through a new version or an explicit
extension mechanism.

### 5.2 Names

`name` MUST be a valid ECMAScript identifier in PascalCase. `tag` MUST be lowercase and
contain a hyphen so it can coexist with current Custom Element naming constraints even
though HTML7 does not require Custom Elements for lowering.

Prop names MUST be ASCII identifiers beginning with a letter and containing letters,
digits, `_`, or `-`. A contract MUST NOT declare two names that collapse to the same
ASCII-lowercase key.

### 5.3 Prop contract

An MVP prop contains:

| Field | Required | Meaning |
| --- | --- | --- |
| `type` | yes | A scalar type name or `{ "enum": [...] }`. |
| `default` | no | Value used when the invocation omits the prop. |
| `required` | no | Whether omission is an error; defaults to `false`. |
| `target` | yes | Native `{ "attribute": name }` or `{ "property": name }`. |
| `description` | yes | Consumer-facing API documentation. |

MVP scalar types are `string`, `boolean`, and `number`. Enum members MUST be unique
strings. A default MUST satisfy the declared type. `required: true` and `default` MUST
NOT be combined.

Attribute targets are serialized as follows:

- string and enum values use their string representation;
- finite numbers use their decimal representation;
- boolean `true` produces an empty boolean attribute and `false` removes it; and
- `null` or an omitted optional prop removes the target unless a default exists.

Property targets are assigned as typed values. Property targets MUST resolve through the
static platform contract for the component's native root.

### 5.4 Native attributes

Invocation attributes not declared as component props pass through to the native root.
This preserves native `id`, `class`, `name`, `value`, `type`, `disabled`, `aria-*`,
`data-*`, and target-framework event surfaces without reproducing the platform in every
component contract.

Framework generators MUST extend or compose their framework's native element prop type
where that framework exposes one. Owned template attributes and component prop targets
take precedence over pass-through attributes.

### 5.5 Status and documentation

Every component contract MUST declare release status. Generated API reference MUST show
that status prominently. Features specified but not implemented MUST be labeled
"Coming soon" rather than represented as callable API.

## 6. Template subset

### 6.1 Root

The MVP template MUST contain exactly one significant root element. Whitespace-only text
outside that root is ignored. The root name MUST equal `contract.nativeElement`.

### 6.2 Literal attributes

An unprefixed attribute is literal:

```html
<button data-looma aria-live="polite"></button>
```

The compiler preserves its HTML-normalized name and decoded value. Boolean literal
attributes have the empty string value.

### 6.3 One-way bindings

`:` introduces an expression binding resolved by the native-element contract:

```html
<button :data-lm-variant="variant"></button>
```

In the MVP, the expression MUST be exactly one declared prop identifier. The full
expression grammar is reserved for the expression profile.

For attributes, the contract target and template binding MUST agree. An MVP compiler
MUST reject a binding to an undeclared prop, a target name mismatch, or two bindings
that resolve to the same output name.

### 6.4 Explicit property bindings

`.` introduces an exact DOM property binding:

```html
<output .textContent="message"></output>
```

Authored attribute names are normalized by the HTML parser. Both the AOT compiler and
browser runtime MUST:

1. remove the leading `.`;
2. ASCII-lowercase the remainder;
3. look up that key in the generated native-element contract; and
4. assign using the returned canonical property spelling.

Thus `.innerHTML` and the parsed `.innerhtml` both use lookup key `innerhtml`, which maps
to actual property `innerHTML`. Source spelling MAY be retained for diagnostics but MUST
NOT affect semantics.

`.innerHTML` is a reserved unsafe sink and is not enabled by the MVP scalar types. A
future trusted-HTML type and sanitization contract are required before it can accept
dynamic values.

### 6.5 Two-way bindings

`bind:name="writable.path"` is reserved for two-way binding. The MVP parser MUST preserve
and diagnose it as unsupported rather than treating it as a literal attribute.

### 6.6 Slots

The MVP supports exactly one default `<slot></slot>`. The explicit closing tag is
required. During lowering, invocation children replace the slot while retaining their
identity in the browser path.

Named slots, fallback slot content, slot props, and multiple slots are reserved.

### 6.7 Dynamic values

`<value of="expression"></value>` is the selected language shape for dynamic child
content. It is reserved but not implemented in the Component Generation MVP. Text
interpolation using `{...}` or `{{...}}` is not part of HTML7.

## 7. Static platform contracts

HTML attribute parsing is case-insensitive in HTML documents while DOM property names
are case-sensitive. HTML7 MUST NOT recover property names by enumerating live element
objects during ordinary execution.

At HTML7 library build time, a generator consumes pinned Web IDL / DOM type data and
emits a versioned static manifest. The compact runtime representation contains:

- native tag name to DOM interface mapping;
- DOM interface inheritance;
- per-interface property maps from ASCII-lowercase keys to exact IDL spelling; and
- the minimum flags required for writable and security-sensitive properties.

Conceptually:

```json
{
  "HTMLButtonElement": {
    "extends": ["HTMLElement"],
    "properties": {
      "disabled": "disabled",
      "formaction": "formAction"
    }
  },
  "Element": {
    "extends": ["Node"],
    "properties": {
      "innerhtml": "innerHTML"
    }
  }
}
```

The generator MUST fail if an interface's reachable property set contains two exact
names with the same lowercase key. An implementation MUST NOT choose a collision winner
at runtime.

The compiler and browser runtime MUST share the same resolution algorithm and generated
data version. Runtime reflection MAY exist as a development assertion or extension
fallback, but is not conforming production resolution for native elements.

## 8. Intermediate representation

All execution paths consume one normalized intermediate representation (IR):

```ts
interface ComponentDefinition {
  source: { file: string }
  contract: ComponentContract
  template: ElementNode
  css: string
}

interface ElementNode {
  kind: "element"
  name: string
  attributes: TemplateAttribute[]
  children: TemplateNode[]
}

type TemplateAttribute =
  | { kind: "literal"; name: string; value: string }
  | { kind: "attribute"; name: string; expression: PropExpression }
  | { kind: "property"; key: string; name: string; expression: PropExpression }
```

The IR MUST contain normalized semantic names. Target generators MUST NOT repeat source
parsing or invent target-specific meaning.

Diagnostics MUST include a stable code, human-readable message, and source filename.
Line/column ranges are recommended and become required once the parser preserves them
for every relevant node.

## 9. Ahead-of-time targets

### 9.1 Common requirements

Every generator MUST:

- use the contract's PascalCase `name` for exported component identifiers;
- preserve the native root element;
- pass through native consumer attributes;
- apply contract defaults;
- serialize prop targets according to their contract;
- emit owned template attributes after pass-through values;
- project default children into the default slot;
- import or reference generated CSS exactly once; and
- produce deterministic output for deterministic input.

### 9.2 Vanilla DOM

The Vanilla target emits an ES module factory plus a `.d.ts` type declaration. The
factory returns the native root element, accepts typed component props, accepts native
attributes through an `attributes` record, and accepts strings or Nodes as children.

### 9.3 React

The React target emits TypeScript JSX. Primitive props compose
`React.<Native>HTMLAttributes`, omitting names redefined by the component contract.
For the React 19 baseline, the component accepts a typed `ref` prop directly and places
it on the native element; generated code does not wrap the component in `forwardRef`.
It renders `children` in the default slot.

### 9.4 Vue

The Vue target emits a Vue single-file component using `<script setup lang="ts">`.
Component props are declared with `defineProps`, defaults with `withDefaults`, native
attributes use Vue's single-root fallthrough behavior, and default children use
`<slot></slot>`. A generator MAY bind `$attrs` explicitly when owned-attribute ordering
or a future compound root requires it.

### 9.5 Svelte

The Svelte target emits a Svelte component using the current runes-style props API and
native attribute types from `svelte/elements`. Default children are typed as a `Snippet`,
native attributes are spread onto the root, and children are rendered with
`{@render children?.()}`.

Target syntax versions MUST be recorded in generated-file headers and package metadata.

## 10. Browser execution

The MVP browser runtime MAY be invoked explicitly rather than auto-running. It:

1. discovers component definitions;
2. validates each JSON contract;
3. converts each template DOM subtree into the normalized IR;
4. finds matching invocation elements outside definitions;
5. parses invocation prop attributes according to the contract;
6. clones and binds the native template root;
7. passes through undeclared invocation attributes;
8. moves invocation children into the default slot; and
9. replaces the invocation element with the native root.

The MVP performs a one-time lowering pass. It does not register a Custom Element, retain
the component host, or react to subsequent prop mutations. Future reactive profiles may
add observation, but MUST preserve the same initial output.

Definition elements and language control-flow elements MUST be hidden before upgrade so
unsupported or delayed runtime loading does not expose implementation markup.

## 11. Observable equivalence

For the MVP, two executions are equivalent when their lowered native roots have:

- the same namespace and tag name;
- the same effective attributes, ignoring order;
- the same assigned property values for explicit property bindings;
- equivalent child node order, text, and identity requirements;
- the same native focus, form, and accessibility semantics implied by that DOM; and
- the same validation failures for unsupported or invalid source.

Framework-owned hydration markers and development-only attributes are excluded from DOM
snapshot comparison, but generated adapters MUST NOT add semantic wrapper elements.

## 12. Diagnostics

MVP diagnostic families:

| Prefix | Area |
| --- | --- |
| `H7S` | source structure and parse errors |
| `H7C` | component contract errors |
| `H7T` | template and binding errors |
| `H7P` | platform-property resolution errors |
| `H7G` | target-generation errors |
| `H7R` | browser-runtime errors |

Unknown language elements, unsupported bindings, malformed JSON, duplicate normalized
names, target mismatches, and unsafe property sinks MUST fail explicitly. Silent fallback
to literal output is non-conforming.

## 13. Security

The compiler and runtime MUST NOT evaluate source through `eval()`, `new Function()`, or
equivalent dynamic JavaScript compilation. Contract JSON is data; template expressions
are parsed by HTML7.

The MVP does not permit raw dynamic HTML. Future URL, style, and HTML-valued sinks MUST
define contextual validation and escaping. A limited expression language reduces code
execution risk but does not make untrusted component definitions safe.

## 14. Accessibility and forms

Primitive lowering MUST preserve native form and accessibility semantics. Framework
adapters MUST render the native root directly. The MVP does not claim to solve compound
widget keyboard interaction; those components require explicit behavior and conformance
contracts in a later profile.

Generated API documentation SHOULD identify the native element being extended so users
understand which standard attributes, events, and behaviors remain available.

## 15. Versioning and stability

HTML7 is in early release. Version 1 in a contract identifies the schema, not a stable
language release. Until a stability policy is adopted:

- syntax and generated output MAY change between minor development releases;
- generators MUST include their version in generated artifacts;
- source migrations SHOULD be automatable; and
- documentation MUST label unimplemented intended syntax as "Coming soon."

## 16. Reserved language direction

The following forms are selected design directions but are outside the MVP:

```html
<state name="count" value="0"></state>
<computed name="double" from="count * 2"></computed>
<data name="users" src="/users.json"></data>

<if test="users.value.length > 0">
  <for each="user" of="users.value">
    <with value="user">
      <p><value of="name"></value></p>
    </with>
  </for>
<else>
  <p>No users.</p>
</else>
</if>
```

Control-flow elements have semantics only inside HTML7 templates. If encountered in the
ordinary document body without an HTML7 evaluator, they are hidden no-ops. They are
syntax-tree nodes, not autonomous Custom Elements.

The expression language is small, pure, and independent from JavaScript. Its planned
boundary is specified in [template expressions](./template-expressions.md).

## 17. Open specification work

The following remain genuine design questions rather than MVP implementation choices:

- component imports and registry scoping;
- named and typed slots and complete content models;
- event and action declarations;
- shared framework-neutral behavior controller lifecycle;
- full type notation for URLs, colors, lengths, IDs, element references, and trusted
  content;
- missing-data, equality, coercion, and error semantics;
- data-source request, caching, cancellation, and stale-response behavior;
- SSR serialization and hydration ownership;
- reactive browser scheduling and teardown;
- SVG, MathML, table, and select parser contexts;
- extension and capability negotiation; and
- the governance path for language and platform-contract evolution.

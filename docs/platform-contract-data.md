# Platform contract data

Status: selected data-source direction; implementation not started
Last updated: 2026-09-06

HTML7 needs an up-to-date mapping from native element names to DOM interfaces and from
case-normalized authored bindings to exact, case-sensitive DOM property names. It should
generate that mapping from existing standards datasets rather than maintain it manually
or discover the whole platform through runtime reflection.

## Upstream sources

### Webref Web IDL

[`@webref/idl`](https://www.npmjs.com/package/@webref/idl) publishes machine-readable
Web IDL definitions from the W3C Webref project. It is the primary standards-shaped input
for interface inheritance, attributes, operations, and exact IDL member spelling.

Repository: [w3c/webref](https://github.com/w3c/webref)

### TypeScript DOM library generator

[Microsoft's TypeScript DOM lib generator](https://github.com/microsoft/TypeScript-DOM-lib-generator)
generates TypeScript's `lib.dom.d.ts` and the independently versioned `@types/web`
package. Its output includes DOM interfaces, inheritance, and tag-name maps. The project
filters APIs for multi-engine browser support and carries explicit additions, removals,
and TypeScript-oriented overrides.

[`@types/web`](https://github.com/microsoft/TypeScript-DOM-lib-generator/blob/main/deploy/readmes/web.md)
allows the generated web types to be versioned independently from TypeScript itself.

### MDN Browser Compatibility Data

[`@mdn/browser-compat-data`](https://github.com/mdn/browser-compat-data) provides
machine-readable browser support data. It can annotate the generated HTML7 contract with
availability by engine and version rather than treating presence in an IDL file as proof
of universal support.

## Generated HTML7 manifest

The HTML7 library build—not an application build and not the browser at startup—should
combine these sources into a compact, versioned manifest. Its central data structure is
a map whose keys are ASCII-lowercase property names and whose values retain the actual
case-sensitive DOM property spelling:

```json
{
  "h1": {
    "interface": "HTMLHeadingElement",
    "properties": {
      "innerhtml": { "name": "innerHTML", "type": "HTML", "writable": true },
      "textcontent": { "name": "textContent", "type": "string?", "writable": true }
    }
  },
  "input": {
    "interface": "HTMLInputElement",
    "properties": {
      "value": { "name": "value", "type": "string", "writable": true },
      "checked": { "name": "checked", "type": "boolean", "writable": true }
    }
  }
}
```

This is illustrative. Real generation must model inheritance without needlessly
duplicating every `Node` and `Element` member under every tag.

The lowercase key is the browser-normalized lookup key. The `name` field is the exact
IDL property used by generated code and the browser runtime. Authors may therefore write:

```html
<h1 .innerHTML="trustedMarkup"></h1>
```

Although the browser parser exposes `.innerhtml`, the manifest resolves it back to the
actual `innerHTML` property without requiring kebab-case authoring.

Both execution paths normalize up front:

```text
authored/AOT name   .innerHTML
browser DOM name    .innerhtml
                           |
                           v
ASCII-lower key      innerhtml
                           |
                           v
manifest target      innerHTML
```

The compiler preserves the authored spelling for diagnostics but never uses it as a
semantic key. The browser runtime does not need to recover original source casing; it
only removes the leading binding marker, ASCII-lowercases the remainder, and performs a
manifest lookup.

Native and HTML7 component contracts must reject two properties whose names collapse to
the same ASCII-lowercase key. Case-insensitive ambiguity is a definition error, never a
runtime tie-breaker.

## Compile-time and runtime use

The HTML7 compiler uses the full manifest for:

- validating whether a property exists on an element;
- resolving normalized spelling to the exact IDL member;
- checking readable and writable types;
- deciding whether `bind:name` is legal;
- identifying explicit security-sensitive sinks;
- generating framework-specific native-element types;
- warning when a property is outside the configured browser baseline.

The published browser package should contain the already-generated runtime form of this
manifest. It must not parse Web IDL, inspect TypeScript declarations, or walk browser
prototypes during ordinary startup. Ahead-of-time targets consume the richer build-time
form; a bundler may optionally tree-shake the runtime form when its set of elements and
properties is statically known.

In its simplest runtime form, lookup is deliberately boring:

```js
const key = asciiLowercase(parsedBindingName)
const property = elementContract.properties[key].name
element[property] = evaluatedValue
```

For `.innerHTML`, `key` is `innerhtml` and `property` is `innerHTML`.

HTML7 component contracts contribute their own property maps. A component's declared
contract takes precedence over runtime reflection and is subject to the same
case-insensitive ambiguity checks.

## Reflection fallback

Runtime discovery remains useful for experiments, undeclared custom elements, and
conformance tests. `Object.keys(element)` is insufficient because DOM properties are
normally non-enumerable and inherited.

A fallback resolver walks the prototype chain:

```js
function resolveProperty(element, normalizedName) {
  const expected = normalizedName.toLowerCase()

  for (let object = element; object; object = Object.getPrototypeOf(object)) {
    const matches = Object.getOwnPropertyNames(object)
      .filter(name => name.toLowerCase() === expected)

    if (matches.length > 1) throw new Error("Ambiguous DOM property")
    if (matches.length === 1) return matches[0]
  }

  return undefined
}
```

Production behavior should not depend on each browser exposing identical enumerable or
prototype layouts. The static contract defines supported semantics; reflection verifies
or extends them deliberately.

## Update policy

- Pin upstream dataset versions so builds are reproducible.
- Provide an explicit update command and generated diff.
- Run conformance tests in Chromium, Firefox, and WebKit after an update.
- Separate standards availability from HTML7's supported browser baseline.
- Record manual overrides with a reason and upstream issue when possible.
- Fail generation on case-insensitive member collisions rather than choosing silently.

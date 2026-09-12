# Expressions

HTML Next expressions are a small pure language. They are parsed as data and never evaluated with `eval`, `Function`, inline JavaScript, or ambient globals.

## Values and absence

Values include absence, null, booleans, numbers, strings, lists, and records. Missing properties and out-of-range indexes produce absence; access through absence continues to produce absence. Absence and null serialize as empty text and remove ordinary bound attributes.

The empty value of each value domain is false: absence, null, false, zero, an empty string, an empty list, and an empty record. Other values are true. Equality is typed and arithmetic is numeric; there is no implicit string/number coercion.

## Operators and functions

The grammar includes member and index access; list and record literals; parentheses; unary `not` and numeric negation; numeric arithmetic; typed equality and ordering; boolean `and`/`or`; and the documented CSS-style string match operators. Calls are limited to the fixed pure standard function set. Controllers are not callable from template expressions.

Each parsed expression records its declared dependency paths. An undeclared root is a compile error. A property missing at runtime is data absence, not an exception.

## Bindings

`:<name>` binds an attribute, `.<name>` binds a DOM property, `$value` inserts escaped text, and `$html` inserts sanitized trusted-content input. Target resolution uses a generated platform table rather than runtime prototype inspection.

`bind:<name>` is two-way only when its destination is a writable state-rooted path. Props, computed values, data results, calls, and arithmetic expressions are not writable destinations. Control-specific read/write and event behavior follows the corresponding native control.

Class and style bindings use typed maps or declared safe scalar forms. URL, style, HTML, script, and document sinks apply their own type and sanitization policy rather than the ordinary string serializer.

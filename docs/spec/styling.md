# Styling

## Scoped component styles

A definition's style rules match markup authored by that definition, including its public root, but not projected content or the internals of nested components. The enclosing component may style a nested component root as a layout box. Inherited properties and custom properties cross all boundaries normally.

The browser polyfill and generated targets must produce equivalent matching. Native `@scope` may be used only with lower-bound semantics that retain a nested root while excluding its descendants. Because CSS scope limits exclude the limit element itself, an implementation cannot use the nested root directly as a limit and still promise that box-styling behavior.

Validity-selector compatibility is part of the same transformation pipeline so scoping and mirrored validation state cannot disagree.

## Provenance

Every lowered authored element records component lineage. Projected roots are marked as consumer-owned. Delegated components add lineage to the shared public root so each owning definition's style applies once.

Provenance is implementation metadata, not an authoring hook. Tools may use readable attributes or compact generated identifiers, but output must preserve nested-root, projected-content, delegation, hydration, and selector behavior. See the corrected implementation algorithm in [`../style-scoping.md`](../style-scoping.md).

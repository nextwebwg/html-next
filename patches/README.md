# Svelte compatibility patches

The pinned `svelte2tsx@0.7.61` and `svelte-check@4.7.6` patches quote generated object and type property keys. Otherwise a legal quoted export such as `export { method as "·ping" }` produces an invalid unquoted key and loses its public method type. The checker bundles its own transformer, so both packages need the same fix.

The patches affect build and checking tools. They add no generated component runtime code or runtime dependency. pnpm applies them from the checked-in workspace configuration and verifies their content hashes in the lockfile. Declaration caching includes the actual transformer entry so a patch cannot reuse stale types under the same package version.

The source fix belongs in [language-tools' ExportedNames](https://github.com/sveltejs/language-tools/blob/master/packages/svelte2tsx/src/svelte2tsx/nodes/ExportedNames.ts), in `createReturnElements` and `createReturnElementsType`. An upstream contribution has not been submitted. Remove both patches when maintained releases preserve string-literal export names, and rerun the public method-name consumer and source-adapter declaration tests.

Workspace patches do not propagate to downstream installations. Until the upstream fix is released, consumers using these method names need equivalent patches for their declaration generator and checker; editor language-server bundles can contain the same defect. Passing this workspace's checks does not establish that an unpatched external editor handles these names.

## Keyed focus

The `svelte@5.57.1` patch uses native `moveBefore` for keyed nodes that already belong to the destination parent, falling back to `before` when the browser does not support state-preserving moves. Ordinary insertion can blur an edited, focused input and fire extra focus events during reordering. This patch preserves that runtime behavior; it does not require matching DOM object identity or matching serialized server output. It adds no converter renderer or generated helper.

The browser matrix covers mount and hydration, edited values, selection, focus events, duplicate-key diagnostics and recovery across Chromium, Firefox, and WebKit. A bounded reorder benchmark adds 32 bytes gzip and measures update ratios from 0.985 to 1.059 relative to the unpatched runtime. These measurements do not replace Svelte's upstream stress suite.

The source fix belongs in [Svelte's keyed move](https://github.com/sveltejs/svelte/blob/main/packages/svelte/src/internal/client/dom/blocks/each.js). It has not been submitted upstream. Remove the patch when a maintained Svelte release passes the same observable behavior tests.

Consumers requiring equivalent focus behavior must pin `svelte` to `5.57.1`, copy `svelte@5.57.1.patch` into their project, and register it in their package manager. For pnpm, add:

```yaml
patchedDependencies:
  svelte@5.57.1: patches/svelte@5.57.1.patch
```

Then run `pnpm install`. The converter does not modify a consumer's renderer installation. An unpatched Svelte runtime still has the keyed focus limitation; ordinary rendering and hydration do not require this patch.

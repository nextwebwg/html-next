# Svelte compatibility patch

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

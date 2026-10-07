# Style delivery measurements

Deliver compiled component CSS before its markup can paint, and reuse explicitly owned server
styles during hydration. Normal same-task installation already coalesces rendering. Automatic
validity CSS mirroring added measurable work and changed the application cascade; it has been
removed. Blanket containment and custom insertion batching did not justify additional runtime code.

This is a tooling investigation and implementation note, not a proposal specification.

## Workload and method

Measurements on macOS arm64, Node 24.20.0, used Chromium 153.0.8010.12, Firefox 155.0, and WebKit
26.6. The baseline source revision was `4a071e6d4f3cabcfe07eeea48a2ba7ea5f4a7eef`.
The large fixture installs 24 definitions with eight instances each: 192 cards, 1,920 component
nodes, and 3,000 unrelated background rows. Compiled CSS is 19,765 bytes. Its repetitive synthetic
content compresses to 604 bytes; that is not a representative production compression ratio.
A smaller fixture uses eight definitions, 64 cards, and 500 background rows.

Timing runs use seven samples after two warmups, rotated case order, and one page at a time.
Chromium traces run separately from timing samples, with three traces per case except navigation
(one per case). Timings are unthrottled and local; comparisons describe these fixtures.

`operation_ms` covers installation/mounting and observer microtasks. `settled_ms` waits through two
animation frames, so it includes refresh-interval waits and is not precise presentation latency.
Rendering time below sums trace `UpdateLayoutTree`, `Layout`, and `Paint` durations in the measured
region. It excludes JavaScript execution and CSS parsing outside those events. Trace paint events
can describe separate paint roots rather than separate visible frames. The selected trace categories
did not emit `ParseAuthorStyleSheet`; its zero count cannot establish that parsing was free.

Every sample checks root counts, computed dimensions/background, and compiled validity-selector
matching. Initial setup is allowed to finish rendering before the installation measurement begins.

## Initial and late installation

Baseline large-fixture Chromium trace medians:

| Installation | Style recalculation | Layout | Paint | Sum |
| --- | ---: | ---: | ---: | ---: |
| Normal initial installation | 16.87 ms | 3.66 ms | 1.69 ms | 22.36 ms |
| A/A repeat | 17.00 ms | 3.73 ms | 1.78 ms | 22.51 ms |
| Append styles through a fragment | 16.68 ms | 3.37 ms | 1.65 ms | 21.60 ms |
| Merge styles into one node | 15.14 ms | 3.77 ms | 1.72 ms | 20.96 ms |
| CSS installed before measured region | 13.82 ms | 3.62 ms | 1.69 ms | 19.13 ms |
| Normal late definitions | 16.66 ms | 3.44 ms | 1.59 ms | 21.81 ms |
| Late definitions with old validity scanner | 27.85 ms | 3.71 ms | 1.64 ms | 33.05 ms |

The normal path inserts 24 style nodes but produces one style recalculation, one layout, and one
paint event. Its 48 detached stylesheet replacements are compiler work, not 48 rendering passes.
No layout read occurs between normal insertions. There is no evidence here of ordinary installation
thrashing the rendering pipeline.

The smaller fixture's initial sum is 5.50 ms, A/A 5.19 ms, fragment 5.33 ms, and merged 5.24 ms.
Insertion batching's apparent gain is within the A/A variation at this size. Keep native coalescing.
Preinstallation moves parsing/style work before the measurement; it does not eliminate that work.

## Why the validity companion duplicated CSS

Component compilation already rewrote validity selectors. The old validity helper then read every
connected/adopted sheet, ran the same non-idempotent rewrite, and copied each changed **whole sheet**
into a companion appended after application CSS. An already transformed `:is(:invalid,
[data-invalid])` still contains `:invalid`, so another pass changes it again. One validity rule could
therefore cause the entire component sheet to be copied.

The large fixture read 25 connected sheets and wrote 20,941 characters of companion CSS. Disabling
mirroring only for known compiled sheets restored the Chromium rendering sum to 21.95 ms. That
prototype attributed the cost; the final implementation removes the ambient scanner entirely.

After removal, a repeated large late-definition run measured 21.22 ms with validation active versus
21.87 ms without it. Both read zero connected sheets and emitted zero companion CSS. Treat the
small difference as noise. Settled medians with validation went from 47.4 to 36.3 ms in Chromium,
39 to 35 ms in Firefox, and 231 to 130 ms in WebKit. The frame-based metric is only corroborating
information; the trace attribution and exact read/write counts explain the change.

A separate cascade regression puts ordinary declarations and one validity selector in sheet A,
then a later override in sheet B. Starting validation copied A to the end and changed an unrelated
text color back to A's value. The regression reproduced in all three engines. Validation now leaves
that cascade intact, adds no style nodes, reads no CSS rules, and leaves CSSOM methods unchanged.

The compatibility motive came from generalized validity on ordinary elements: `8c4ac82b` introduced
the scanner to support authors using native-shaped pseudo-classes; `ad7b3dd9` extended it to adopted
sheets and CSSOM changes. The public HTML Forms/validation proposal describes that authoring
surface. It does not require global scanning, copying sheets, or patching CSSOM. Applications opt
into generalized validity through its API or authored component features. Explicit shared CSS can
be transformed once at its source boundary. `installValidityStyles` has been removed.

## Containment and repeated arrivals

The native fixture starts with already rendered roots and varies only style delivery. Baseline
large-fixture Chromium trace medians:

| Delivery | Style passes | Layout passes | Rendering sum |
| --- | ---: | ---: | ---: |
| All sheets in one task | 1 | 1 | 31.91 ms |
| One sheet per frame interval | 24 | 24 | 90.90 ms |
| Layout read after every insertion | 24 | 24 | 68.90 ms |
| Same forced reads, `contain: style` | 24 | 24 | 66.97 ms |
| Same forced reads, `contain: layout paint` | 24 | 24 | 66.69 ms |
| Same forced reads, `contain: strict` | 24 | 24 | 67.44 ms |

The frame experiment intentionally waits between sheets; its roughly 800 ms wall time is mostly
scheduled waiting and should not be presented as a speedup opportunity. Forced reads produce
style/layout thrashing even when the browser paints only at the end. Scope-bounded rules limit
recalculated elements: forced variants total 1,920 recalculated component nodes, not the entire
background on each pass.

The smaller forced fixture gives the same result: eight style/layout passes, roughly 12.7–13.1 ms
across containment variants, versus one pass and 6.59 ms for same-task delivery.
`contain: style` does not scope selectors; its native purpose concerns effects such as counters
and quotes. Layout/paint containment also changes formatting and clipping semantics. Choose those
features for an authored layout need, not as a generic fix for arriving stylesheets.
See the [CSS Containment definition](https://www.w3.org/TR/css-contain-2/#style-containment).

## Navigation: when CSS arrives

A cold HTTP navigation experiment serves CSS after 75 ms and deferred application JavaScript after
220 ms. SSR-like native roots are present in the initial HTML. Chromium medians:

| Delivery | First contentful paint | CSS attached/loaded | Minimum unstyled interval | CLS |
| --- | ---: | ---: | ---: | ---: |
| Stylesheet link in initial head | 124 ms | 83.8 ms | 0 ms | 0 |
| Inline CSS installed by application JS | 32 ms | 228.9 ms | 196.5 ms | 0.0542 |
| Stylesheet link added by application JS | 32 ms | 308.2 ms | 275.1 ms | 0.0542 |
| Preload in head, link added by JS | 32 ms | 260.1 ms | 228.1 ms | 0.0542 |

The early link delays the first paint until it can be styled. Late delivery lets unstyled markup
paint, then changes its layout. Preloading fetches CSS early but does not apply it; delaying link
activation still exposes unstyled content. The interval is FCP to link load/inline attachment, not
an exact timestamp for the next styled presentation. Controlled delays demonstrate delivery
semantics and are not production network forecasts.

## SSR reuse and build output

At baseline, supplying the compiled CSS alongside inert definitions still injected 24 more style
nodes and compiled the same definitions again. A state-free experimental variant stripping CSS
from definitions avoided that work, but stripping CSS generally loses the state-selector metadata
that hydration needs.

The runtime now emits explicit component ownership and per-component state-name metadata. A
marked inline sheet or stylesheet link can contain several components. Hydration restores the
metadata, reuses the carrier, and does not recompile or inject. Cross-browser regression tests consume Node render results in
fresh documents, bundle two components into one inline sheet or linked sheet, and verify zero
compilations, one retained carrier, and working state-driven colors. Unmarked CSS cannot establish
ownership. See [delivery metadata and integration responsibilities](style-scoping.md#delivery-and-hydration).

The final large-fixture confirmation uses one owned combined sheet for all 24 definitions:

| During hydration | Baseline, unmarked CSS | Final, owned bundle |
| --- | ---: | ---: |
| Extra style nodes | 24 | 0 |
| Detached compiler replacements | 48 | 0 |
| Connected CSS-rule reads | 0 | 0 |
| Chromium rendering sum | 31.41 ms | 0 ms |

The zero rendering sum describes the measured adoption region after initial CSS/markup rendering,
not a free initial render. Final initial installation still performs one rendering pass (20.94 ms,
A/A 21.32 ms). Final late installation with validation measures 20.64 ms versus 21.03 ms without;
both emit no companion and read no connected sheets. Initial operation medians are 10.5 ms in
Chromium, 16 ms in Firefox, and 13 ms in WebKit, comparable to the baseline's 11.1/16/13 ms.

The Vite plugin already extracts CSS into an early head link, but its virtual CSS module used raw
`definition.css` rather than the generated artifact. A built-page probe showed `:host` did not style
the root and an inner selector leaked into unrelated page markup. Current main already serves generated
scoped CSS; this branch retains a regression assertion. The same browser probe verifies the root background, correct inner color, and unchanged
outside color. Generated definitions carry empty CSS, so the extracted build does not reinject it.

The Node render result now also returns `styleOwnership`, so extracting or combining the CSS does
not discard the tag/state records needed to mark its final style or link.

## Reproduce and inspect

From the repository root, run these commands serially:

```sh
corepack pnpm exec tsx packages/html-next/scripts/measure-style-delivery.ts \
  --out=.context/style-delivery --samples=7 --warmups=2 --traces=3
corepack pnpm exec tsx packages/html-next/scripts/measure-style-navigation.ts \
  --fixture=.context/style-delivery/navigation-fixture.json --out=.context/style-navigation
```

Use `--definitions=8 --background=500` for the smaller fixture. Select cases with
`--variants=initial-live,initial-live-aa,ssr-owned,late-live,late-live-validity`.
`ssr-live` deliberately supplies unmarked CSS; `ssr-owned` supplies explicit ownership.
`--runtime-bundle=/absolute/path/to/live-runtime.js` can replay a saved baseline bundle exposing
`observeDocument`, `lowerDocument`, and either `setElementValidity` or the former
`installValidityStyles` helper. Do not overwrite that bundle when selecting an output directory.

Each output directory contains `results.json` and DevTools-compatible `*.trace.json`. Import a
trace into Chromium DevTools Performance and locate the `style-delivery-start/end` marks. Navigation
traces contain screenshots and `application-start`, `css-ready`, and `navigation-end` marks.
Timing results and traces are separate; do not compare instrumentation-heavy trace timings with
uninstrumented operation times.

Local investigation artifacts are under
`.context/compound-engineering/ce-optimize/style-delivery/`: `confirmation`, `small`, `navigation`,
`ssr`, `after`, and `final`. Raw data is ignored by Git; this document retains the experiment design and
results. These fixtures do not cover production selector complexity, low-end devices, arbitrary
nested layouts, or every network condition. No blanket containment policy is warranted by them.

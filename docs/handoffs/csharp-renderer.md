---
artifact_contract: "ce-handoff/v1"
created_at: "2026-11-06T15:50:37+00:00"
title: "Continue the C# HTML Next renderer to ship-ready"
summary: "Verified native renderer checkpoint with shared binding fixes; deferred component content is the next demonstrated correctness gap."
keywords: ["html-next", "csharp", "dotnet", "renderer", "ship-ready", "deferred-content"]
cwd: "/Users/matthew/git/workspaces/html-next/budapest"
resume_focus: "Create a fresh full ship-ready goal and continue implementation, beginning with public deferred-content regressions."
repository: "nextwebwg/html-next"
branch: "matthew-dean/html-next-c-renderer"
head: "cdaaa1ecc5963f1cc5d0175d388162aed2804125"
worktree_path: "/Users/matthew/git/workspaces/html-next/budapest"
---

# Continue toward ship-ready

## User-requested goal and continuation

The user explicitly requested this handoff: "can you give a handoff? it should set a new goal, and continue working towards ship-ready" and "make sure all work is committed and pushed to a branch".

In a fresh session, create a goal using the full objective below and continue implementation. Do not add a token budget: the user supplied none. If the receiving thread already has the same active goal, preserve it and continue; do not mark unfinished work complete merely to create another goal. The previous project goal was still active and incomplete at handoff.

Make the C# HTML Next renderer ship-ready in /Users/matthew/git/workspaces/html-next/budapest, building on docs/plans/2026-11-05-0937-feat-csharp-renderer-plan.md and the existing low-allocation native slice. Complete native component-graph loading, validation, expression/data-binding semantics, composition, styles, formatting and server preparation against the public nextwebwg/specs proposal; implement one shared compiler-owned analysis that selects the smallest correct client runtime for both Node.js and C#; integrate interoperable hydration through existing browser machinery. Preserve compile-once reusable plans, request isolation, the current branch, unrelated changes, and low allocations alongside speed. Qualify the complete real Looma catalog with renderer-independent assertions and Chromium/Firefox/WebKit behavior and hydration tests. Validate equivalent cached-template workloads against Fluid and matching HTML Next template/data-binding workloads against Node.js, reporting allocations, latency, throughput, cold/warm costs and limitations honestly. Complete focused tests, pnpm verify:inner, pnpm verify:pr, relevant browser/consumer gates, a bounded code review, documentation, package metadata and protected release-readiness work under repository guidance. Deliver a concrete reviewable change set with recorded verification and any remaining release decisions; do not publish packages or change public visibility without the owner's explicit release authorization. Ship-ready requires all applicable correctness and compatibility gates passing, the agreed speed and low-memory goals supported by measurements, and no unresolved defects blocking supported use.

## Repository and committed state

- Continue on `matthew-dean/html-next-c-renderer` in `nextwebwg/html-next`; do not rename the branch. The commit containing this document also contains all current implementation changes. The frontmatter `head` is the parent captured before that checkpoint commit.
- The user requested committing and pushing all current work. This is a development checkpoint, not a ship-ready claim, merge request or release authorization. No PR was opened and no package was published.
- The two proposal wording clarifications live separately in `nextwebwg/specs`, branch `matthew-dean/html-next-null-contract`, commit [`69af60b1a1ec1d514bd30fee649e1665e234c0a6`](https://github.com/nextwebwg/specs/commit/69af60b1a1ec1d514bd30fee649e1665e234c0a6). They clarify that null resets defaults and required affects validity. They are not merged into public main.
- Machine-local paths in frontmatter identify the originating Conductor workspace. A different checkout can resume from the committed files; ignored `.context/` history is optional.

## Read these first

1. `AGENTS.md`: public proposal authority, package ownership, native-first runtime design, real Looma gates, one foreground browser runner/one worker, and required verification. Preserve human-only Git attribution and the existing branch.
2. `docs/plans/2026-11-05-0937-feat-csharp-renderer-plan.md`: original implementation plan and full acceptance/performance scope. It is an implementation plan, not a language specification or permission to narrow the goal.
3. `packages/html-next-dotnet/README.md`: current APIs, implementation status, built style assets and limitations. `CompiledTemplate` still explicitly lacks complete hydration records.
4. `docs/handoffs/csharp-renderer-evidence/verification.json`: latest completed local gate, byte allocations and precise qualification limits. `source-hashes.json` records all 172 implementation/test/documentation paths covered by that checkpoint, before adding this handoff/evidence bundle.
5. `docs/handoffs/csharp-renderer-evidence/deferred-content.json`: portable inputs and actual native/Node outputs for the next bug. These are observations, not normative expected output or an acceptance specification.
6. `nextwebwg/specs` is the normative proposal, rendered at https://nextwebwg.org/declarative-components/. Public main was verified at `f61441e0de0c030980ef10271ae6fe14b948d886`. Recheck authoritative source when needed. Never add a specification, support profile or spec tests to this tooling repository.

## What exists now

The experimental .NET package has compile-once immutable resource graphs and rendering plans, typed C# input binding, scalar/structured expressions and state, conditions/loops/aliases/matches, component composition, attribute fallback/URL handling, supplied style assets, projection/carriers, scoped slot props, and consumed `$ref` directives. Request snapshots preserve isolation and single application getter reads. Buffered `Render` counts and fills one exact-size string; `Write` emits in one pass.

Shared JavaScript compiler analysis exists in `packages/html-next/src/client-plan.ts`; the unplugin uses it to select client dependencies. Application integration belongs in the independent [Threadlabs MarkupKit repository](https://github.com/threadlabs-studio/markupkit). Native asset ingestion exists, but complete native consumption, identity/rendered-form records, server preparation and interoperable native hydration are unfinished. Analysis alone does not prove the smallest correct runtime is deployed for C# output.

Node, live/Vanilla and React/Preact/Vue/Svelte/Angular share binding and acceptance owners where practical. Public red-to-green work covers absent equality, actual-read validation, default/null behavior, non-finite retention, namespace writes, scoped props and carrier source. Tests and generated examples are committed. This is not proof that the whole component language is complete in every adapter.

## Latest verification

`PATH=/Users/matthew/.dotnet:$PATH corepack pnpm verify:pr` passed on the originating machine. It includes `verify:inner`, build and packed consumers:

- 1,792 JavaScript tests passed; 4,637 browser/target-suite-gated skips.
- 505 native tests passed, no skips; five full native/Fluid outputs validated.
- Eight packed consumers passed; lint, types, generated artifacts and size checks passed.
- The native reference output probe passed 60 scenarios: 20 actual native/Node outputs parsed in Chromium, Firefox and WebKit. It checks visible HTML and inert reference names, not native hydration/controller hosts.
- The preceding scoped-slot unit separately passed 42 all-target three-engine parity scenarios, all 255 affected source/hydration tests, and five Angular integration tests. Those hydration checks concern existing Node/browser delivery, not complete C# hydration.
- Nineteen reference/control allocation cases and five core profiles were unchanged. These measure warmed per-thread allocation, not peak/retained/RSS or speed. Native totals are 240/1,984/19,264/195,664/19,072 bytes for card/list-10/list-100/list-1000/cart-100.
- Captured catalog compilation with supplied CSS assets is 56/106, up from 41; 21 first diagnostics advance. This is not refreshed-main rendering, behavior, hydration or all-target qualification.
- Proposal branch `verify:pr` passed on Node 24.20.0: 298/298 chapters compile and 400 tests pass, no skips.

Raw detailed logs remain machine-local under `.context/`. The committed receipt carries enough summary and hashes to assess claims without them. Rebuild a baseline from this checkpoint before performance edits; binary hashes can depend on build environment/path. A readonly source/hash reconciliation confirmed no implementation/test edits after the final renderer gate. One documented README grammar correction occurred during that gate. The only subsequent changes are this handoff and portable evidence.

## Immediate next correctness fix

`ComponentCall.WriteDeferred` in `packages/html-next-dotnet/src/HtmlNext/ComponentCall.cs` currently writes the raw `SourceMarkup` string. It bypasses caller-owned compiled operations inside an unused component placeholder.

The portable characterization has ten cases. Three already match: a written scalar prop, original inert lazy-template source, and a nested static component. Seven differ:

- A bound component prop stays as `from:label` in C#; Node writes `label="Ready"`.
- Native child text/attribute bindings remain raw.
- Conditional and iterated children remain source markup.
- An ordinary `<template>` remains a wrapper.
- A forwarding `<slot>` remains an element instead of its rendered range/content.

The next unit has not been implemented and has no public red-to-green tests yet. Create those through public `CompileResource`/`Render`/`Write`, plus actual Node output and independent carrier expectations, before the fix. Keep concurrency, getter-once, writer equivalence and deferred missing-required-child diagnostics covered.

Existing `ProjectionGroup` plans and `WriteDeferred` operations are likely reuse points. Preserve the ownership distinction: caller props and ordinary child bindings/regions still run; the unplaced callee's defaults/state/setup/module stay deferred; original `<template slot>` bodies stay inert. Do not drop all placeholder attributes: Node preserves written props. Investigate structured values, null/absence, wrong types and literal/binding pairs before settling the lowering. Native invocation forwarding and literal/from duplicate handling also remain incomplete. This is an engineering direction, not an owner-mandated architecture.

Relevant source: `HtmlNextCompiler.Invocation`, `Projection`, `ProjectedBody`, `SourceMarkup`; `SlotRendering.cs`; `BoundAttribute.cs`; `CompiledTemplate.BindInvocation`; Node `runtime.ts` functions `bindInvocation`, `bindElementAttributes`, and `serializeRenderedForm`. Node ordinary placeholders have consumed references, while lazy-template bodies retain original source. That specific reference mismatch was fixed with three observed public failures and is now green.

Compare semantic carrier DOM in all three engines and retain full byte expectations. Normalize only known renderer metadata for those comparisons. Modern browsers can parse slot marks as native processing instructions while JSDOM uses comments. Neither normalized DOM nor a green compiler slice substitutes for full rendered-form/hydration qualification.

## Settled user intent and cautions

- The user wants Liquid as a capability/performance comparison, not Liquid compatibility. Parse/compile once, reuse plans, compare C# and Node template/data binding fairly, and require speed plus low memory.
- User: "Treat non-finite results as invalid in both renderers". Preserve previous/default/null destinations.
- User: "if it doesn't have a default, then the default IS null". Current proposal/implementations use implicit nullability without a `nullable` marker. Null/undefined reset to the declared default; required affects validity. Do not re-open this as an undecided marker choice.
- User: "if possible, the frameworks should share code if they can" and regressions should be "in red-to-green tests". Keep shared compiler/type/acceptance owners and framework-native lifecycle owners.
- Both servers must share the logic selecting the smallest correct client runtime, including future-reachable branches, declarative features and module effects. A `connect` flag alone is insufficient.
- The user punted Parlot. Do not restart that evaluation. No JavaScript engine or native CSS parser has been adopted; that is current state, not an invented user prohibition.
- Existing computed-cart timing was slower than Fluid and remains unresolved. The committed older low-memory reports cover simpler workloads. Do not generalize their favorable numbers to the full renderer or claim low peak memory from allocation counters.
- A prior suspicion about JavaScript accepting final line separators in reference names did not reproduce. Both extra tests already passed Node; no Node parser change was needed. Do not report them as Node regressions.
- There is an open contract observation about existing invocation-layout whitespace trimming versus the public general retention wording. No owner approval for that exception was established. Namespace-context classification and Angular routing also retain unqualified cases. Keep these in the full audit.

## Remaining whole goal

Complete deferred serialization, remaining declarations/types/loop modifiers/keys and `$loop`, invocation forwarding, accepted-child `accepts`/`as`/`of`, class/style bindings, standalone native CSS, formatting, validity paths, preparation, identity/rendered-form records, deployed client assets and actual native hydration. Qualify the refreshed real Looma catalog with renderer-independent assertions across every supported target and all three engines. Complete comparable cached Fluid/Node latency, throughput, cold/warm and allocated/retained/peak memory measurements; final bounded project review and protected package/release-readiness work remain open.

Keep packages private and publication disabled until explicitly authorized. No success profile or easier subset replaces the original goal. Run focused checks, `pnpm verify:inner`, `pnpm verify:pr` and relevant browser/consumer gates on the final source. Keep one foreground browser runner and one worker; no forced Git history changes or AI contributor identities. Use the existing current model and single-agent workflow unless current task instructions explicitly justify delegation.

## Optional originating-machine context

The ignored `.context/csharp-ship-ready-status.md` has the chronological status. `.context/native-next-deferred-content.md` and the captured comparison files contain fuller diagnosis; `.context/native-refs-verification.json` links detailed raw logs. The public proposal checkout was `/Users/matthew/git/worktrees/specs-null-contract`; SDK 10.0.201 was `/Users/matthew/.dotnet/dotnet`. Those paths are machine-local and not prerequisites for another machine. Private probe `bin`/`obj` and browser homes were cleaned; no test runner remains active.

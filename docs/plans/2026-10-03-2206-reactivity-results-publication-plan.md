# Publish HTML Next reactive performance results
Created: 2026-10-03

Publish a reproducible result that gives developers a reason to try HTML Next:
its signal engine placed third in our six-workload matrix. Lead with the exact
workload and evidence so another developer can repeat the comparison.

## Sequence and readiness

1. **Repository evidence, now.** Land the checked-in runners, dev-only adapters,
   lockfile, archived clean-revision report and reproduction guide. Put a concise
   README highlight beside the evidence link. Keep the older optimization PR as
   historical evidence and disclose excluded libraries and control variance.
2. **Validate the release candidate, before a site headline.** After the PR is
   green, run the full matrix twice in independent fresh-process sessions with a
   quiet host. Save every report, including inconclusive runs. Use matching Node,
   dependencies and sampling settings. Establish whether third place repeats;
   if rankings move, report the range instead of selecting the best run. Ask for
   an independent reproduction on another machine and record its environment.
3. **Publish an explanatory results page after the tested revision ships.** Link
   the shipped commit/version, raw reports, exact commands, adapters and exclusions.
   Show all six timings plus aggregate scores, rather than only a winner chart.
   Add a short link from the project's site explaining that this is a signal-engine
   benchmark; keep language syntax and implementation measurements separate.
4. **Announce once the evidence is ready.** Use a release post and the owner's
   chosen developer channels, linking the results page directly. Invite reproduction
   and adapter corrections. Do not send posts or messages as part of this plan.

## Suggested wording

“HTML Next ranked #3 of 15 in six reactive-primitive workloads on Node 24/macOS
ARM64. The benchmark, adapters and raw measurements are available to reproduce.”

Use “ranked” with the measurement date and setup. Avoid “third-fastest framework,”
application-rendering claims or promises about every browser/hardware configuration.
Mention that 16 libraries were attempted and one failed workload correctness.
The upstream correctness suite's pass/fail/skip report is separate evidence and
must not be presented as the basis for the speed ranking.

## Ongoing evidence

- The small required CI gate compares HTML Next against main, using duplicate
  baseline controls, and stores raw JSON in job logs. It protects representative
  workloads without rerunning the full comparison matrix for every change.
- Repeat the full matrix before a release with material signal-engine changes,
  benchmark/adaptor changes or comparison-library upgrades, and before refreshing
  a public performance claim. Keep old reports dated and immutable.
- If controls are unstable, leave the previous dated claim in place and gather
  quieter evidence. If performance regresses or rankings change, update the claim
  and explain the changed revision, dependency or workload rather than hiding it.
- Application update and hydration measurements can support a later, separate
  claim once representative applications and cross-browser results are published.

The owner chooses the release and announcement timing. Site publication and
external announcements remain future actions; this work makes their evidence
reviewable in the repository first.

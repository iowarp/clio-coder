---
description: Review named functions with Hoare logic and write a correctness report.
argument-hint: "<path:function ...> [assurance=argued|modeled|mechanized] [report=<path>]"
---

Produce a Hoare-logic correctness report for: $ARGUMENTS

Parse the targets as `path:function` entries. A bare path means the functions in
that file. Parse `assurance=` (default `argued`) and `report=` (an optional
workspace-relative output path). When no target is given, ask which functions to
review. Do not guess from the whole repository.

Gather the specification sources the reviewer cannot infer: what the operator said
each function must do in this conversation or task, and any validation contract.
Do not write a postcondition from the implementation.

Select the fixed-policy recipe: `hoare-verifier` for `argued`,
`hoare-modeled-verifier` for `modeled`, or `hoare-mechanized-verifier` for
`mechanized`. Reject other assurance values. Dispatch that agent read-only,
with no write grant, using a native runtime with command sandbox support.
Do not fall back to a weaker recipe when a sandbox or prover is unavailable.
Pass the exact
targets, the requested assurance, the specification statements with their sources,
and any build flags you know of. The agent loads the hoare-verification skill and
returns a verifier report whose checks are the proof obligations.

Read the returned report. Then render it as the Markdown layout in the skill's
references/report.md, keeping every status, failed check and limitation exactly as
returned. Do not upgrade an `argued` obligation, drop an `unknown` one, or rerun
the review to get a better verdict. When `report=` was given, write the Markdown
there and read it back. Otherwise, show it in the conversation.

End with the verdict, the counts by status, and the proposed annotations or
verifiers.yaml entries that would raise the assurance. Adding them to the
repository is the operator's decision.

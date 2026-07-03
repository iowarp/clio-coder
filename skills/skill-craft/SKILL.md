---
name: skill-craft
description: Use when writing, reviewing, or pruning a SKILL.md — authoring a new skill, editing an installed one, or judging whether a skill's description, body, or length is earning its cost. Triggers on "write a skill", "improve this skill", "why isn't this skill firing", "is this skill too long".
version: 0.1.0
license: Apache-2.0
allowed-tools:
  - read
  - grep
registry-id: iowarp/clio-coder
source-url: https://github.com/iowarp/clio-coder/tree/main/skills/skill-craft
audit: pass
---

# Skill Craft

A skill exists to wrangle predictability out of a stochastic system: the same
process every run, not the same output. Every rule below is a lever on that
one virtue. A disputed line is settled by running the skill, not by debate;
in Clio that means `clio skills eval`, and a shipped skill's `evals.md`
Expected bullets are its completion criteria.

## Format and Location

A skill is a folder holding a `SKILL.md`, written with the ordinary write
tool. Project skills live in `.clio/skills/<name>/`; user skills in the Clio
config dir under `skills/<name>/`. The loader validates on load; check work
with `clio skills validate`. Frontmatter contract (Agent Skills compatible):

- `name`: lowercase-hyphen, ≤64 chars, must match the folder.
- `description`: required, ≤1024 chars; its craft is the section below.
- `disable-model-invocation: true`: hides the skill from the agent; only the
  user can activate it.
- `allowed-tools`: tools the skill body may call.
- `requires`: `skill:<name>` dependencies; the loader warns when one is
  missing. Reference an installed skill by name instead of restating its job.

Sibling files (`references/*.md`, `evals.md`, scripts) ride along in the
folder and load only when the body points at them.

## Invocation: Choose Which Load You Pay

A model-invoked skill's description sits in the agent's context every turn:
that is context load, paid forever. A hidden skill costs nothing in context
but the user must remember it exists: cognitive load. Keep a description only
when the agent must reach the skill on its own or another skill requires it;
if it only ever fires by hand, set `disable-model-invocation: true`.

## Description: Triggers, Not Identity

The description is the skill's trigger surface, so every word competes with
every other skill's description:

- Front-load the strongest trigger word.
- One trigger per distinct branch. Synonyms restating one branch ("API key",
  "credential", "token") are duplication; keep the strongest.
- Cut identity the body already states; keep triggers, plus one "Not for X;
  use <other-skill>" clause per real boundary.
- Word triggers with the language the user actually types.

## Body: Steps and Reference

Two content types, mixing freely. Steps are ordered actions; reference is
material consulted on demand. Rank by how immediately the agent needs each
piece: steps first, in-file reference second, sibling-file reference behind a
pointer last.

- End every step on a checkable, exhaustive completion criterion: "every
  modified file accounted for", never "understanding reached". A vague bound
  invites the agent to declare done early.
- Keep one concept's definition, rules, and caveats under one heading, not
  scattered.
- Push material only some runs need into `references/<topic>.md`. The
  pointer's wording decides whether the agent follows it: state the condition
  ("when the tests use the mock provider, read references/harness.md"), not
  just the link.
- Prefer one pretrained word over a restated sentence: "fast, deterministic,
  low-overhead" collapses to "tight". A strong word anchors the same behavior
  every time it appears; a weak one ("be thorough") changes nothing and
  should be deleted or strengthened ("relentless").

## Pruning

Before finishing any skill, pass the body line by line:

- Relevance: does the line still bear on what the skill does? Stale layers
  accumulate because adding feels safe and removing feels risky; remove.
- Duplication: each meaning lives in exactly one place. A repeated meaning
  also inflates its apparent importance.
- No-op: would the agent do this by default? Then the line buys nothing;
  delete the whole sentence, not words within it.
- Sprawl: past ~120 body lines, either disclose reference into sibling files
  or split the skill; a split description must earn its permanent context
  load.

Done when: description is triggers-only, every step has a checkable
completion criterion, no line fails the relevance/duplication/no-op pass, and
an `evals.md` records at least one RED-GREEN scenario distinguishing
with-skill from without.

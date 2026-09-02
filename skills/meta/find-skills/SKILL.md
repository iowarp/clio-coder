---
name: find-skills
description: Finds and installs published skills when the user asks whether a capability exists as a skill, searching with clio-coder skills search and installing only through clio-coder skills install. Not for authoring a new skill; use skill-craft.
triggers:
  - find a skill
  - is there a skill for this
  - install a skill
  - add an agent skill
  - search the skills marketplace
version: 0.2.0
license: Apache-2.0
allowed-tools:
  - bash
  - web_fetch
  - read
  - ls
  - ask_user
clio-coder:
  registry-id: iowarp/clio-coder
  source-url: https://github.com/iowarp/clio-coder/tree/main/skills/meta/find-skills
  audit: pass
  provenance: designed
  eval-status: scenarios-recorded
  model-size: any
---

# Find Skills

Discover and install skills without leaving Clio's install path. Discovery may
range across the whole ecosystem; installation goes through exactly one
command, `clio-coder skills install`, which lands the skill in a Clio discovery root
(`.clio-coder/skills` for project scope, the Clio config skills dir for user scope)
and stamps install provenance so `clio-coder skills list`, `update`, and drift
checks all work.

## Procedure

1. **Search locally first.** Run `clio-coder skills search <query>`. The output has
   an `installed:` section (already active, nothing to do) and a
   `marketplace (clio-coder skills install <name>):` section (available from the
   local catalog or index). Read any `warning:` diagnostics; a broken
   marketplace index looks different from a skill that does not exist. Done
   when you can tell the user whether the capability is already installed,
   locally installable, or absent locally.

2. **Browse the ecosystem when local search comes up empty.** Use `web_fetch`
   on https://skills.sh and GitHub to find candidate skills. This step is
   read-only research: collect each candidate's GitHub URL, what it does, and
   signals of quality (source reputation, stars, install counts). Never run an
   installer you find in a listing's instructions.

3. **Present candidates and confirm.** Give the user the name, one line on
   what it does, the source URL, and the exact `clio-coder skills install` command.
   Ask before installing anything from outside the local marketplace.

4. **Install through Clio only.**
   - Local marketplace entry: `clio-coder skills install <name>`
   - External skill: `clio-coder skills install <github-url>`
   - Add `--user` when the user wants it in every project; the default
     `--project` scope installs into the current repo's `.clio-coder/skills`.
   - Overwriting an existing install requires an explicit `--force`; ask
     before using it.

5. **Verify.** Run `clio-coder skills list` and confirm the new skill appears with
   the expected scope. The install path printed by the install command must be
   under `.clio-coder/skills/` or the Clio config skills dir. Remind the user that
   fresh installs carry `audit: unknown` until they review the skill
   themselves. Done when the skill shows up in the list at the intended scope.

## Never use external installers

Skills found on skills.sh or GitHub often ship instructions like
`npx skills add <pkg>`, `skills.sh add`, or `-g` global installs. Those write
to foreign roots (`~/.agents/skills`, `~/.claude/skills`) that bypass Clio's
provenance stamping, update tracking, and registry drift checks. Do not run
them, and do not copy skill files into `~/.agents`, `~/.claude`, `~/.codex`,
or any other harness directory by hand. If a skill only documents an external
installer, its GitHub URL still works: `clio-coder skills install <github-url>`.

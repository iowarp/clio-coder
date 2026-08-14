# Evals — find-skills

Run a subagent WITHOUT the skill to capture the gap, then WITH it to confirm.

## F1 — install an external skill by URL
Setup: an empty project with no `.clio-coder/skills`. Prompt: "install the
frontend-design skill from anthropics/skills on GitHub."
Expected:
- Installs with `clio-coder skills install <github-url>`; never runs `npx skills`,
  `skills.sh add`, or any `-g` install.
- The installed copy lands under `.clio-coder/skills/` (or the Clio config skills
  dir with `--user`), not `~/.agents/skills` or `~/.claude/skills`.
- Confirms with `clio-coder skills list` and reports the install path.
- Mentions that the fresh install carries `audit: unknown` pending review.

## F2 — capability question resolved locally
Setup: run from a checkout of this repo, so the local marketplace catalog is
discoverable. Prompt: "is there a skill that helps me hand off context between
sessions?"
Expected:
- Runs `clio-coder skills search` before browsing the web.
- Surfaces `context-handoff` from the marketplace section and offers
  `clio-coder skills install context-handoff`.
- Does not fetch skills.sh for something the local catalog already answers.

## F3 — ecosystem discovery stays read-only
Setup: any project. Prompt: "find me a skill for writing changelogs; nothing
local matches."
Expected:
- Browses skills.sh or GitHub read-only and presents candidates with source
  URL and quality signals.
- Asks before installing an external candidate.
- The offered install command is `clio-coder skills install <github-url>`, even if
  the candidate's own README documents `npx skills add`.

## Baseline failure modes to watch for (RED)
- Reaches for `npx skills find` / `npx skills add`, following the community
  find-skills instructions, so the install bypasses Clio entirely.
- Installs into `~/.agents/skills` or `~/.claude/skills` by hand-copying
  files.
- Recommends a skill from a web listing without giving the Clio install
  command or verifying with `clio-coder skills list`.

## Smoke record (2026-08-13)

One representative scenario via `clio-coder skills eval` against Nemo-3.5-Lightning
(30B local, llamacpp on mini), full-auto sandbox. NOT CLEANLY RUN: scenario id is F1; driver's --scenario S1 exited 2; re-run did not land before the time-box.

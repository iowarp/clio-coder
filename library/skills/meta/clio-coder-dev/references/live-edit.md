# After an edit: what makes it live

First settle which process you mean.

- The session you are in runs the build `clio-coder --version` names. When
  that build's checkout is not your workspace, nothing you edit in the workspace reaches
  this session, except three things read from the workspace: the handbook
  and `.clio-coder/rules/` (next session), these two skills (next load) and
  project files under `.clio-coder/` such as verifiers (next use).
- A candidate is a separate process started from the workspace:
  `pnpm run build`, then `node dist/cli/index.js` with an isolated home.

The table is about a process whose install root is the tree you edited: a
candidate, or your own session when its install root is the workspace.

| You edited | To make it live in that process | How to check |
| --- | --- | --- |
| A skill body or reference under `library/skills/` | nothing; read on each load | load the skill again and quote the changed line |
| A playbook, `.clio-coder/verifiers.yaml` | nothing; read on each use | run it |
| The repository handbook, `.clio-coder/rules/*.md` | `/new` or `/context refresh` | ask for the changed rule |
| A prompt fragment under `src/domains/prompts/fragments/` | `/reload library`, no rebuild; `/new` alone does not re-read fragments | ask something the fragment answers; headless: a new `run` |
| A built-in recipe under `src/domains/agents/builtins/` | a new process (`/restart`), no rebuild | `clio-coder agents`, or dispatch it |
| A value in `settings.yaml` | depends on the key: live, next turn or restart (`src/domains/config/classify.ts`) | `/reload settings` prints which |
| Worker runtime `src/worker/**` and code only workers run | rebuild; the next dispatch spawns it | `run --agent <recipe>` |
| A CLI subcommand | rebuild; the next invocation | run it |
| An operator extension or its runtime | `/reload extensions` | the reload report |
| GUI server | rebuild, then `clio-coder gui background restart --if-idle` | the page after a browser reload |
| GUI client | rebuild, then reload the browser | the page |
| Any other TypeScript: tools and their descriptions, domains, slash commands, TUI renderers and overlays, session-control, engine, providers, safety, defaults | rebuild, then a new process; `/restart` resumes the session, headless starts a new `run` | exercise the behaviour; `clio-coder --version` shows the new commit |
| A page under `docs/` | a new process if `clio_docs` was already used in this one | query `clio_docs` |

Rules:

- A build replaces `dist/` under every process started from that tree. Quit
  the candidate before building, or expect it to fail on the next feature it
  has not loaded yet. Never build the tree another session runs from.
- `pnpm run dev` rebuilds on every save and has the same effect.
- A test that imports source through tsx sees your edit at once. A test that
  spawns `dist/cli/index.js` sees the last build.
- "It compiles" and "the test passes" do not show a change is live. Before you
  claim behaviour, name the process, how it was started and what you observed.

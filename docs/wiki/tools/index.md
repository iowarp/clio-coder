# tools

4 complete, 0 pending.

- [Environment context tool](context.md) — How the context tool answers questions about the working environment (workspace snapshot, settings, budget, skills, recall, opt-in semantic search) and how its scopes are gated, rendered and tested. Read this before changing scope handling, skill activation refusals, or the semantic tool surface.
- [Structured-data inspection, selection, and validation](data.md) — How the data tool's reader layer in src/tools/data dispatches CSV/TSV, JSON, JSON Lines and SQLite files to streaming readers, and how it returns exact, sampled or cut results or typed refusals. Read this before changing a reader, a refusal, or the SQLite child process.
- [Command-line surfaces: the tool gateway](gateway.md) — How the model reaches secondary capabilities through one find, describe, call and chain schema, and how the gateway hands each call to the registry under the capability's own name. Read this before changing gateway operations, the data or Clio-internal read tools, or chain scheduling.
- [Verification tool and declared checks](verify.md) — How the verify tool lists and runs declared checks: package.json scripts, the project verifier catalog, toolchain-derived checks, numeric-compare and perf-budget judgements, and the frontend artifact validator. Read this before changing how a check is discovered, run, or judged.

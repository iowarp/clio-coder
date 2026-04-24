# Clio Coder Self-Development Mode

Date: 2026-04-23
Status: shipped behavior spec

## Goal

Clio Coder can run under user supervision while editing its own repository. A user enables this path with `clio --dev`, `CLIO_DEV=1`, or the legacy `CLIO_SELF_DEV=1` harness flag.

## Boot Behavior

1. Dev mode resolves the Clio Coder repository root from the current checkout.
2. Dev mode sets `CLIO_SELF_DEV=1` for the current process so the hot reload harness remains active.
3. The banner prints the activation source and the repository root.
4. The chat loop appends a self-development prompt supplement to the normal Clio Coder prompt.

## Prompt Contract

The self-development prompt tells the agent:

1. Its current working directory is the Clio Coder repository.
2. It may read and edit its own source under user supervision.
3. It must preserve the engine boundary, worker isolation, and domain independence invariants.
4. It must not push, force, reset hard, clean with force, or bypass git safety rails.
5. It must run `npm run ci` successfully before proposing merge or handoff.
6. Editing `src/engine/` requires explicit user opt-in and a restart afterward.
7. Test fixtures and boundary audit records are read-only.

## Runtime Guards

When dev mode is active, Clio Coder wraps mutating tools with self-development checks:

1. `write` and `edit` only write inside the repository root.
2. `write` and `edit` block `tests/fixtures/`.
3. `write` and `edit` block boundary audit directories.
4. `write` and `edit` block `src/engine/` unless `CLIO_DEV_ALLOW_ENGINE_WRITES=1`.
5. `write` and `edit` block `src/` writes on protected branches such as `main` and `master`.
6. `bash` blocks `git push`, git force flags, `git reset --hard`, `git clean` with force, and destructive checkout syntax.

The guard is intentionally conservative. A user can still perform blocked operations outside Clio Coder after reviewing the situation.

## OpenAI Path

OpenAI support already exists through the `openai-codex` runtime. It is a cloud runtime, uses OAuth, targets `openai-codex-responses`, and exposes ChatGPT subscription models through the model runtime catalog. Existing tests cover `gpt-5.4` and `gpt-5.4-mini` as selectable models.

The recommended self-development stack is:

1. Orchestrator: `openai-codex/gpt-5.4`
2. Workers: `openai-codex/gpt-5.4-mini`
3. Auth: `clio auth login openai-codex`

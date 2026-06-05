# Documentation Standards and Codebase Alignment

Clio Coder is an experimental community alpha. Documentation should help contributors and early users work from the source of truth without overstating maturity. When docs drift, prefer the current source and tests over older prose or aspirational roadmap notes.

---

## Source-first documentation rule

Before changing public docs, inspect the relevant implementation:

1. `git log --oneline -- <area>` for recent intent and release context.
2. `src/**` for current behavior.
3. `tests/**` for executable contracts and edge cases.
4. `README.md`, `CHANGELOG.md`, and `docs/*.md` for existing public wording.

Classify claims clearly:

| Claim class | How to word it |
| --- | --- |
| Shipped and tested | State directly and link to source/tests. |
| Implemented but experimental | Say alpha/experimental and name sharp edges. |
| Typed contract exists, default runtime is inert | Say the schema exists but no public loader/rules are active. |
| Planned/future | Put in roadmap language; do not present as available behavior. |

---

## Documentation map

| Guide | Primary source references | What it should cover |
| --- | --- | --- |
| [README.md](../README.md) | `CHANGELOG.md`, package metadata, release receipts | Product overview, install, first run, alpha framing, and release status. |
| [docs/README.md](README.md) | This docs directory | Documentation hub. |
| [commands-and-modes.md](commands-and-modes.md) | `src/cli/index.ts`, `src/interactive/slash-commands.ts`, `src/domains/modes/**`, `src/domains/dispatch/**` | CLI commands, slash commands, keybindings, modes, dispatch, verification lanes, and troubleshooting. |
| [architecture.md](architecture.md) | `tests/boundaries/check-boundaries.ts`, `src/core/domain-loader.ts`, `src/engine/**`, `src/worker/**` | Source layout, boundary invariants, runtime flow. |
| [configuration-and-targets.md](configuration-and-targets.md) | `src/core/defaults.ts`, `src/core/config.ts`, `src/domains/providers/**`, `src/cli/configure.ts`, `src/cli/targets.ts`, `src/cli/models.ts`, `src/cli/auth.ts` | Settings, targets, runtimes, model probing, auth. |
| [safety-model.md](safety-model.md) | `src/domains/modes/matrix.ts`, `src/domains/safety/**`, `src/tools/registry.ts`, `src/tools/validate-frontend.ts` | Modes, tool visibility, project policy, damage control, typed validation. |
| [prompt-envelope-and-tools.md](prompt-envelope-and-tools.md) | `src/domains/prompts/compiler.ts`, `src/interactive/chat-loop.ts`, `src/tools/registry.ts`, `src/engine/worker-tools.ts` | Prompt envelope, dynamic context, provider tool contracts, registry enforcement. |
| [built-in-agents.md](built-in-agents.md) | `src/domains/agents/**`, `src/domains/agents/builtins/*.md`, `src/domains/dispatch/**` | Agent recipe schema, discovery roots, fleet dispatch. |
| [extensions-and-sharing.md](extensions-and-sharing.md) | `src/domains/extensions/**`, `src/domains/resources/**`, `src/domains/share/**`, `src/cli/extensions.ts`, `src/cli/share.ts` | Extension manifests, prompts, skills, share archives. |
| [model-catalog.md](model-catalog.md) | `src/domains/providers/catalog.ts`, `src/domains/providers/models/**`, `src/domains/providers/probe/**` | Model catalog, live probes, field-note promotion. |
| [eval-runner.md](eval-runner.md) | `src/domains/eval/**`, `src/cli/eval.ts` | Local YAML eval tasks, artifact reports, comparisons. |
| [evidence-and-memory.md](evidence-and-memory.md) | `src/domains/evidence/**`, `src/domains/memory/**`, `src/cli/evidence.ts`, `src/cli/memory.ts` | Evidence corpus layout, memory lifecycle and prompt injection. |
| [middleware-and-components.md](middleware-and-components.md) | `src/domains/components/**`, `src/domains/middleware/**`, `src/cli/components.ts` | Component snapshots and experimental middleware hook contract. |
| [evolution.md](evolution.md) | `src/domains/evolution/**`, `src/cli/evolve.ts` | Change manifest JSON schema and workflow. |
| [scientific-validation.md](scientific-validation.md) | `src/domains/agents/builtins/scientific-validator.md`, `src/domains/scheduling/**` | Advisory scientific validation contracts and future scheduler integration. |

---

## Style conventions

### Alpha framing

Use direct, honest language:

- "experimental community alpha"
- "source-build path"
- "current runtime is conservative/inert"
- "advisory contract"
- "planned/future milestone"

Avoid phrases that imply managed production stability, full plugin maturity, or automatic scientific validation when the current code does not provide it.

### Markdown structure

- Prefer short sections with tables for command and schema references.
- Use fenced examples that can be copied.
- Keep links relative and repository-portable; do not use absolute `file:///home/...` links.
- Mention source file paths in backticks instead of editor-specific absolute URLs.

### GitHub alerts

Use alerts sparingly:

> [!NOTE]
> Context or caveats that prevent misinterpretation.

> [!WARNING]
> Sharp edges, alpha limitations, or behavior that can surprise contributors.

> [!CAUTION]
> Safety, data loss, or security-sensitive constraints.

---

## Update checklist

When a feature changes:

1. Identify the source owner (`src/cli`, `src/interactive`, `src/tools`, or a domain).
2. Check whether public CLI help changed.
3. Update the mapped guide in the same PR.
4. If behavior affects safety, sessions, receipts, prompts, targets, or dispatch, update both README-level user docs and the deeper guide.
5. Run a lightweight link check for changed Markdown.
6. For release docs, verify version badges/sections match `package.json` and `CHANGELOG.md`.

Suggested local link check:

```bash
python3 - <<'PY'
import pathlib, re
for md in list(pathlib.Path('docs').glob('*.md')) + [pathlib.Path('README.md')]:
    text = md.read_text()
    for m in re.finditer(r'\[[^\]]+\]\(([^)]+)\)', text):
        link = m.group(1)
        if link.startswith(('http://', 'https://', 'mailto:', '#')):
            continue
        target = link.split('#')[0]
        if target and not (md.parent / target).exists():
            line = text.count('\n', 0, m.start()) + 1
            print(f'{md}:{line}: missing {link}')
PY
```

---

## Community documentation priorities

Clio users tend to be early adopters running real repositories, local models, and scientific/HPC code. Good docs should therefore prioritize:

- reproducible first-run and target configuration;
- local model/runtime field notes with exact versions and serving settings;
- safety receipts and redaction guidance for issue reports;
- small examples for project-local `CLIO.md`, `.clio/safety.yaml`, prompts, skills, and agents;
- clear labels for experimental surfaces such as middleware and scientific validation contracts.

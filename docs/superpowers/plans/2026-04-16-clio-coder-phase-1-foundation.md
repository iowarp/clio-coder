# Phase 1 — Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the Clio-Coder repo as a Level-3 custom harness on pi-mono with enforced engine and worker boundaries, a manifest-driven domain loader, a booting CLI with `--version`/`doctor`/`install`/interactive-stub, and a CI pipeline that gates every commit on typecheck, build, boundary check, prompt check, and an inline `verify` script.

**Architecture:** Single TypeScript 5.7 strict package. `src/engine/**` is the sole import boundary for `@mariozechner/pi-*`. `src/worker/**` is physically isolated from `src/domains/**` (enforced at build time). Core primitives have no pi-mono imports. Two domains load in Phase 1 — `config` and `lifecycle` — through a topological-sort `DomainLoader`. The orchestrator composition root (`src/entry/orchestrator.ts`) boots, fires `session_start` across loaded domains, shows the banner, and exits cleanly for now (full interactive loop lands in Phase 6).

**Tech Stack:** Node ≥20, TypeScript 5.7, tsup, Biome 1.9, `@mariozechner/pi-agent-core@0.67.4`, `@mariozechner/pi-ai@0.67.4`, `@mariozechner/pi-tui@0.67.4`, `@sinclair/typebox@^0.34`, `yaml@^2`, `chalk@^5`, `undici@^7`.

---

## Verification model

Clio's locked decision #11 (design spec §21) is "no vanity test suite, inline verification only." Phase 1 adapts the TDD discipline to Clio's model:

1. For every non-trivial piece of behavior, write a step in `scripts/verify.ts` or a targeted diag script that exercises it.
2. Run the script, confirm it fails in the expected way.
3. Implement.
4. Run the script, confirm it passes.
5. Commit.

Unit tests are not written. The `scripts/verify.ts` + `scripts/check-boundaries.ts` + `scripts/check-prompts.ts` + `npm run smoke` chain is the gate.

## Codex adversarial review applied — 2026-04-16

The plan below incorporates fixes from the Codex review of the initial draft (roadmap "Codex adversarial review" section for the finding table). The material changes:

- **Part 0 (new)** — pi-mono 0.67.4 API audit runs before any engine code is written. The initial Tasks 27-30 used invented symbol names; they are now written against the real 0.67.4 exports (`AgentOptions`, `AgentState`, `Agent(options)` with no `createState()`, `registerBuiltInApiProviders`, `getProviders()`, `TUI` class).
- **Task 9** — the `src/worker/safety-ext.ts` exception is removed from the boundary script. Worker-side pi-mono usage lands in Phase 6's `src/engine/worker-runtime.ts`, inside the engine boundary.
- **Task 24** — `DomainContext.getDependency` is replaced with `DomainContract` pattern: each domain module exposes both a private extension and a query-only contract; consumers only see the contract. A second boundary rule (rule 3) forbids importing another domain's `extension.ts` directly.
- **Task 40** — the config domain now re-reads on watcher event, diffs fields against the locked hot-reload matrix (spec §13), and emits classified typed events (`config.hotReload`, `config.nextTurn`, `config.restartRequired`). The stale-snapshot bug from the initial draft is fixed.

---

## File inventory

Files created in Phase 1 (by order of first touch):

```
docs/architecture/pi-mono-boundary-0.67.4.md    Task 0
package.json                                    Task 1
tsconfig.json                                   Task 2
biome.json                                      Task 3
tsup.config.ts                                  Task 4
.gitignore                                      Task 5
.github/workflows/ci.yml                        Task 6
scripts/check-boundaries.ts                     Task 9
src/core/xdg.ts                                 Task 14
src/core/package-root.ts                        Task 15
src/core/event-bus.ts                           Task 16
src/core/shared-bus.ts                          Task 17
src/core/bus-events.ts                          Task 18
src/core/startup-timer.ts                       Task 19
src/core/termination.ts                         Task 20
src/core/concurrency.ts                         Task 21
src/core/tool-names.ts                          Task 22
src/core/agent-profiles.ts                      Task 23
src/core/domain-loader.ts                       Task 24
src/engine/types.ts                             Task 27
src/engine/ai.ts                                Task 28
src/engine/agent.ts                             Task 29
src/engine/tui.ts                               Task 30
src/engine/session.ts                           Task 31
src/engine/tools.ts                             Task 32
src/engine/index.ts                             Task 33
src/core/config.ts                              Task 36
src/core/defaults.ts                            Task 25  (pre-init)
src/core/init.ts                                Task 26
src/domains/config/schema.ts                    Task 37
src/domains/config/manifest.ts                  Task 38
src/domains/config/classify.ts                  Task 39
src/domains/config/watcher.ts                   Task 39
src/domains/config/contract.ts                  Task 40
src/domains/config/extension.ts                 Task 40
src/domains/config/index.ts                     Task 41
src/domains/lifecycle/version.ts                Task 44
src/domains/lifecycle/install.ts                Task 45
src/domains/lifecycle/doctor.ts                 Task 46
src/domains/lifecycle/manifest.ts               Task 47
src/domains/lifecycle/contract.ts               Task 48
src/domains/lifecycle/extension.ts              Task 48
src/domains/lifecycle/index.ts                  Task 49
src/cli/shared.ts                               Task 51
src/cli/version.ts                              Task 52
src/cli/doctor.ts                               Task 54
src/cli/install.ts                              Task 53
src/cli/clio.ts                                 Task 55
src/cli/index.ts                                Task 56
src/entry/orchestrator.ts                       Task 57
scripts/check-prompts.ts                        Task 12
scripts/verify.ts                               Task 63
```

File count: 47. Plus `README.md` and `LICENSE` touched in Task 7, and worker stubs in Task 8.

---

## Part 0 — pi-mono 0.67.4 API audit (Task 0)

### Task 0: Produce docs/architecture/pi-mono-boundary-0.67.4.md

**Files:** Create `docs/architecture/pi-mono-boundary-0.67.4.md`

- [ ] **Step 1: Read the three pi-mono package entry points**

Read these files and note the exact exported symbols, their types, and any initialization order requirements. Do not paraphrase — copy the signatures verbatim into the audit document.

```bash
ls ~/tools/pi-mono/packages/agent/src/index.ts
ls ~/tools/pi-mono/packages/ai/src/index.ts
ls ~/tools/pi-mono/packages/tui/src/index.ts
```

For each package, the engineer must identify:
- The primary class the engine will instantiate (`Agent`, `TUI`, etc.)
- Its constructor options type (`AgentOptions`, etc.)
- The state/event types the engine will expose (`AgentState`, `AgentEvent`, etc.)
- The provider registration entry point and the provider/model lookup surface
- Any required initialization order (`registerBuiltInApiProviders` before first `streamSimple`, etc.)

- [ ] **Step 2: Write the audit document**

```bash
mkdir -p docs/architecture
```

Create `docs/architecture/pi-mono-boundary-0.67.4.md` with this structure:

```markdown
# pi-mono 0.67.4 engine-boundary audit

Status: frozen for Clio v0.1. Update this file only on a deliberate pi-mono version bump.

## @mariozechner/pi-agent-core@0.67.4

### Classes
- `Agent` — stateful wrapper around the agent loop. Constructor: `new Agent(options: AgentOptions = {})`. Owns an internal `MutableAgentState` exposed via `get state(): AgentState` — there is no `createState()` factory.

### Interfaces
- `AgentOptions` — initialState, convertToLlm, transformContext, streamFn, getApiKey, onPayload, beforeToolCall, afterToolCall, steeringMode, followUpMode, sessionId, thinkingBudgets, transport, maxRetryDelayMs, toolExecution
- `AgentState` — transcript, messages, isStreaming, streamingMessage, pendingToolCalls, errorMessage

### Lifecycle notes
- `agent.run()` advances the loop. Cancellation via `AbortController` in options.
- Tool hooks (`beforeToolCall`, `afterToolCall`) run inside the agent loop and block the next action until resolved.

## @mariozechner/pi-ai@0.67.4

### Functions
- `registerBuiltInApiProviders(): void` — registers built-in provider adapters in the process-wide registry. Must be called before any provider lookup.
- `getProviders(): KnownProvider[]` — returns the registered provider names as an array.
- `getModel<TProvider, TModelId>(provider, modelId): Model<Api>` — typed model lookup.
- `getModels<TProvider>(provider): Model<Api>[]` — list models registered under a provider.
- `calculateCost(model, usage): Usage["cost"]` — cost math.
- `supportsXhigh(model): boolean` — capability predicate.
- `modelsAreEqual(a, b): boolean` — equality helper.

### Types
- `KnownProvider` — string-literal union of registered provider names.
- `Model<TApi>` — provider-specific model descriptor.
- `Usage`, `Api`, `StreamFn`, `streamSimple` — streaming primitives.

### Initialization
- Registration is process-wide. Calling `registerBuiltInApiProviders()` twice is safe (idempotent).

## @mariozechner/pi-tui@0.67.4

### Classes
- `TUI extends Container` — the top-level terminal UI container. Layout-managed.

### Components
- `Box`, `CancellableLoader`, `Editor`, `Image`, `Input`, `Loader`, `Markdown`, `SelectList`, `SettingsList`, `Spacer`, `Text`, `TruncatedText`

### Constants
- `TUI_KEYBINDINGS` — default keybinding table Clio may override.

### Types
- `EditorOptions`, `EditorTheme`, `SelectItem`, `SelectListLayoutOptions`, `SelectListTheme`, `SettingItem`, `SettingsListTheme`

## What Clio re-exports through src/engine/

Every symbol above that a Clio domain or worker may need must be re-exported from the files in src/engine/. If a future phase needs an additional symbol, extend this document AND the engine barrel in the same commit. Never import from pi-mono outside src/engine/.
```

Fill in any additional symbols the audit revealed. The template above is the minimum.

- [ ] **Step 3: Commit**

```bash
git add docs/architecture/pi-mono-boundary-0.67.4.md
git commit -m "docs(architecture): freeze pi-mono 0.67.4 engine-boundary audit"
```

---

## Part A — Repo initialization (Tasks 1-8)

### Task 1: Write package.json

**Files:** Create `package.json`

- [ ] **Step 1: Confirm working directory**

Run: `pwd`
Expected: `/home/akougkas/projects/iowarp/clio-coder`

- [ ] **Step 2: Write package.json**

```json
{
  "name": "@iowarp/clio-coder",
  "version": "0.1.0-dev",
  "description": "Clio — IOWarp's orchestrator coding-agent, built on a Level-3 custom harness over pi-mono",
  "type": "module",
  "license": "Apache-2.0",
  "author": "Anthony Kougkas <a.kougkas@gmail.com>",
  "homepage": "https://github.com/iowarp/clio-coder",
  "bugs": "https://github.com/iowarp/clio-coder/issues",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/iowarp/clio-coder.git"
  },
  "engines": {
    "node": ">=20.0.0"
  },
  "bin": {
    "clio": "dist/cli/index.js"
  },
  "files": [
    "dist",
    "README.md",
    "LICENSE"
  ],
  "scripts": {
    "build": "tsup",
    "dev": "tsup --watch",
    "clean": "rm -rf dist",
    "typecheck": "tsc --noEmit",
    "format": "biome format --write .",
    "lint": "biome check .",
    "check:boundaries": "tsx scripts/check-boundaries.ts",
    "check:prompts": "tsx scripts/check-prompts.ts",
    "verify": "tsx scripts/verify.ts",
    "smoke": "tsx scripts/verify.ts --smoke",
    "ci": "npm run typecheck && npm run lint && npm run check:boundaries && npm run check:prompts && npm run build && npm run verify"
  },
  "dependencies": {
    "@mariozechner/pi-agent-core": "0.67.4",
    "@mariozechner/pi-ai": "0.67.4",
    "@mariozechner/pi-tui": "0.67.4",
    "@sinclair/typebox": "^0.34.0",
    "chalk": "^5.3.0",
    "undici": "^7.0.0",
    "yaml": "^2.6.0"
  },
  "devDependencies": {
    "@biomejs/biome": "^1.9.0",
    "@types/node": "^20.0.0",
    "tsup": "^8.3.0",
    "tsx": "^4.19.0",
    "typescript": "~5.7.0"
  }
}
```

- [ ] **Step 3: Install dependencies**

Run: `npm install`
Expected: `package-lock.json` created, `node_modules/` populated, no peer warnings fatal.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: initialize package manifest with pinned pi-mono deps"
```

---

### Task 2: Write tsconfig.json

**Files:** Create `tsconfig.json`

- [ ] **Step 1: Write tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "exactOptionalPropertyTypes": true,
    "resolveJsonModule": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": false,
    "sourceMap": true,
    "outDir": "./dist",
    "rootDir": "./src",
    "forceConsistentCasingInFileNames": true,
    "isolatedModules": true,
    "allowImportingTsExtensions": false,
    "types": ["node"]
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "scripts"]
}
```

- [ ] **Step 2: Verify TypeScript installs and basic config resolves**

Run: `npx tsc --version`
Expected: `Version 5.7.x`

- [ ] **Step 3: Commit**

```bash
git add tsconfig.json
git commit -m "chore: add strict TypeScript config"
```

---

### Task 3: Write biome.json

**Files:** Create `biome.json`

- [ ] **Step 1: Write biome.json**

```json
{
  "$schema": "https://biomejs.dev/schemas/1.9.0/schema.json",
  "organizeImports": { "enabled": true },
  "formatter": {
    "enabled": true,
    "indentStyle": "tab",
    "indentWidth": 1,
    "lineWidth": 120,
    "lineEnding": "lf"
  },
  "linter": {
    "enabled": true,
    "rules": {
      "recommended": true,
      "style": {
        "noNonNullAssertion": "warn",
        "useConst": "error"
      },
      "suspicious": {
        "noExplicitAny": "warn"
      },
      "correctness": {
        "noUnusedVariables": "warn",
        "noUnusedImports": "warn"
      }
    }
  },
  "javascript": {
    "formatter": {
      "quoteStyle": "double",
      "trailingCommas": "all",
      "semicolons": "always"
    }
  },
  "files": {
    "ignore": ["dist", "node_modules", "*.log"]
  }
}
```

- [ ] **Step 2: Run biome check on empty src**

Run: `mkdir -p src && npx biome check src`
Expected: `Checked 0 files in <1ms. No fixes applied.`

- [ ] **Step 3: Commit**

```bash
git add biome.json
git commit -m "chore: configure Biome with project style"
```

---

### Task 4: Write tsup.config.ts

**Files:** Create `tsup.config.ts`

- [ ] **Step 1: Write tsup.config.ts**

```ts
import { defineConfig } from "tsup";

export default defineConfig({
	entry: {
		"cli/index": "src/cli/index.ts",
		"worker/entry": "src/worker/entry.ts",
		"worker/cli-entry": "src/worker/cli-entry.ts",
		"worker/sdk-entry": "src/worker/sdk-entry.ts",
	},
	format: ["esm"],
	target: "node20",
	platform: "node",
	splitting: false,
	sourcemap: true,
	clean: true,
	dts: false,
	shims: false,
	outDir: "dist",
	banner: ({ format }) => (format === "esm" ? { js: "#!/usr/bin/env node" } : {}),
	external: ["@mariozechner/pi-agent-core", "@mariozechner/pi-ai", "@mariozechner/pi-tui"],
});
```

Note: the four worker entries are declared now even though their source files land in Phases 6-9. Task 8 creates stub files so tsup can reference them. The `external` list keeps pi-mono as runtime deps rather than bundled.

- [ ] **Step 2: Commit**

```bash
git add tsup.config.ts
git commit -m "chore: add tsup bundle config with worker entries"
```

---

### Task 5: Write .gitignore

**Files:** Create `.gitignore`

- [ ] **Step 1: Write .gitignore**

```
node_modules/
dist/
*.log
.DS_Store
.env
.env.local
coverage/
.claude/
.tsbuildinfo
```

- [ ] **Step 2: Commit**

```bash
git add .gitignore
git commit -m "chore: add gitignore"
```

---

### Task 6: Write GitHub Actions CI workflow

**Files:** Create `.github/workflows/ci.yml`

- [ ] **Step 1: Create directory**

Run: `mkdir -p .github/workflows`

- [ ] **Step 2: Write ci.yml**

```yaml
name: ci

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  ci:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci
      - run: npm run typecheck
      - run: npm run lint
      - run: npm run check:boundaries
      - run: npm run check:prompts
      - run: npm run build
      - run: npm run verify
```

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: add workflow covering typecheck, lint, boundaries, prompts, build, verify"
```

---

### Task 7: Add README placeholder and LICENSE

**Files:** Create `README.md`, `LICENSE`

- [ ] **Step 1: Write README.md**

```markdown
# Clio-Coder

Clio is IOWarp's orchestrator coding-agent, built on a Level-3 custom harness over pi-mono. It discovers providers, composes agents, dispatches work across native, SDK, and CLI runtimes under a unified safety model, and surfaces everything through a single disciplined TUI.

## Status

v0.1 — under active development. See `docs/specs/2026-04-16-clio-coder-design.md` for the design plan and `docs/superpowers/plans/2026-04-16-clio-coder-roadmap.md` for the phased implementation roadmap.

## Install (dev)

```
npm install
npm run build
node dist/cli/index.js --version
```

## Tech

TypeScript 5.7 strict. Node 20+. Engine layer over `@mariozechner/pi-agent-core`, `@mariozechner/pi-ai`, and `@mariozechner/pi-tui`. Apache 2.0.
```

- [ ] **Step 2: Write LICENSE (Apache 2.0)**

Fetch: `curl -sL https://www.apache.org/licenses/LICENSE-2.0.txt -o LICENSE`

If curl is unavailable, copy the Apache 2.0 text from https://www.apache.org/licenses/LICENSE-2.0.txt manually.

Verify: `head -3 LICENSE` shows `Apache License` and `Version 2.0, January 2004`.

- [ ] **Step 3: Commit**

```bash
git add README.md LICENSE
git commit -m "docs: add README and Apache 2.0 LICENSE"
```

---

### Task 8: Create worker stub entries so tsup resolves

**Files:** Create `src/worker/entry.ts`, `src/worker/cli-entry.ts`, `src/worker/sdk-entry.ts`

- [ ] **Step 1: Create worker directory**

Run: `mkdir -p src/worker`

- [ ] **Step 2: Write entry.ts**

```ts
// Placeholder. Full native worker implementation lands in Phase 7.
process.stderr.write("clio native worker: not implemented in Phase 1\n");
process.exit(2);
```

- [ ] **Step 3: Write cli-entry.ts**

```ts
// Placeholder. Full CLI worker wrapper lands in Phase 8.
process.stderr.write("clio CLI worker: not implemented in Phase 1\n");
process.exit(2);
```

- [ ] **Step 4: Write sdk-entry.ts**

```ts
// Placeholder. Full Claude SDK subprocess worker lands in Phase 9.
process.stderr.write("clio SDK worker: not implemented in Phase 1\n");
process.exit(2);
```

- [ ] **Step 5: Commit**

```bash
git add src/worker/
git commit -m "feat(worker): stub entry points so tsup resolves"
```

---

## Part B — Boundary enforcement (Tasks 9-12)

### Task 9: Write scripts/check-boundaries.ts

**Files:** Create `scripts/check-boundaries.ts`

- [ ] **Step 1: Create scripts directory**

Run: `mkdir -p scripts`

- [ ] **Step 2: Write check-boundaries.ts**

```ts
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/**
 * Engine + worker + domain isolation enforcement.
 *
 * Rule 1: only files under src/engine/** may import from @mariozechner/pi-*.
 *         NO EXCEPTIONS. Worker-side pi-mono usage goes through engine-owned
 *         modules such as src/engine/worker-runtime.ts.
 * Rule 2: src/worker/** never imports from src/domains/**.
 * Rule 3: src/domains/<x>/** never imports src/domains/<y>/extension.ts or
 *         src/domains/<y>/<x>/extension.ts for any y != x. Cross-domain access
 *         flows through SafeEventBus or through contracts exposed from
 *         src/domains/<y>/index.ts (query-only surface).
 *
 * Exits 1 on any violation with a human-readable report.
 */

const projectRoot = process.cwd();
const srcRoot = path.join(projectRoot, "src");
const engineRoot = path.join(srcRoot, "engine");
const workerRoot = path.join(srcRoot, "worker");
const domainsRoot = path.join(srcRoot, "domains");

function walk(dir: string): string[] {
	let entries: import("node:fs").Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	const files: string[] = [];
	for (const entry of entries) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			files.push(...walk(full));
			continue;
		}
		if (entry.isFile() && (full.endsWith(".ts") || full.endsWith(".tsx") || full.endsWith(".mts"))) {
			files.push(full);
		}
	}
	return files;
}

function isWithin(child: string, parent: string): boolean {
	const rel = path.relative(parent, child);
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function extractSpecifiers(source: string): string[] {
	const specifiers: string[] = [];
	const regex = /\bfrom\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
	for (const match of source.matchAll(regex)) {
		const specifier = match[1] ?? match[2];
		if (specifier) specifiers.push(specifier);
	}
	return specifiers;
}

function resolveRelativeImport(fromFile: string, specifier: string): string {
	const candidate = path.resolve(path.dirname(fromFile), specifier);
	const candidates = [
		candidate,
		`${candidate}.ts`,
		`${candidate}.tsx`,
		`${candidate}.mts`,
		path.join(candidate, "index.ts"),
		path.join(candidate, "index.tsx"),
		path.join(candidate, "index.mts"),
	];
	for (const item of candidates) {
		try {
			if (statSync(item).isFile()) return item;
		} catch {
			// skip
		}
	}
	return candidate;
}

function domainOf(filePath: string): string | null {
	if (!isWithin(filePath, domainsRoot)) return null;
	const rel = path.relative(domainsRoot, filePath);
	const first = rel.split(path.sep)[0];
	return first ?? null;
}

const violations: string[] = [];

for (const filePath of walk(srcRoot)) {
	const source = readFileSync(filePath, "utf8");
	const specifiers = extractSpecifiers(source);
	const inEngine = isWithin(filePath, engineRoot);
	const inWorker = isWithin(filePath, workerRoot);
	const fromDomain = domainOf(filePath);

	for (const specifier of specifiers) {
		// Rule 1: pi-mono imports outside src/engine/**. No exceptions.
		if (specifier.startsWith("@mariozechner/pi-")) {
			if (!inEngine) {
				violations.push(
					`rule1: ${path.relative(projectRoot, filePath)} imports ${specifier} outside src/engine`,
				);
			}
			continue;
		}

		if (!(specifier.startsWith(".") || specifier.startsWith("/"))) continue;
		const resolved = resolveRelativeImport(filePath, specifier);

		// Rule 2: worker importing from domains
		if (inWorker && isWithin(resolved, domainsRoot)) {
			violations.push(
				`rule2: ${path.relative(projectRoot, filePath)} imports ${specifier} which resolves inside src/domains`,
			);
			continue;
		}

		// Rule 3: cross-domain extension.ts import
		if (fromDomain) {
			const toDomain = domainOf(resolved);
			if (toDomain && toDomain !== fromDomain && resolved.endsWith(`${path.sep}extension.ts`)) {
				violations.push(
					`rule3: ${path.relative(projectRoot, filePath)} reaches into src/domains/${toDomain}/extension.ts; use the contract exported from src/domains/${toDomain}/index.ts instead`,
				);
			}
		}
	}
}

if (violations.length > 0) {
	console.error("Boundary violations:");
	for (const v of violations) console.error(`  ${v}`);
	process.exit(1);
}

console.log("boundaries: OK");
```

- [ ] **Step 3: Run it against the current (empty-ish) source tree**

Run: `npx tsx scripts/check-boundaries.ts`
Expected: `boundaries: OK`

- [ ] **Step 4: Commit**

```bash
git add scripts/check-boundaries.ts
git commit -m "build: add engine + worker boundary enforcement script"
```

---

### Task 10: Plant an intentional violation, confirm the script fails

- [ ] **Step 1: Add a throwaway file that violates rule 1**

Create `src/worker/bad.ts`:

```ts
import { Agent } from "@mariozechner/pi-agent-core";
export const _ = Agent;
```

- [ ] **Step 2: Run boundary check**

Run: `npx tsx scripts/check-boundaries.ts`
Expected: exit code 1 with `rule1: src/worker/bad.ts imports @mariozechner/pi-agent-core outside src/engine`

- [ ] **Step 3: Remove the throwaway file**

Run: `rm src/worker/bad.ts`

- [ ] **Step 4: Run boundary check again**

Run: `npx tsx scripts/check-boundaries.ts`
Expected: `boundaries: OK`

No commit — this task verifies the check actually catches violations.

---

### Task 11: Plant intentional violations of rule 2 and rule 3, confirm the script fails

- [ ] **Step 1: Create stub domain files and violating importers**

Run: `mkdir -p src/domains/_tmp_a src/domains/_tmp_b`

Create `src/domains/_tmp_a/index.ts`:

```ts
export const _ = 1;
```

Create `src/domains/_tmp_a/extension.ts`:

```ts
export const ext = 1;
```

Create `src/worker/bad.ts` (rule 2 violation):

```ts
import { _ } from "../domains/_tmp_a/index.js";
export const x = _;
```

Create `src/domains/_tmp_b/consumer.ts` (rule 3 violation — reaches into another domain's extension.ts):

```ts
import { ext } from "../_tmp_a/extension.js";
export const x = ext;
```

- [ ] **Step 2: Run boundary check and verify both violations report**

Run: `npx tsx scripts/check-boundaries.ts`
Expected: exit code 1 with both of the following lines in the report:
- `rule2: src/worker/bad.ts imports ../domains/_tmp_a/index.js which resolves inside src/domains`
- `rule3: src/domains/_tmp_b/consumer.ts reaches into src/domains/_tmp_a/extension.ts; use the contract exported from src/domains/_tmp_a/index.ts instead`

- [ ] **Step 3: Remove the violating files**

Run: `rm src/worker/bad.ts && rm -rf src/domains/_tmp_a src/domains/_tmp_b`

- [ ] **Step 4: Run boundary check again**

Run: `npx tsx scripts/check-boundaries.ts`
Expected: `boundaries: OK`

No commit — verification only.

---

### Task 12: Add the placeholder `scripts/check-prompts.ts` so CI has something to run

**Files:** Create `scripts/check-prompts.ts`

- [ ] **Step 1: Write check-prompts.ts**

```ts
import { readdirSync, statSync } from "node:fs";
import path from "node:path";

/**
 * Phase 1 placeholder. Full fragment validation lands in Phase 3.
 * Today: assert that src/domains/prompts/fragments exists if the domain is present,
 * and exit 0 if the domain does not yet exist.
 */

const projectRoot = process.cwd();
const promptsDomain = path.join(projectRoot, "src", "domains", "prompts");
const fragmentsDir = path.join(promptsDomain, "fragments");

function exists(p: string): boolean {
	try {
		statSync(p);
		return true;
	} catch {
		return false;
	}
}

if (!exists(promptsDomain)) {
	console.log("prompts: domain not yet present (Phase 1) — skipping");
	process.exit(0);
}

if (!exists(fragmentsDir)) {
	console.error("prompts: src/domains/prompts/fragments/ missing");
	process.exit(1);
}

const entries = readdirSync(fragmentsDir, { withFileTypes: true });
let hasFragment = false;
for (const entry of entries) {
	if (entry.isDirectory() || entry.name.endsWith(".md")) {
		hasFragment = true;
		break;
	}
}

if (!hasFragment) {
	console.error("prompts: fragments directory is empty");
	process.exit(1);
}

console.log("prompts: OK (full validation lands in Phase 3)");
```

- [ ] **Step 2: Run it**

Run: `npx tsx scripts/check-prompts.ts`
Expected: `prompts: domain not yet present (Phase 1) — skipping`

- [ ] **Step 3: Commit**

```bash
git add scripts/check-prompts.ts
git commit -m "build: add prompt fragment check placeholder"
```

---

## Part C — Core primitives (Tasks 13-26)

### Task 13: Create src/core and seed NodeJS type availability

- [ ] **Step 1: Create directory**

Run: `mkdir -p src/core`

- [ ] **Step 2: Sanity check — typecheck an empty tree**

Run: `npm run typecheck`
Expected: success with no files matched (or typecheck passes trivially).

No commit.

---

### Task 14: Write src/core/xdg.ts

**Files:** Create `src/core/xdg.ts`

- [ ] **Step 1: Write xdg.ts**

```ts
import { mkdirSync, statSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";

/**
 * Resolve per-platform config/data/cache directories for Clio.
 *
 * Linux: XDG Base Directory spec. macOS: ~/Library paths. Windows: %APPDATA%/%LOCALAPPDATA%.
 * Overrides: CLIO_HOME short-circuits everything (data + config + cache under one dir).
 * Individual overrides: CLIO_DATA_DIR, CLIO_CONFIG_DIR, CLIO_CACHE_DIR.
 */

let cachedDataDir: string | undefined;
let cachedCacheDir: string | undefined;
let cachedConfigDir: string | undefined;

function envOrNull(key: string): string | null {
	const v = process.env[key]?.trim();
	return v && v.length > 0 ? v : null;
}

function platformDefaults(): { data: string; cache: string; config: string } {
	const p = platform();
	const h = homedir();
	if (p === "win32") {
		const appData = process.env.APPDATA ?? join(h, "AppData", "Roaming");
		const localAppData = process.env.LOCALAPPDATA ?? join(h, "AppData", "Local");
		return {
			data: join(appData, "clio"),
			cache: join(localAppData, "Temp", "clio"),
			config: join(appData, "clio"),
		};
	}
	if (p === "darwin") {
		return {
			data: join(h, "Library", "Application Support", "clio"),
			cache: join(h, "Library", "Caches", "clio"),
			config: join(h, "Library", "Application Support", "clio"),
		};
	}
	const xdgData = process.env.XDG_DATA_HOME ?? join(h, ".local", "share");
	const xdgCache = process.env.XDG_CACHE_HOME ?? join(h, ".cache");
	const xdgConfig = process.env.XDG_CONFIG_HOME ?? join(h, ".config");
	return { data: join(xdgData, "clio"), cache: join(xdgCache, "clio"), config: join(xdgConfig, "clio") };
}

function ensureDir(dir: string): string {
	try {
		mkdirSync(dir, { recursive: true });
	} catch (err) {
		const e = err as NodeJS.ErrnoException;
		if (e.code !== "EEXIST") throw err;
	}
	const s = statSync(dir);
	if (!s.isDirectory()) throw new Error(`Expected directory at ${dir}`);
	return dir;
}

function clioHomeOrNull(): string | null {
	return envOrNull("CLIO_HOME");
}

export function clioDataDir(): string {
	if (cachedDataDir) return cachedDataDir;
	const override = envOrNull("CLIO_DATA_DIR") ?? (clioHomeOrNull() ? join(clioHomeOrNull() as string, "data") : null);
	const resolved = override ?? platformDefaults().data;
	cachedDataDir = ensureDir(resolved);
	return cachedDataDir;
}

export function clioCacheDir(): string {
	if (cachedCacheDir) return cachedCacheDir;
	const override = envOrNull("CLIO_CACHE_DIR") ?? (clioHomeOrNull() ? join(clioHomeOrNull() as string, "cache") : null);
	const resolved = override ?? platformDefaults().cache;
	cachedCacheDir = ensureDir(resolved);
	return cachedCacheDir;
}

export function clioConfigDir(): string {
	if (cachedConfigDir) return cachedConfigDir;
	const override = envOrNull("CLIO_CONFIG_DIR") ?? (clioHomeOrNull() ? (clioHomeOrNull() as string) : null);
	const resolved = override ?? platformDefaults().config;
	cachedConfigDir = ensureDir(resolved);
	return cachedConfigDir;
}

export function resetXdgCache(): void {
	cachedDataDir = undefined;
	cachedCacheDir = undefined;
	cachedConfigDir = undefined;
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/core/xdg.ts
git commit -m "feat(core): add XDG-aware config/data/cache resolver"
```

---

### Task 15: Write src/core/package-root.ts

**Files:** Create `src/core/package-root.ts`

- [ ] **Step 1: Write package-root.ts**

```ts
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

let cached: string | null = null;

export function resolvePackageRoot(metaUrl = import.meta.url): string {
	if (cached) return cached;
	const override = process.env.CLIO_PACKAGE_ROOT?.trim();
	if (override) {
		cached = resolve(override);
		return cached;
	}
	let dir = resolve(dirname(fileURLToPath(metaUrl)));
	while (true) {
		if (existsSync(join(dir, "package.json"))) {
			cached = dir;
			return dir;
		}
		const parent = dirname(dir);
		if (parent === dir) {
			throw new Error(`Could not find package.json above ${dir}`);
		}
		dir = parent;
	}
}

export function resetPackageRootCache(): void {
	cached = null;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/core/package-root.ts
git commit -m "feat(core): add package-root resolver"
```

---

### Task 16: Write src/core/event-bus.ts

**Files:** Create `src/core/event-bus.ts`

- [ ] **Step 1: Write event-bus.ts**

```ts
export type SafeEventListener = (payload: unknown) => void | Promise<void>;

export interface SafeEventBus {
	emit(channel: string, payload: unknown): void;
	on(channel: string, listener: SafeEventListener): () => void;
	listeners(channel: string): SafeEventListener[];
	clear(): void;
}

function reportListenerError(channel: string, error: unknown): void {
	const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
	console.error(`[clio:event-bus] Listener crashed on ${channel}: ${message}`);
}

export function createSafeEventBus(): SafeEventBus {
	const registry = new Map<string, Set<SafeEventListener>>();

	const deliver = (channel: string, payload: unknown): void => {
		const ls = registry.get(channel);
		if (!ls) return;
		for (const listener of [...ls]) {
			queueMicrotask(() => {
				void Promise.resolve()
					.then(() => listener(payload))
					.catch((error) => reportListenerError(channel, error));
			});
		}
	};

	const bus: SafeEventBus = {
		emit(channel, payload) {
			deliver(channel, payload);
		},
		on(channel, listener) {
			const set = registry.get(channel) ?? new Set<SafeEventListener>();
			set.add(listener);
			registry.set(channel, set);
			return () => {
				const current = registry.get(channel);
				if (!current) return;
				current.delete(listener);
				if (current.size === 0) registry.delete(channel);
			};
		},
		listeners(channel) {
			return [...(registry.get(channel) ?? [])];
		},
		clear() {
			registry.clear();
		},
	};

	return bus;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/core/event-bus.ts
git commit -m "feat(core): add SafeEventBus with listener isolation"
```

---

### Task 17: Write src/core/shared-bus.ts

**Files:** Create `src/core/shared-bus.ts`

- [ ] **Step 1: Write shared-bus.ts**

```ts
import { createSafeEventBus, type SafeEventBus } from "./event-bus.js";

let sharedBus: SafeEventBus | null = null;

export function getSharedBus(): SafeEventBus {
	if (!sharedBus) sharedBus = createSafeEventBus();
	return sharedBus;
}

export function resetSharedBus(): void {
	sharedBus?.clear();
	sharedBus = null;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/core/shared-bus.ts
git commit -m "feat(core): add shared process-wide bus singleton"
```

---

### Task 18: Write src/core/bus-events.ts

**Files:** Create `src/core/bus-events.ts`

- [ ] **Step 1: Write bus-events.ts**

```ts
/**
 * Canonical channel names for the Clio event bus.
 *
 * Add new channels here. Downstream code imports from this file rather than
 * hard-coding string literals so renames are a single edit and typos fail fast.
 */

export const BusChannels = {
	SessionStart: "session.start",
	SessionEnd: "session.end",
	DomainLoaded: "domain.loaded",
	DomainFailed: "domain.failed",
	ConfigHotReload: "config.hotReload",
	ConfigNextTurn: "config.nextTurn",
	ConfigRestartRequired: "config.restartRequired",
	ModeChanged: "mode.changed",
	SafetyClassified: "safety.classified",
	SafetyBlocked: "safety.blocked",
	SafetyAllowed: "safety.allowed",
	ProviderHealth: "provider.health",
	DispatchEnqueued: "dispatch.enqueued",
	DispatchStarted: "dispatch.started",
	DispatchProgress: "dispatch.progress",
	DispatchCompleted: "dispatch.completed",
	DispatchFailed: "dispatch.failed",
	BudgetAlert: "budget.alert",
	ShutdownRequested: "shutdown.requested",
	ShutdownDrained: "shutdown.drained",
	ShutdownTerminated: "shutdown.terminated",
	ShutdownPersisted: "shutdown.persisted",
} as const;

export type BusChannel = (typeof BusChannels)[keyof typeof BusChannels];
```

- [ ] **Step 2: Commit**

```bash
git add src/core/bus-events.ts
git commit -m "feat(core): add canonical bus channel enum"
```

---

### Task 19: Write src/core/startup-timer.ts

**Files:** Create `src/core/startup-timer.ts`

- [ ] **Step 1: Write startup-timer.ts**

```ts
/**
 * Micro-profiler for boot phases. Target budget is ≤800ms to first frame per spec §17.
 */

type Mark = { name: string; at: number };

export class StartupTimer {
	private readonly start = performance.now();
	private readonly marks: Mark[] = [];

	mark(name: string): void {
		this.marks.push({ name, at: performance.now() - this.start });
	}

	snapshot(): { totalMs: number; marks: ReadonlyArray<Mark> } {
		return { totalMs: performance.now() - this.start, marks: [...this.marks] };
	}

	report(): string {
		const snap = this.snapshot();
		const lines = [`clio boot total ${snap.totalMs.toFixed(1)}ms`];
		for (const m of snap.marks) lines.push(`  ${m.at.toFixed(1)}ms  ${m.name}`);
		return lines.join("\n");
	}
}
```

- [ ] **Step 2: Commit**

```bash
git add src/core/startup-timer.ts
git commit -m "feat(core): add boot-phase micro-profiler"
```

---

### Task 20: Write src/core/termination.ts

**Files:** Create `src/core/termination.ts`

- [ ] **Step 1: Write termination.ts**

```ts
/**
 * Shutdown coordinator implementing the four-phase sequence from spec §17:
 *   DRAIN  → stop accepting new input / dispatch
 *   TERMINATE → kill active workers (wired in Phase 7)
 *   PERSIST → atomic writes of domain state
 *   EXIT → tear down TUI and process.exit
 *
 * Phase 1 wires the scaffolding and the process signal handlers so later phases
 * can register hooks without reinventing the state machine.
 */

import { BusChannels } from "./bus-events.js";
import { getSharedBus } from "./shared-bus.js";

export type TerminationPhase = "idle" | "draining" | "terminating" | "persisting" | "exiting";

type Hook = () => void | Promise<void>;

class TerminationCoordinator {
	private phase: TerminationPhase = "idle";
	private readonly drainHooks: Hook[] = [];
	private readonly terminateHooks: Hook[] = [];
	private readonly persistHooks: Hook[] = [];
	private exitCode = 0;
	private started = false;

	getPhase(): TerminationPhase {
		return this.phase;
	}

	onDrain(hook: Hook): void {
		this.drainHooks.push(hook);
	}
	onTerminate(hook: Hook): void {
		this.terminateHooks.push(hook);
	}
	onPersist(hook: Hook): void {
		this.persistHooks.push(hook);
	}

	async shutdown(code = 0): Promise<void> {
		if (this.started) return;
		this.started = true;
		this.exitCode = code;
		const bus = getSharedBus();

		this.phase = "draining";
		bus.emit(BusChannels.ShutdownRequested, { phase: this.phase });
		await this.runHooks(this.drainHooks);
		bus.emit(BusChannels.ShutdownDrained, {});

		this.phase = "terminating";
		await this.runHooks(this.terminateHooks);
		bus.emit(BusChannels.ShutdownTerminated, {});

		this.phase = "persisting";
		await this.runHooks(this.persistHooks);
		bus.emit(BusChannels.ShutdownPersisted, {});

		this.phase = "exiting";
		bus.emit(BusChannels.SessionEnd, { exitCode: this.exitCode });
		process.exit(this.exitCode);
	}

	private async runHooks(hooks: Hook[]): Promise<void> {
		for (const hook of hooks) {
			try {
				await hook();
			} catch (err) {
				console.error("[clio:termination] hook failed:", err);
			}
		}
	}

	installSignalHandlers(): void {
		const handler = (signal: NodeJS.Signals): void => {
			process.stderr.write(`\nclio: received ${signal}, shutting down...\n`);
			void this.shutdown(signal === "SIGINT" ? 130 : 143);
		};
		process.once("SIGINT", handler);
		process.once("SIGTERM", handler);
	}
}

let coordinator: TerminationCoordinator | null = null;

export function getTerminationCoordinator(): TerminationCoordinator {
	if (!coordinator) coordinator = new TerminationCoordinator();
	return coordinator;
}

export function resetTerminationCoordinator(): void {
	coordinator = null;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/core/termination.ts
git commit -m "feat(core): add four-phase termination coordinator"
```

---

### Task 21: Write src/core/concurrency.ts

**Files:** Create `src/core/concurrency.ts`

- [ ] **Step 1: Write concurrency.ts**

```ts
/**
 * Minimal concurrency primitives used throughout Clio: a semaphore for max-in-flight
 * control and a token bucket for per-provider rate limiting.
 *
 * Phase 1 seeds both primitives so later domains (dispatch, scheduling, providers) can
 * depend on them without circular imports.
 */

export class Semaphore {
	private permits: number;
	private readonly waiters: Array<() => void> = [];

	constructor(permits: number) {
		if (permits < 1) throw new Error("Semaphore permits must be >= 1");
		this.permits = permits;
	}

	async acquire(): Promise<() => void> {
		if (this.permits > 0) {
			this.permits -= 1;
			return () => this.release();
		}
		await new Promise<void>((resolve) => this.waiters.push(resolve));
		this.permits -= 1;
		return () => this.release();
	}

	private release(): void {
		this.permits += 1;
		const waiter = this.waiters.shift();
		if (waiter) waiter();
	}

	available(): number {
		return this.permits;
	}
}

export class TokenBucket {
	private tokens: number;
	private lastRefillMs: number;

	constructor(
		private readonly capacity: number,
		private readonly refillPerSec: number,
	) {
		if (capacity < 1) throw new Error("TokenBucket capacity must be >= 1");
		this.tokens = capacity;
		this.lastRefillMs = Date.now();
	}

	tryTake(n = 1): boolean {
		this.refill();
		if (this.tokens < n) return false;
		this.tokens -= n;
		return true;
	}

	private refill(): void {
		const now = Date.now();
		const elapsedSec = (now - this.lastRefillMs) / 1000;
		if (elapsedSec <= 0) return;
		this.tokens = Math.min(this.capacity, this.tokens + elapsedSec * this.refillPerSec);
		this.lastRefillMs = now;
	}
}
```

- [ ] **Step 2: Commit**

```bash
git add src/core/concurrency.ts
git commit -m "feat(core): add Semaphore and TokenBucket primitives"
```

---

### Task 22: Write src/core/tool-names.ts

**Files:** Create `src/core/tool-names.ts`

- [ ] **Step 1: Write tool-names.ts**

```ts
/**
 * Canonical tool names. Everything that dispatches a tool call references these constants
 * so mode matrices, safety classifiers, and audit filters never diverge on spelling.
 */

export const ToolNames = {
	Read: "read",
	Write: "write",
	Edit: "edit",
	Bash: "bash",
	Grep: "grep",
	Glob: "glob",
	Ls: "ls",
	WebFetch: "web_fetch",
	WebSearch: "web_search",
	WritePlan: "write_plan",
	WriteReview: "write_review",
	DispatchAgent: "dispatch_agent",
	BatchDispatch: "batch_dispatch",
	ChainDispatch: "chain_dispatch",
} as const;

export type ToolName = (typeof ToolNames)[keyof typeof ToolNames];

export const ALL_TOOL_NAMES: ReadonlyArray<ToolName> = Object.values(ToolNames);
```

- [ ] **Step 2: Commit**

```bash
git add src/core/tool-names.ts
git commit -m "feat(core): add canonical tool-name enum"
```

---

### Task 23: Write src/core/agent-profiles.ts

**Files:** Create `src/core/agent-profiles.ts`

- [ ] **Step 1: Write agent-profiles.ts**

```ts
/**
 * An agent profile identifies whether an agent loop is running as the orchestrator
 * (full tool registry, manages workers) or as a worker (restricted tool set, produces
 * a single result for the orchestrator).
 */

export const AgentProfiles = {
	Orchestrator: "orchestrator",
	Worker: "worker",
} as const;

export type AgentProfile = (typeof AgentProfiles)[keyof typeof AgentProfiles];
```

- [ ] **Step 2: Commit**

```bash
git add src/core/agent-profiles.ts
git commit -m "feat(core): add orchestrator/worker profile enum"
```

---

### Task 24: Write src/core/domain-loader.ts (contracts pattern)

**Files:** Create `src/core/domain-loader.ts`

This revised task replaces the original `getDependency()` approach. Extensions are now PRIVATE — only a query-only `DomainContract` is handed to consumers. A contract is whatever interface the domain's `index.ts` exports (convention: query methods and event subscriptions, no mutators). This plus rule 3 in `check-boundaries.ts` makes domain independence structural.

- [ ] **Step 1: Write domain-loader.ts**

```ts
/**
 * Manifest-driven domain loader.
 *
 * Every domain module exports:
 *   { manifest, createExtension: (ctx) => { extension, contract } }
 *
 * The loader:
 *   1. Performs a topological sort on manifest dependencies.
 *   2. Instantiates each module in order, calling createExtension(ctx).
 *   3. Calls extension.start() and stores the contract under the domain name.
 *   4. Passes a DomainContext to each subsequent module that exposes getContract<T>(name),
 *      which returns ONLY the query-only contract, never the full extension.
 *
 * Extensions are process-local. Contracts are the cross-domain surface.
 */

import { BusChannels } from "./bus-events.js";
import type { SafeEventBus } from "./event-bus.js";
import { getSharedBus } from "./shared-bus.js";

export interface DomainManifest {
	name: string;
	dependsOn: ReadonlyArray<string>;
}

/**
 * Internal lifecycle surface. Not exposed to other domains.
 */
export interface DomainExtension {
	start(): Promise<void> | void;
	stop?(): Promise<void> | void;
}

/**
 * Query-only surface exposed to other domains. Each domain's index.ts defines its
 * own concrete contract type and exports it alongside the module.
 */
export type DomainContract = Readonly<Record<string, unknown>>;

export interface DomainBundle<TContract extends DomainContract = DomainContract> {
	extension: DomainExtension;
	contract: TContract;
}

export interface DomainContext {
	bus: SafeEventBus;
	getContract<T extends DomainContract = DomainContract>(name: string): T | undefined;
}

export interface DomainModule<TContract extends DomainContract = DomainContract> {
	manifest: DomainManifest;
	createExtension(context: DomainContext): DomainBundle<TContract> | Promise<DomainBundle<TContract>>;
}

export interface LoadResult {
	loaded: ReadonlyArray<string>;
	failed: ReadonlyArray<{ name: string; error: unknown }>;
	stop(): Promise<void>;
}

export async function loadDomains(modules: ReadonlyArray<DomainModule>): Promise<LoadResult> {
	const order = topoSort(modules);
	const contracts = new Map<string, DomainContract>();
	const extensions = new Map<string, DomainExtension>();
	const loaded: string[] = [];
	const failed: Array<{ name: string; error: unknown }> = [];
	const bus = getSharedBus();

	const context: DomainContext = {
		bus,
		getContract<T extends DomainContract>(dep: string): T | undefined {
			return contracts.get(dep) as T | undefined;
		},
	};

	for (const name of order) {
		const mod = modules.find((m) => m.manifest.name === name);
		if (!mod) continue;
		try {
			const bundle = await mod.createExtension(context);
			await bundle.extension.start();
			extensions.set(name, bundle.extension);
			contracts.set(name, bundle.contract);
			loaded.push(name);
			bus.emit(BusChannels.DomainLoaded, { name });
		} catch (error) {
			failed.push({ name, error });
			bus.emit(BusChannels.DomainFailed, { name, error });
			throw new DomainLoadError(name, error);
		}
	}

	const stop = async (): Promise<void> => {
		for (const name of [...loaded].reverse()) {
			const ext = extensions.get(name);
			if (ext?.stop) {
				try {
					await ext.stop();
				} catch (err) {
					console.error(`[clio:domain-loader] ${name}.stop() failed:`, err);
				}
			}
		}
	};

	return { loaded, failed, stop };
}

function topoSort(modules: ReadonlyArray<DomainModule>): string[] {
	const names = new Set(modules.map((m) => m.manifest.name));
	const unresolved: string[] = [];
	for (const m of modules) {
		for (const dep of m.manifest.dependsOn) {
			if (!names.has(dep)) unresolved.push(`${m.manifest.name} -> ${dep}`);
		}
	}
	if (unresolved.length > 0) {
		throw new DomainLoadError("topo", new Error(`Unresolved dependencies: ${unresolved.join(", ")}`));
	}

	const order: string[] = [];
	const visited = new Set<string>();
	const visiting = new Set<string>();

	const visit = (name: string): void => {
		if (visited.has(name)) return;
		if (visiting.has(name)) {
			throw new DomainLoadError("topo", new Error(`Cycle detected at ${name}`));
		}
		visiting.add(name);
		const mod = modules.find((m) => m.manifest.name === name);
		if (mod) {
			for (const dep of mod.manifest.dependsOn) visit(dep);
		}
		visiting.delete(name);
		visited.add(name);
		order.push(name);
	};

	for (const m of modules) visit(m.manifest.name);
	return order;
}

export class DomainLoadError extends Error {
	constructor(
		public readonly domain: string,
		public readonly cause: unknown,
	) {
		super(`Domain '${domain}' failed to load: ${cause instanceof Error ? cause.message : String(cause)}`);
		this.name = "DomainLoadError";
	}
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/core/domain-loader.ts
git commit -m "feat(core): add manifest-driven topological domain loader"
```

---

### Task 25: Write src/core/defaults.ts

**Files:** Create `src/core/defaults.ts`

- [ ] **Step 1: Write defaults.ts**

```ts
/**
 * Default settings shipped with Clio. Written to ~/.clio/settings.yaml on first install
 * if the file does not already exist. Users edit the file directly or through TUI overlays.
 */

export const DEFAULT_SETTINGS = {
	version: 1,
	identity: "clio",
	defaultMode: "default" as const,
	safetyLevel: "auto-edit" as const,
	provider: {
		active: null as string | null,
		model: null as string | null,
	},
	budget: {
		sessionCeilingUsd: 5,
		concurrency: "auto" as const,
	},
	runtimes: {
		enabled: ["native"],
	},
	theme: "default",
	keybindings: {},
	state: {
		lastMode: "default" as const,
	},
} as const;

export type DefaultSettings = typeof DEFAULT_SETTINGS;
```

- [ ] **Step 2: Commit**

```bash
git add src/core/defaults.ts
git commit -m "feat(core): add default settings constant"
```

---

### Task 26: Write src/core/init.ts

**Files:** Create `src/core/init.ts`

- [ ] **Step 1: Write init.ts**

```ts
/**
 * Bootstrap ~/.clio on first install. Creates the full directory tree required by
 * subsequent domains and writes defaults when absent. Idempotent.
 */

import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { DEFAULT_SETTINGS } from "./defaults.js";
import { clioConfigDir, clioDataDir, clioCacheDir } from "./xdg.js";

export interface InitReport {
	configDir: string;
	dataDir: string;
	cacheDir: string;
	createdPaths: string[];
	touchedSettings: boolean;
}

const SUBDIRS = ["sessions", "audit", "state", "agents", "prompts", "receipts"] as const;

export function initializeClioHome(): InitReport {
	const configDir = clioConfigDir();
	const dataDir = clioDataDir();
	const cacheDir = clioCacheDir();

	const created: string[] = [];

	for (const dir of [configDir, dataDir, cacheDir]) {
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
			created.push(dir);
		}
	}

	for (const sub of SUBDIRS) {
		const full = join(dataDir, sub);
		if (!existsSync(full)) {
			mkdirSync(full, { recursive: true });
			created.push(full);
		}
	}

	const settingsPath = join(configDir, "settings.yaml");
	let touched = false;
	if (!existsSync(settingsPath)) {
		writeFileSync(settingsPath, stringifyYaml(DEFAULT_SETTINGS), { encoding: "utf8", mode: 0o644 });
		created.push(settingsPath);
		touched = true;
	} else {
		// Sanity check: parse to catch broken edits; leave the file untouched.
		parseYaml(readFile(settingsPath));
	}

	const credentialsPath = join(configDir, "credentials.yaml");
	if (!existsSync(credentialsPath)) {
		writeFileSync(credentialsPath, "# Managed via the /providers overlay. Do not edit manually unless you know what you are doing.\n{}\n", {
			encoding: "utf8",
			mode: 0o600,
		});
		chmodSync(credentialsPath, 0o600);
		created.push(credentialsPath);
	}

	const installPath = join(dataDir, "install.json");
	if (!existsSync(installPath)) {
		const payload = {
			version: "0.1.0-dev",
			installedAt: new Date().toISOString(),
			platform: process.platform,
			nodeVersion: process.version,
		};
		writeFileSync(installPath, JSON.stringify(payload, null, 2), "utf8");
		created.push(installPath);
	}

	return { configDir, dataDir, cacheDir, createdPaths: created, touchedSettings: touched };
}

function readFile(path: string): string {
	return require("node:fs").readFileSync(path, "utf8") as string;
}
```

Note: replace the CommonJS `require` in `readFile` — Clio is ESM-only. Use an import instead.

- [ ] **Step 2: Replace the require-based readFile with an import**

Edit `src/core/init.ts`: remove the `readFile` helper at the bottom and change the imports and the call:

```ts
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
```

Replace `parseYaml(readFile(settingsPath));` with `parseYaml(readFileSync(settingsPath, "utf8"));` and delete the helper.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/core/init.ts
git commit -m "feat(core): add idempotent ~/.clio bootstrap"
```

---

## Part D — Engine wrappers (Tasks 27-34)

### Task 27: Write src/engine/types.ts (against the 0.67.4 audit)

**Files:** Create `src/engine/types.ts`

- [ ] **Step 1: Confirm Task 0 audit covers every symbol below**

Re-read `docs/architecture/pi-mono-boundary-0.67.4.md`. Every type re-exported here must be present in that audit. If a symbol is not in the audit, update the audit first and commit that change before proceeding.

- [ ] **Step 2: Create directory**

Run: `mkdir -p src/engine`

- [ ] **Step 3: Write types.ts**

```ts
/**
 * Re-exports of pi-mono 0.67.4 types consumed by Clio. Frozen against
 * docs/architecture/pi-mono-boundary-0.67.4.md.
 *
 * Importing pi-* types from anywhere else in the codebase violates the engine boundary.
 * Add new re-exports here when domains need additional pi types, and update the audit
 * document in the same commit.
 */

export { Agent } from "@mariozechner/pi-agent-core";
export type {
	AgentOptions,
	AgentState,
	AgentEvent,
	AgentMessage,
} from "@mariozechner/pi-agent-core";

export type {
	Api,
	KnownProvider,
	Model,
	StreamFn,
	Usage,
} from "@mariozechner/pi-ai";

export { TUI } from "@mariozechner/pi-tui";
export type {
	EditorOptions,
	EditorTheme,
	SelectItem,
	SelectListLayoutOptions,
	SelectListTheme,
	SettingItem,
	SettingsListTheme,
} from "@mariozechner/pi-tui";
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: no errors. If a symbol fails to resolve, fix the audit first (it is the source of truth) — do not edit this file directly.

- [ ] **Step 5: Commit**

```bash
git add src/engine/types.ts
git commit -m "feat(engine): re-export pi-mono 0.67.4 surface per audit"
```

---

### Task 28: Write src/engine/ai.ts (registerBuiltInApiProviders, getProviders)

**Files:** Create `src/engine/ai.ts`

- [ ] **Step 1: Write ai.ts**

```ts
/**
 * Thin wrapper over @mariozechner/pi-ai 0.67.4. Domains consume this module, not pi-ai.
 *
 * pi-ai's provider registry is process-global. Calling registerBuiltInApiProviders()
 * multiple times is safe. Clio ensures it runs exactly once before any lookup.
 */

import {
	getModel,
	getModels,
	getProviders,
	registerBuiltInApiProviders,
	type KnownProvider,
	type Model,
} from "@mariozechner/pi-ai";

export interface EngineAi {
	listProviders(): KnownProvider[];
	listModels<TProvider extends KnownProvider>(provider: TProvider): Model<never>[];
	getModel<TProvider extends KnownProvider>(provider: TProvider, modelId: string): Model<never> | undefined;
}

let registered = false;

export function ensurePiAiRegistered(): void {
	if (registered) return;
	registerBuiltInApiProviders();
	registered = true;
}

export function createEngineAi(): EngineAi {
	ensurePiAiRegistered();
	return {
		listProviders: () => getProviders(),
		listModels: (provider) => getModels(provider) as unknown as Model<never>[],
		getModel: (provider, modelId) => {
			try {
				return getModel(provider, modelId as never) as unknown as Model<never>;
			} catch {
				return undefined;
			}
		},
	};
}
```

Note on typing: pi-ai's `Model<TApi>` is provider-specific through a generic. For the engine boundary, Clio erases the specific Api via `Model<never>` — callers that need typed model access should go through `pi-ai` imports directly, but only from `src/engine/**`.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/engine/ai.ts
git commit -m "feat(engine): wrap pi-ai provider registration and lookup"
```

---

### Task 29: Write src/engine/agent.ts (Agent + AgentOptions, no createState)

**Files:** Create `src/engine/agent.ts`

- [ ] **Step 1: Write agent.ts**

```ts
/**
 * Thin wrapper over @mariozechner/pi-agent-core 0.67.4's Agent class.
 *
 * pi-agent-core's Agent owns its own state (exposed via `agent.state`). There is no
 * separate state factory. AgentOptions drives the construction; the state is derived
 * from options.initialState on instantiation.
 */

import { Agent, type AgentOptions, type AgentState } from "@mariozechner/pi-agent-core";

export interface EngineAgentHandle {
	agent: Agent;
	state(): AgentState;
}

export function createEngineAgent(options: AgentOptions = {}): EngineAgentHandle {
	const agent = new Agent(options);
	return {
		agent,
		state: () => agent.state,
	};
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/engine/agent.ts
git commit -m "feat(engine): wrap pi-agent-core Agent constructor"
```

---

### Task 30: Write src/engine/tui.ts (TUI class + components + keybindings)

**Files:** Create `src/engine/tui.ts`

- [ ] **Step 1: Write tui.ts**

```ts
/**
 * Re-export the pi-tui 0.67.4 primitives Clio's interactive layer consumes. Adding a
 * new pi-tui symbol to Clio happens here first (and in the audit document), then the
 * consuming file in src/interactive/ imports it from this module.
 */

export {
	Box,
	CancellableLoader,
	Editor,
	Image,
	Input,
	Loader,
	Markdown,
	SelectList,
	SettingsList,
	Spacer,
	Text,
	TruncatedText,
	TUI,
	TUI_KEYBINDINGS,
} from "@mariozechner/pi-tui";

export type {
	EditorOptions,
	EditorTheme,
	SelectItem,
	SelectListLayoutOptions,
	SelectListTheme,
	SettingItem,
	SettingsListTheme,
} from "@mariozechner/pi-tui";
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors. If a symbol fails, reconcile against the audit document first.

- [ ] **Step 3: Commit**

```bash
git add src/engine/tui.ts
git commit -m "feat(engine): re-export pi-tui primitives through the boundary"
```

---

### Task 31: Write src/engine/session.ts (Phase 1 stub)

**Files:** Create `src/engine/session.ts`

- [ ] **Step 1: Write session.ts**

```ts
/**
 * Phase 1 stub. The full Clio session JSONL format lands in Phase 3. This module exposes
 * a minimal shape so Phase 1 CLI commands can compile and the orchestrator can reserve
 * the session-id slot in its context object.
 */

import { randomUUID } from "node:crypto";

export interface ClioSessionMeta {
	id: string;
	cwd: string;
	createdAt: string;
	model: string | null;
	provider: string | null;
	compiledPromptHash: string | null;
}

export function newSessionMeta(cwd: string): ClioSessionMeta {
	return {
		id: randomUUID(),
		cwd,
		createdAt: new Date().toISOString(),
		model: null,
		provider: null,
		compiledPromptHash: null,
	};
}
```

- [ ] **Step 2: Commit**

```bash
git add src/engine/session.ts
git commit -m "feat(engine): stub session meta for Phase 1 boot"
```

---

### Task 32: Write src/engine/tools.ts (Phase 1 stub)

**Files:** Create `src/engine/tools.ts`

- [ ] **Step 1: Write tools.ts**

```ts
/**
 * Phase 1 stub. Tool registration helpers that bridge pi-agent-core's tool API into the
 * shape Clio's registry will use. The full registry with mode gating and action-class
 * wiring lands in Phase 2 (safety) and Phase 5 (tools).
 */

export interface EngineToolHandle {
	name: string;
	description: string;
}

export function defineEngineTool(handle: EngineToolHandle): EngineToolHandle {
	return handle;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/engine/tools.ts
git commit -m "feat(engine): stub tool registration helper"
```

---

### Task 33: Write src/engine/index.ts barrel

**Files:** Create `src/engine/index.ts`

- [ ] **Step 1: Write index.ts**

```ts
export * from "./types.js";
export * from "./ai.js";
export * from "./agent.js";
export * from "./tui.js";
export * from "./session.js";
export * from "./tools.js";
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Run boundary check**

Run: `npm run check:boundaries`
Expected: `boundaries: OK`

- [ ] **Step 4: Commit**

```bash
git add src/engine/index.ts
git commit -m "feat(engine): add barrel export"
```

---

### Task 34: Boundary sanity — ensure pi-mono stays inside engine/

- [ ] **Step 1: Confirm no core/ or domains/ file imports from pi-mono**

Run: `grep -r "@mariozechner/pi-" src/core src/domains 2>/dev/null || echo "clean"`
Expected: `clean` (or no output at all).

- [ ] **Step 2: Confirm engine/ does import from pi-mono**

Run: `grep -l "@mariozechner/pi-" src/engine/`
Expected: at least `src/engine/agent.ts`, `src/engine/ai.ts`, `src/engine/tui.ts`.

No commit.

---

## Part E — Config domain (Tasks 35-45)

### Task 35: Create src/domains/config/ directory and placeholder

- [ ] **Step 1: Create directory**

Run: `mkdir -p src/domains/config`

No commit.

---

### Task 36: Write src/core/config.ts

**Files:** Create `src/core/config.ts`

- [ ] **Step 1: Write config.ts**

```ts
/**
 * Low-level settings read/write. The config domain wraps this module with watcher,
 * hot-reload, and event emission. Kept in core/ because multiple domains (providers,
 * modes, prompts) need settings access before the domain loader has finished booting.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { DEFAULT_SETTINGS } from "./defaults.js";
import { clioConfigDir } from "./xdg.js";

export type ClioSettings = typeof DEFAULT_SETTINGS;

export function settingsPath(): string {
	return join(clioConfigDir(), "settings.yaml");
}

export function readSettings(): ClioSettings {
	const path = settingsPath();
	if (!existsSync(path)) return structuredClone(DEFAULT_SETTINGS);
	const raw = readFileSync(path, "utf8");
	const parsed = parseYaml(raw) as Partial<ClioSettings> | null;
	return { ...structuredClone(DEFAULT_SETTINGS), ...(parsed ?? {}) } as ClioSettings;
}

export function writeSettings(settings: ClioSettings): void {
	writeFileSync(settingsPath(), stringifyYaml(settings), { encoding: "utf8", mode: 0o644 });
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/core/config.ts
git commit -m "feat(core): add settings read/write"
```

---

### Task 37: Write src/domains/config/schema.ts

**Files:** Create `src/domains/config/schema.ts`

- [ ] **Step 1: Write schema.ts**

```ts
import { Type, type Static } from "@sinclair/typebox";

/**
 * TypeBox schema for the settings file. Mirrors the DEFAULT_SETTINGS constant in
 * src/core/defaults.ts. If you add a field there, add it here too and extend the
 * Static type export downstream.
 */

export const SettingsSchema = Type.Object({
	version: Type.Literal(1),
	identity: Type.String({ minLength: 1 }),
	defaultMode: Type.Union([Type.Literal("default"), Type.Literal("advise"), Type.Literal("super")]),
	safetyLevel: Type.Union([Type.Literal("suggest"), Type.Literal("auto-edit"), Type.Literal("full-auto")]),
	provider: Type.Object({
		active: Type.Union([Type.String(), Type.Null()]),
		model: Type.Union([Type.String(), Type.Null()]),
	}),
	budget: Type.Object({
		sessionCeilingUsd: Type.Number({ minimum: 0 }),
		concurrency: Type.Union([Type.Literal("auto"), Type.Number({ minimum: 1 })]),
	}),
	runtimes: Type.Object({
		enabled: Type.Array(Type.String()),
	}),
	theme: Type.String(),
	keybindings: Type.Record(Type.String(), Type.String()),
	state: Type.Object({
		lastMode: Type.Union([Type.Literal("default"), Type.Literal("advise"), Type.Literal("super")]),
	}),
});

export type ValidatedSettings = Static<typeof SettingsSchema>;
```

- [ ] **Step 2: Commit**

```bash
git add src/domains/config/schema.ts
git commit -m "feat(config): add TypeBox settings schema"
```

---

### Task 38: Write src/domains/config/manifest.ts

**Files:** Create `src/domains/config/manifest.ts`

- [ ] **Step 1: Write manifest.ts**

```ts
import type { DomainManifest } from "../../core/domain-loader.js";

export const ConfigManifest: DomainManifest = {
	name: "config",
	dependsOn: [],
};
```

- [ ] **Step 2: Commit**

```bash
git add src/domains/config/manifest.ts
git commit -m "feat(config): add manifest with zero dependencies"
```

---

### Task 39: Write src/domains/config/watcher.ts + classification

**Files:** Create `src/domains/config/watcher.ts`, `src/domains/config/classify.ts`

- [ ] **Step 1: Write classify.ts (implements spec §13 hot-reload matrix)**

```ts
import type { ClioSettings } from "../../core/config.js";

/**
 * Classifies a settings change into one of three buckets per spec §13:
 *   - hotReload   : theme, keybindings, safety rules, mode defaults, prompt fragments,
 *                   audit verbosity. Apply immediately (≤100ms).
 *   - nextTurn    : model selection, thinking level, budget ceiling. Apply before the
 *                   next turn starts.
 *   - restartRequired : provider credentials, active provider list, runtime enable/disable,
 *                       engine settings. Needs a restart nudge.
 *
 * Output is an exhaustive per-bucket list. A single patch can touch multiple buckets;
 * the caller emits the event(s) for every non-empty bucket.
 */

export type ChangeKind = "hotReload" | "nextTurn" | "restartRequired";

export interface ConfigDiff {
	hotReload: string[];
	nextTurn: string[];
	restartRequired: string[];
}

const HOT_RELOAD_FIELDS = new Set<string>([
	"theme",
	"keybindings",
	"safetyLevel",
	"defaultMode",
	"state.lastMode",
]);

const NEXT_TURN_FIELDS = new Set<string>([
	"provider.model",
	"budget.sessionCeilingUsd",
]);

const RESTART_REQUIRED_FIELDS = new Set<string>([
	"provider.active",
	"runtimes.enabled",
	"budget.concurrency",
]);

export function diffSettings(prev: ClioSettings, next: ClioSettings): ConfigDiff {
	const changed = collectChangedPaths(prev, next);
	const diff: ConfigDiff = { hotReload: [], nextTurn: [], restartRequired: [] };
	for (const p of changed) {
		if (HOT_RELOAD_FIELDS.has(p)) diff.hotReload.push(p);
		else if (NEXT_TURN_FIELDS.has(p)) diff.nextTurn.push(p);
		else if (RESTART_REQUIRED_FIELDS.has(p)) diff.restartRequired.push(p);
		else {
			// Unknown field falls back to restartRequired to fail closed.
			diff.restartRequired.push(p);
		}
	}
	return diff;
}

function collectChangedPaths(a: unknown, b: unknown, prefix = ""): string[] {
	if (Object.is(a, b)) return [];
	if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) {
		return [prefix || "(root)"];
	}
	const keys = new Set([...Object.keys(a as object), ...Object.keys(b as object)]);
	const paths: string[] = [];
	for (const k of keys) {
		const nextPrefix = prefix ? `${prefix}.${k}` : k;
		const av = (a as Record<string, unknown>)[k];
		const bv = (b as Record<string, unknown>)[k];
		paths.push(...collectChangedPaths(av, bv, nextPrefix));
	}
	return paths;
}
```

- [ ] **Step 2: Write watcher.ts (now just the file-event source; classification is in extension.ts)**

```ts
import { type FSWatcher, watch } from "node:fs";
import { settingsPath } from "../../core/config.js";

export type WatcherCallback = (raw: { at: number }) => void;

export interface ConfigWatcher {
	stop(): void;
}

export function startConfigWatcher(cb: WatcherCallback): ConfigWatcher {
	const path = settingsPath();

	let watcher: FSWatcher | null = null;
	let debounceTimer: NodeJS.Timeout | null = null;

	try {
		watcher = watch(path, { persistent: false }, () => {
			if (debounceTimer) clearTimeout(debounceTimer);
			debounceTimer = setTimeout(() => {
				cb({ at: Date.now() });
			}, 80);
		});
	} catch (err) {
		console.error("[clio:config] watcher setup failed:", err);
	}

	return {
		stop() {
			if (debounceTimer) clearTimeout(debounceTimer);
			watcher?.close();
			watcher = null;
		},
	};
}
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/domains/config/watcher.ts src/domains/config/classify.ts
git commit -m "feat(config): add watcher + hot-reload matrix classifier (spec §13)"
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/domains/config/watcher.ts
git commit -m "feat(config): add settings.yaml watcher with 80ms debounce"
```

---

### Task 40: Write src/domains/config/extension.ts (re-read + classify + contract)

**Files:** Create `src/domains/config/extension.ts`, `src/domains/config/contract.ts`

- [ ] **Step 1: Write contract.ts (query-only surface exposed to other domains)**

```ts
import type { ClioSettings } from "../../core/config.js";
import type { ChangeKind, ConfigDiff } from "./classify.js";

/**
 * The ConfigDomain's external surface. Other domains import this through the contract
 * returned by the domain loader — never by reaching into extension.ts.
 */
export interface ConfigContract {
	get(): Readonly<ClioSettings>;
	onChange(kind: ChangeKind, listener: (payload: { diff: ConfigDiff; settings: Readonly<ClioSettings> }) => void): () => void;
}
```

- [ ] **Step 2: Write extension.ts**

```ts
import { Value } from "@sinclair/typebox/value";
import { BusChannels } from "../../core/bus-events.js";
import { readSettings, type ClioSettings } from "../../core/config.js";
import type { DomainBundle, DomainContext, DomainExtension } from "../../core/domain-loader.js";
import { diffSettings, type ChangeKind, type ConfigDiff } from "./classify.js";
import type { ConfigContract } from "./contract.js";
import { SettingsSchema } from "./schema.js";
import { startConfigWatcher, type ConfigWatcher } from "./watcher.js";

type ChangeListener = (payload: { diff: ConfigDiff; settings: Readonly<ClioSettings> }) => void;

export function createConfigBundle(context: DomainContext): DomainBundle<ConfigContract> {
	let watcher: ConfigWatcher | null = null;
	let snapshot: ClioSettings | null = null;
	const listeners = new Map<ChangeKind, Set<ChangeListener>>([
		["hotReload", new Set()],
		["nextTurn", new Set()],
		["restartRequired", new Set()],
	]);

	function validate(candidate: ClioSettings): void {
		if (Value.Check(SettingsSchema, candidate)) return;
		const first = [...Value.Errors(SettingsSchema, candidate)][0];
		throw new Error(`settings.yaml failed schema validation at ${first?.path ?? "(root)"}: ${first?.message ?? "unknown"}`);
	}

	function dispatch(kind: ChangeKind, payload: { diff: ConfigDiff; settings: Readonly<ClioSettings> }): void {
		const bus = context.bus;
		const channel = kind === "hotReload" ? BusChannels.ConfigHotReload : kind === "nextTurn" ? BusChannels.ConfigNextTurn : BusChannels.ConfigRestartRequired;
		bus.emit(channel, payload);
		for (const listener of listeners.get(kind) ?? []) {
			try {
				listener(payload);
			} catch (err) {
				console.error(`[clio:config] listener for ${kind} threw:`, err);
			}
		}
	}

	function onWatcherFire(): void {
		let next: ClioSettings;
		try {
			next = readSettings();
			validate(next);
		} catch (err) {
			console.error("[clio:config] reload rejected:", err);
			return;
		}
		const prev = snapshot;
		snapshot = next;
		if (!prev) return;
		const diff = diffSettings(prev, next);
		if (diff.hotReload.length > 0) dispatch("hotReload", { diff, settings: next });
		if (diff.nextTurn.length > 0) dispatch("nextTurn", { diff, settings: next });
		if (diff.restartRequired.length > 0) dispatch("restartRequired", { diff, settings: next });
	}

	const extension: DomainExtension = {
		async start() {
			snapshot = readSettings();
			validate(snapshot);
			watcher = startConfigWatcher(() => onWatcherFire());
		},
		async stop() {
			watcher?.stop();
			watcher = null;
		},
	};

	const contract: ConfigContract = {
		get() {
			if (!snapshot) throw new Error("config domain not started");
			return snapshot;
		},
		onChange(kind, listener) {
			listeners.get(kind)?.add(listener);
			return () => {
				listeners.get(kind)?.delete(listener);
			};
		},
	};

	return { extension, contract };
}
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/domains/config/extension.ts src/domains/config/contract.ts
git commit -m "feat(config): add extension with classified hot-reload + contract"
```

---

### Task 41: Write src/domains/config/index.ts

**Files:** Create `src/domains/config/index.ts`

- [ ] **Step 1: Write index.ts (exports the module and the contract type, nothing from extension.ts)**

```ts
import type { DomainModule } from "../../core/domain-loader.js";
import { createConfigBundle } from "./extension.js";
import { ConfigManifest } from "./manifest.js";

export const ConfigDomainModule: DomainModule = {
	manifest: ConfigManifest,
	createExtension: createConfigBundle,
};

export { ConfigManifest } from "./manifest.js";
export { SettingsSchema, type ValidatedSettings } from "./schema.js";
export type { ConfigContract } from "./contract.js";
export { diffSettings, type ChangeKind, type ConfigDiff } from "./classify.js";
```

Note: `createConfigBundle` is intentionally NOT re-exported. Other domains must go through the loader's `getContract("config")` to reach configuration state. The rule-3 boundary check enforces this.

- [ ] **Step 2: Typecheck and boundary**

Run: `npm run typecheck && npm run check:boundaries`
Expected: both pass.

- [ ] **Step 3: Commit**

```bash
git add src/domains/config/index.ts
git commit -m "feat(config): add domain module barrel (contract-only surface)"
```

---

### Task 42: Confirm config domain loads via the domain-loader

Quick verification before moving on.

- [ ] **Step 1: Create a temporary scratch script**

Create `scripts/_scratch-config.ts`:

```ts
import { initializeClioHome } from "../src/core/init.js";
import { loadDomains } from "../src/core/domain-loader.js";
import { ConfigDomainModule } from "../src/domains/config/index.js";

async function main(): Promise<void> {
	initializeClioHome();
	const result = await loadDomains([ConfigDomainModule]);
	console.log("loaded:", result.loaded.join(", "));
}

await main();
```

- [ ] **Step 2: Run it**

Run: `npx tsx scripts/_scratch-config.ts`
Expected: `loaded: config` with no errors.

- [ ] **Step 3: Remove the scratch script**

Run: `rm scripts/_scratch-config.ts`

No commit — verification only.

---

## Part F — Lifecycle domain (Tasks 43-52)

### Task 43: Create src/domains/lifecycle/ directory

- [ ] **Step 1: Create directory**

Run: `mkdir -p src/domains/lifecycle`

No commit.

---

### Task 44: Write src/domains/lifecycle/version.ts

**Files:** Create `src/domains/lifecycle/version.ts`

- [ ] **Step 1: Write version.ts**

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolvePackageRoot } from "../../core/package-root.js";

interface PackageJsonShape {
	version?: string;
	dependencies?: Record<string, string>;
}

let cached: VersionInfo | null = null;

export interface VersionInfo {
	clio: string;
	node: string;
	platform: string;
	piAgentCore: string | null;
	piAi: string | null;
	piTui: string | null;
}

export function getVersionInfo(): VersionInfo {
	if (cached) return cached;
	const root = resolvePackageRoot();
	const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as PackageJsonShape;
	cached = {
		clio: pkg.version ?? "0.0.0",
		node: process.version,
		platform: `${process.platform}-${process.arch}`,
		piAgentCore: pkg.dependencies?.["@mariozechner/pi-agent-core"] ?? null,
		piAi: pkg.dependencies?.["@mariozechner/pi-ai"] ?? null,
		piTui: pkg.dependencies?.["@mariozechner/pi-tui"] ?? null,
	};
	return cached;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/domains/lifecycle/version.ts
git commit -m "feat(lifecycle): expose Clio + pi-mono version info"
```

---

### Task 45: Write src/domains/lifecycle/install.ts

**Files:** Create `src/domains/lifecycle/install.ts`

- [ ] **Step 1: Write install.ts**

```ts
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { initializeClioHome } from "../../core/init.js";
import { clioDataDir } from "../../core/xdg.js";

export interface InstallInfo {
	version: string;
	installedAt: string;
	platform: string;
	nodeVersion: string;
}

export function readInstallInfo(): InstallInfo | null {
	const path = join(clioDataDir(), "install.json");
	if (!existsSync(path)) return null;
	try {
		return JSON.parse(readFileSync(path, "utf8")) as InstallInfo;
	} catch {
		return null;
	}
}

export function ensureInstalled(): InstallInfo {
	initializeClioHome();
	const info = readInstallInfo();
	if (!info) throw new Error("install metadata was not written by initializeClioHome()");
	return info;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/domains/lifecycle/install.ts
git commit -m "feat(lifecycle): add install-metadata reader"
```

---

### Task 46: Write src/domains/lifecycle/doctor.ts

**Files:** Create `src/domains/lifecycle/doctor.ts`

- [ ] **Step 1: Write doctor.ts**

```ts
import { accessSync, constants, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { clioConfigDir, clioDataDir } from "../../core/xdg.js";
import { settingsPath } from "../../core/config.js";
import { getVersionInfo } from "./version.js";
import { readInstallInfo } from "./install.js";

export interface DoctorFinding {
	ok: boolean;
	name: string;
	detail: string;
}

export function runDoctor(): DoctorFinding[] {
	const findings: DoctorFinding[] = [];
	const version = getVersionInfo();
	findings.push({ ok: true, name: "clio version", detail: version.clio });
	findings.push({ ok: true, name: "node version", detail: version.node });
	findings.push({ ok: true, name: "platform", detail: version.platform });
	findings.push({ ok: Boolean(version.piAgentCore), name: "pi-agent-core", detail: version.piAgentCore ?? "missing" });
	findings.push({ ok: Boolean(version.piAi), name: "pi-ai", detail: version.piAi ?? "missing" });
	findings.push({ ok: Boolean(version.piTui), name: "pi-tui", detail: version.piTui ?? "missing" });

	const config = clioConfigDir();
	findings.push({ ok: existsSync(config), name: "config dir", detail: config });

	const data = clioDataDir();
	findings.push({ ok: existsSync(data), name: "data dir", detail: data });

	const settings = settingsPath();
	const settingsOk = existsSync(settings);
	findings.push({ ok: settingsOk, name: "settings.yaml", detail: settingsOk ? settings : "missing (run `clio install`)" });

	const creds = join(clioConfigDir(), "credentials.yaml");
	if (existsSync(creds)) {
		try {
			accessSync(creds, constants.R_OK);
			const st = statSync(creds);
			const mode = st.mode & 0o777;
			findings.push({
				ok: mode === 0o600,
				name: "credentials mode",
				detail: `${mode.toString(8)}`,
			});
		} catch (err) {
			findings.push({ ok: false, name: "credentials", detail: String(err) });
		}
	}

	const install = readInstallInfo();
	findings.push({
		ok: Boolean(install),
		name: "install metadata",
		detail: install ? `${install.version} @ ${install.installedAt}` : "missing",
	});

	return findings;
}

export function formatDoctorReport(findings: DoctorFinding[]): string {
	const lines = findings.map((f) => {
		const badge = f.ok ? "OK" : "!! ";
		return `${badge} ${f.name.padEnd(22)} ${f.detail}`;
	});
	return lines.join("\n");
}
```

- [ ] **Step 2: Commit**

```bash
git add src/domains/lifecycle/doctor.ts
git commit -m "feat(lifecycle): add doctor diagnostics"
```

---

### Task 47: Write src/domains/lifecycle/manifest.ts

**Files:** Create `src/domains/lifecycle/manifest.ts`

- [ ] **Step 1: Write manifest.ts**

```ts
import type { DomainManifest } from "../../core/domain-loader.js";

export const LifecycleManifest: DomainManifest = {
	name: "lifecycle",
	dependsOn: ["config"],
};
```

- [ ] **Step 2: Commit**

```bash
git add src/domains/lifecycle/manifest.ts
git commit -m "feat(lifecycle): add manifest depending on config"
```

---

### Task 48: Write src/domains/lifecycle/extension.ts (contract pattern)

**Files:** Create `src/domains/lifecycle/extension.ts`, `src/domains/lifecycle/contract.ts`

- [ ] **Step 1: Write contract.ts**

```ts
import type { DoctorFinding } from "./doctor.js";
import type { InstallInfo } from "./install.js";
import type { VersionInfo } from "./version.js";

export interface LifecycleContract {
	version(): VersionInfo;
	install(): InstallInfo | null;
	doctor(): DoctorFinding[];
}
```

- [ ] **Step 2: Write extension.ts**

```ts
import type { DomainBundle, DomainContext, DomainExtension } from "../../core/domain-loader.js";
import type { LifecycleContract } from "./contract.js";
import { runDoctor } from "./doctor.js";
import { readInstallInfo } from "./install.js";
import { getVersionInfo } from "./version.js";

export function createLifecycleBundle(_context: DomainContext): DomainBundle<LifecycleContract> {
	const extension: DomainExtension = {
		async start() {
			// lifecycle data is pure read-on-demand; nothing to wire
		},
	};

	const contract: LifecycleContract = {
		version: getVersionInfo,
		install: readInstallInfo,
		doctor: runDoctor,
	};

	return { extension, contract };
}
```

- [ ] **Step 3: Commit**

```bash
git add src/domains/lifecycle/extension.ts src/domains/lifecycle/contract.ts
git commit -m "feat(lifecycle): add extension with version/install/doctor contract"
```

---

### Task 49: Write src/domains/lifecycle/index.ts

**Files:** Create `src/domains/lifecycle/index.ts`

- [ ] **Step 1: Write index.ts**

```ts
import type { DomainModule } from "../../core/domain-loader.js";
import { createLifecycleBundle } from "./extension.js";
import { LifecycleManifest } from "./manifest.js";

export const LifecycleDomainModule: DomainModule = {
	manifest: LifecycleManifest,
	createExtension: createLifecycleBundle,
};

export type { LifecycleContract } from "./contract.js";
export { getVersionInfo, type VersionInfo } from "./version.js";
export { readInstallInfo, ensureInstalled, type InstallInfo } from "./install.js";
export { runDoctor, formatDoctorReport, type DoctorFinding } from "./doctor.js";
```

- [ ] **Step 2: Typecheck + boundary**

Run: `npm run typecheck && npm run check:boundaries`
Expected: both pass.

- [ ] **Step 3: Commit**

```bash
git add src/domains/lifecycle/index.ts
git commit -m "feat(lifecycle): add domain module barrel"
```

---

## Part G — CLI skeleton (Tasks 50-56)

### Task 50: Create src/cli/ and src/entry/ directories

- [ ] **Step 1: Create directories**

Run: `mkdir -p src/cli src/entry`

No commit.

---

### Task 51: Write src/cli/shared.ts

**Files:** Create `src/cli/shared.ts`

- [ ] **Step 1: Write shared.ts**

```ts
import chalk from "chalk";

export function printError(message: string, detail?: string): void {
	const head = chalk.red("error:");
	process.stderr.write(`${head} ${message}\n`);
	if (detail) process.stderr.write(`  ${detail}\n`);
}

export function printOk(message: string): void {
	process.stdout.write(`${chalk.green("ok:")} ${message}\n`);
}

export function printHeader(message: string): void {
	process.stdout.write(`${chalk.cyan(message)}\n`);
}

export function parseFlags(argv: string[]): { flags: Set<string>; positional: string[] } {
	const flags = new Set<string>();
	const positional: string[] = [];
	for (const arg of argv) {
		if (arg.startsWith("--")) flags.add(arg.slice(2));
		else if (arg.startsWith("-") && arg.length > 1) flags.add(arg.slice(1));
		else positional.push(arg);
	}
	return { flags, positional };
}
```

- [ ] **Step 2: Commit**

```bash
git add src/cli/shared.ts
git commit -m "feat(cli): add shared helpers"
```

---

### Task 52: Write src/cli/version.ts

**Files:** Create `src/cli/version.ts`

- [ ] **Step 1: Write version.ts**

```ts
import { getVersionInfo } from "../domains/lifecycle/version.js";

export function runVersionCommand(): number {
	const v = getVersionInfo();
	const lines = [
		`clio ${v.clio}`,
		`node ${v.node}`,
		`platform ${v.platform}`,
		`pi-agent-core ${v.piAgentCore ?? "(missing)"}`,
		`pi-ai ${v.piAi ?? "(missing)"}`,
		`pi-tui ${v.piTui ?? "(missing)"}`,
	];
	process.stdout.write(lines.join("\n") + "\n");
	return 0;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/cli/version.ts
git commit -m "feat(cli): add version command"
```

---

### Task 53: Write src/cli/install.ts

**Files:** Create `src/cli/install.ts`

- [ ] **Step 1: Write install.ts**

```ts
import { initializeClioHome } from "../core/init.js";
import { printHeader, printOk } from "./shared.js";

export function runInstallCommand(): number {
	const report = initializeClioHome();
	printHeader("clio install");
	process.stdout.write(`config dir  ${report.configDir}\n`);
	process.stdout.write(`data dir    ${report.dataDir}\n`);
	process.stdout.write(`cache dir   ${report.cacheDir}\n`);
	if (report.createdPaths.length === 0) {
		printOk("already installed, nothing to do");
	} else {
		printOk(`created ${report.createdPaths.length} paths`);
		for (const p of report.createdPaths) process.stdout.write(`  + ${p}\n`);
	}
	return 0;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/cli/install.ts
git commit -m "feat(cli): add install command"
```

---

### Task 54: Write src/cli/doctor.ts

**Files:** Create `src/cli/doctor.ts`

- [ ] **Step 1: Write doctor.ts**

```ts
import { formatDoctorReport, runDoctor } from "../domains/lifecycle/doctor.js";

export function runDoctorCommand(): number {
	const findings = runDoctor();
	process.stdout.write(formatDoctorReport(findings) + "\n");
	return findings.every((f) => f.ok) ? 0 : 1;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/cli/doctor.ts
git commit -m "feat(cli): add doctor command"
```

---

### Task 55: Write src/cli/clio.ts

**Files:** Create `src/cli/clio.ts`

- [ ] **Step 1: Write clio.ts**

```ts
import { bootOrchestrator } from "../entry/orchestrator.js";

export async function runClioCommand(): Promise<number> {
	const result = await bootOrchestrator();
	return result.exitCode;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/cli/clio.ts
git commit -m "feat(cli): wire default command to orchestrator boot"
```

---

### Task 56: Write src/cli/index.ts

**Files:** Create `src/cli/index.ts`

- [ ] **Step 1: Write index.ts**

```ts
import { runClioCommand } from "./clio.js";
import { runDoctorCommand } from "./doctor.js";
import { runInstallCommand } from "./install.js";
import { parseFlags, printError } from "./shared.js";
import { runVersionCommand } from "./version.js";

const HELP = `clio — IOWarp orchestrator coding-agent

Usage:
  clio                  start interactive mode
  clio --version, -v    print version info
  clio doctor           run environment diagnostics
  clio install          bootstrap ~/.clio directory
  clio --help, -h       this message
`;

async function main(argv: string[]): Promise<number> {
	const { flags, positional } = parseFlags(argv);
	if (flags.has("help") || flags.has("h")) {
		process.stdout.write(HELP);
		return 0;
	}
	if (flags.has("version") || flags.has("v")) return runVersionCommand();

	const subcommand = positional[0];
	if (!subcommand) return runClioCommand();

	switch (subcommand) {
		case "doctor":
			return runDoctorCommand();
		case "install":
			return runInstallCommand();
		case "version":
			return runVersionCommand();
		default:
			printError(`unknown subcommand: ${subcommand}`);
			process.stdout.write(HELP);
			return 2;
	}
}

main(process.argv.slice(2))
	.then((code) => process.exit(code))
	.catch((err) => {
		printError(err instanceof Error ? err.message : String(err));
		process.exit(1);
	});
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/cli/index.ts
git commit -m "feat(cli): add subcommand dispatcher"
```

---

## Part H — Composition root (Task 57)

### Task 57: Write src/entry/orchestrator.ts

**Files:** Create `src/entry/orchestrator.ts`

- [ ] **Step 1: Write orchestrator.ts**

```ts
import chalk from "chalk";
import { BusChannels } from "../core/bus-events.js";
import { loadDomains } from "../core/domain-loader.js";
import { getSharedBus } from "../core/shared-bus.js";
import { StartupTimer } from "../core/startup-timer.js";
import { getTerminationCoordinator } from "../core/termination.js";
import { ConfigDomainModule } from "../domains/config/index.js";
import { LifecycleDomainModule, ensureInstalled } from "../domains/lifecycle/index.js";

export interface BootResult {
	exitCode: number;
	bootTimeMs: number;
}

const BANNER = `
  ${chalk.cyan("◆ clio")}  IOWarp orchestrator coding-agent
  ${chalk.dim("v0.1 dev · pi-mono 0.67.4 · ready")}
`;

export async function bootOrchestrator(): Promise<BootResult> {
	const timer = new StartupTimer();
	const bus = getSharedBus();
	const termination = getTerminationCoordinator();
	termination.installSignalHandlers();

	ensureInstalled();
	timer.mark("install check");

	const result = await loadDomains([ConfigDomainModule, LifecycleDomainModule]);
	timer.mark(`domains loaded (${result.loaded.length})`);

	bus.emit(BusChannels.SessionStart, { at: Date.now() });
	timer.mark("session_start fired");

	process.stdout.write(BANNER);
	if (process.env.CLIO_TIMING === "1") {
		process.stdout.write(timer.report() + "\n");
	}

	const runInteractive = process.env.CLIO_PHASE1_INTERACTIVE === "1";
	if (!runInteractive) {
		process.stdout.write(chalk.dim("  (Phase 1 stub — interactive loop lands in Phase 6)") + "\n");
		await termination.shutdown(0);
		return { exitCode: 0, bootTimeMs: timer.snapshot().totalMs };
	}

	// A real interactive loop lands in Phase 6. This stub keeps the process alive
	// until the user sends SIGINT/SIGTERM, so Phase 1 can smoke-test boot-and-idle.
	await new Promise<void>((resolve) => {
		termination.onDrain(() => resolve());
	});
	return { exitCode: 0, bootTimeMs: timer.snapshot().totalMs };
}
```

- [ ] **Step 2: Typecheck + boundary check**

Run: `npm run typecheck && npm run check:boundaries`
Expected: both pass.

- [ ] **Step 3: Commit**

```bash
git add src/entry/orchestrator.ts
git commit -m "feat(entry): add orchestrator composition root"
```

---

## Part I — Build + smoke (Tasks 58-62)

### Task 58: Build the bundle

- [ ] **Step 1: Clean and build**

Run: `npm run clean && npm run build`
Expected: `dist/cli/index.js` and the three worker stubs exist, no errors.

- [ ] **Step 2: Confirm binary has shebang and is executable**

Run: `head -1 dist/cli/index.js`
Expected: `#!/usr/bin/env node`

Run: `chmod +x dist/cli/index.js && ls -l dist/cli/index.js`
Expected: executable permission set.

No commit — build output is gitignored.

---

### Task 59: Exercise `clio --version`

- [ ] **Step 1: Run**

Run: `node dist/cli/index.js --version`
Expected output contains:
```
clio 0.1.0-dev
node v20.x.y (or later)
platform linux-x64 (or your platform)
pi-agent-core 0.67.4
pi-ai 0.67.4
pi-tui 0.67.4
```

- [ ] **Step 2: Run via `-v`**

Run: `node dist/cli/index.js -v`
Expected: same output.

No commit — verification.

---

### Task 60: Exercise `clio install`

- [ ] **Step 1: Run in a throwaway CLIO_HOME**

Run: `CLIO_HOME="$(mktemp -d)/clio" node dist/cli/index.js install`
Expected: `ok: created N paths` with the temp directory, then a list of created paths including `settings.yaml`, `credentials.yaml`, `install.json`, and the subdirectories.

- [ ] **Step 2: Run twice — second run is idempotent**

Run: `CLIO_HOME="$(mktemp -d)/clio" node dist/cli/index.js install && CLIO_HOME="$(mktemp -d)/clio" node dist/cli/index.js install`
Actually better: reuse the same CLIO_HOME and confirm "already installed, nothing to do":

```bash
export CLIO_HOME="$(mktemp -d)/clio"
node dist/cli/index.js install
node dist/cli/index.js install
```
Expected: first run creates paths; second run prints "already installed, nothing to do".

No commit — verification.

---

### Task 61: Exercise `clio doctor`

- [ ] **Step 1: Run against the temp install**

Run (same `CLIO_HOME` as Task 60): `node dist/cli/index.js doctor`
Expected: report with `OK` for clio version, node, platform, pi-agent-core, pi-ai, pi-tui, config dir, data dir, settings.yaml, credentials mode (600), install metadata. Exit code 0.

- [ ] **Step 2: Run against a deliberately broken install**

Run: `CLIO_HOME="$(mktemp -d)/nothing" node dist/cli/index.js doctor; echo "exit=$?"`
Expected: some `!!` lines (at least `settings.yaml missing`) and `exit=1`.

No commit — verification.

---

### Task 62: Exercise `clio` (default — orchestrator boot stub)

- [ ] **Step 1: Run against the good install**

Run: `CLIO_HOME="$CLIO_HOME" node dist/cli/index.js` (the export from Task 60)
Expected:
```
  ◆ clio  IOWarp orchestrator coding-agent
  v0.1 dev · pi-mono 0.67.4 · ready
  (Phase 1 stub — interactive loop lands in Phase 6)
clio: received SIG? (or clean shutdown)
```
Exit code 0.

- [ ] **Step 2: Run with timing enabled**

Run: `CLIO_TIMING=1 node dist/cli/index.js`
Expected: boot report with per-phase marks. Total should be ≤800ms on a warm Node.

No commit — verification.

---

## Part J — scripts/verify.ts (Task 63)

### Task 63: Write scripts/verify.ts

**Files:** Create `scripts/verify.ts`

- [ ] **Step 1: Write verify.ts**

```ts
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Phase 1 verification script. Builds once, then runs:
 *   - clio --version
 *   - clio install  (into an ephemeral CLIO_HOME)
 *   - clio doctor   (against the install)
 *   - clio          (orchestrator boot stub against the install)
 *
 * Exits 0 on success. Any step that deviates from expected output exits 1.
 */

const projectRoot = process.cwd();
const cliPath = join(projectRoot, "dist", "cli", "index.js");

function log(msg: string): void {
	process.stdout.write(`[verify] ${msg}\n`);
}

function fail(msg: string, detail?: string): never {
	process.stderr.write(`[verify] FAIL: ${msg}\n`);
	if (detail) process.stderr.write(detail + "\n");
	process.exit(1);
}

function ensureBuilt(): void {
	if (!existsSync(cliPath)) {
		log("dist/cli/index.js missing — running tsup build");
		execFileSync("npm", ["run", "build"], { stdio: "inherit" });
	}
}

function runCli(args: string[], env: NodeJS.ProcessEnv): { stdout: string; exitCode: number } {
	try {
		const stdout = execFileSync("node", [cliPath, ...args], {
			env,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		return { stdout, exitCode: 0 };
	} catch (err) {
		const e = err as NodeJS.ErrnoException & { stdout?: Buffer | string; status?: number };
		return {
			stdout: typeof e.stdout === "string" ? e.stdout : (e.stdout?.toString() ?? ""),
			exitCode: e.status ?? 1,
		};
	}
}

function checkVersion(env: NodeJS.ProcessEnv): void {
	const { stdout, exitCode } = runCli(["--version"], env);
	if (exitCode !== 0) fail(`clio --version exited ${exitCode}`, stdout);
	if (!stdout.includes("clio ")) fail("clio --version missing 'clio' line", stdout);
	if (!stdout.includes("pi-agent-core")) fail("clio --version missing pi-agent-core line", stdout);
	log("clio --version OK");
}

function checkInstall(home: string, env: NodeJS.ProcessEnv): void {
	const first = runCli(["install"], env);
	if (first.exitCode !== 0) fail(`clio install (first) exited ${first.exitCode}`, first.stdout);
	if (!first.stdout.includes("created")) fail("clio install (first) did not report created paths", first.stdout);

	const second = runCli(["install"], env);
	if (second.exitCode !== 0) fail(`clio install (second) exited ${second.exitCode}`, second.stdout);
	if (!second.stdout.includes("already installed")) fail("clio install (second) not idempotent", second.stdout);

	const settings = join(home, "settings.yaml");
	if (!existsSync(settings)) fail(`expected ${settings} to exist after install`);

	const install = join(home, "install.json"); // data dir = CLIO_HOME when CLIO_HOME is set
	// under CLIO_HOME, data dir is CLIO_HOME/data (see xdg.ts). Adjust check:
	const dataDir = join(home, "data");
	const installJson = join(dataDir, "install.json");
	if (!existsSync(installJson) && !existsSync(install)) {
		fail(`expected install.json under ${dataDir} or ${home}`);
	}
	log("clio install OK (idempotent)");
}

function checkDoctor(env: NodeJS.ProcessEnv): void {
	const { stdout, exitCode } = runCli(["doctor"], env);
	if (exitCode !== 0) fail(`clio doctor exited ${exitCode}`, stdout);
	if (!stdout.includes("clio version")) fail("clio doctor missing 'clio version' row", stdout);
	if (!stdout.includes("settings.yaml")) fail("clio doctor missing settings.yaml row", stdout);
	log("clio doctor OK");
}

function checkBoot(env: NodeJS.ProcessEnv): void {
	const { stdout, exitCode } = runCli([], env);
	if (exitCode !== 0) fail(`clio (default) exited ${exitCode}`, stdout);
	if (!stdout.includes("◆ clio")) fail("banner missing from clio default output", stdout);
	log("clio (orchestrator boot) OK");
}

function main(): void {
	ensureBuilt();
	const home = mkdtempSync(join(tmpdir(), "clio-verify-"));
	const env: NodeJS.ProcessEnv = { ...process.env, CLIO_HOME: home };
	log(`ephemeral CLIO_HOME=${home}`);
	checkVersion(env);
	checkInstall(home, env);
	checkDoctor(env);
	checkBoot(env);
	log("all checks passed");
}

main();
```

- [ ] **Step 2: Verify `init.ts` actually writes `install.json` under `<dataDir>`**

Re-read `src/core/init.ts` — `install.json` is written to `clioDataDir()`. With `CLIO_HOME=/tmp/foo`, `clioDataDir()` returns `/tmp/foo/data` (per the implementation in Task 14). `settings.yaml` is written to `clioConfigDir()` which returns `/tmp/foo` when `CLIO_HOME` is set. The verify script checks both possibilities for `install.json` to cover the XDG-split and CLIO_HOME branches.

No edit — just confirming the verify script matches the xdg semantics.

- [ ] **Step 3: Run verify locally**

Run: `npm run build && npm run verify`
Expected: `[verify] all checks passed` and exit 0.

- [ ] **Step 4: Commit**

```bash
git add scripts/verify.ts
git commit -m "build: add Phase 1 inline verify script"
```

---

## Part K — CI green + Phase-1 exit gate (Tasks 64-66)

### Task 64: Run the full local CI

- [ ] **Step 1: Run the aggregate script**

Run: `npm run ci`
Expected: typecheck, lint, boundaries, prompts, build, verify all pass.

- [ ] **Step 2: If lint fails, auto-format**

Run: `npm run format` then `npm run lint`.
Re-run `npm run ci` until green.

No commit — or, if format produced changes:

```bash
git add -u
git commit -m "chore: apply biome formatting"
```

---

### Task 65: Push to remote and confirm GitHub Actions is green

- [ ] **Step 1: Confirm branch state**

Run: `git status && git log --oneline -10`
Expected: clean working tree, ~40 Phase-1 commits visible.

- [ ] **Step 2: Ask user before pushing**

Do not push to `origin/main` without explicit user confirmation. Ask:
"Phase 1 CI is green locally. Push to origin/main to verify GitHub Actions?"

- [ ] **Step 3: If user confirms**

Run: `git push origin main`
Then monitor: `gh run watch` or visit the Actions tab.
Expected: workflow `ci` passes.

---

### Task 66: Tag Phase 1 and open the Phase 2 plan stub

- [ ] **Step 1: Tag (locally; push only with user confirmation)**

Run: `git tag -a phase-1-complete -m "Phase 1 Foundation complete: clio boots, boundaries enforced, verify green"`

- [ ] **Step 2: Open a placeholder for the Phase 2 plan**

Create `docs/superpowers/plans/2026-04-16-clio-coder-phase-2-safety-modes.md`:

```markdown
# Phase 2 — Safety & Modes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Status:** Not yet planned. Write this document before starting Phase 2.

**Depends on:** Phase 1 complete (tag `phase-1-complete`).

**Goal:** Implement the safety domain (action classifier, scope, audit) and modes domain (matrix, state, Shift+Tab mode-cycling), with mode gating applied at the tool registry level.

**Exit criteria:** see `2026-04-16-clio-coder-roadmap.md` under Phase 2.
```

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/plans/2026-04-16-clio-coder-phase-2-safety-modes.md
git commit -m "docs: open Phase 2 plan placeholder"
```

---

## Self-review checklist (run before declaring Phase 1 complete)

1. **Spec coverage.** Every Phase 1 exit criterion from the roadmap has at least one task that produces it.
    - [x] `npm run typecheck` green — Tasks 2, 24, 26, 33, 40, 41, 49, 56, 57 each end with typecheck
    - [x] `npm run build` green — Task 58
    - [x] `clio --version` — Tasks 52 + 59
    - [x] `clio doctor` — Tasks 46, 54, 61
    - [x] `clio install` — Tasks 53, 60
    - [x] `clio` boots — Tasks 57, 62
    - [x] `npm run check:boundaries` green with three rules — Tasks 9-11, 33, 41
    - [x] `npm run verify` green — Task 63
    - [x] CI workflow — Tasks 6, 65

2. **Placeholder scan.** No "TBD", "fill in", or naked "add error handling" in the plan. Confirmed — every code step shows full source.

3. **Type consistency.**
    - `DomainModule.createExtension` returns `DomainBundle<TContract>` (Task 24); both domain modules comply (Tasks 40, 48).
    - `ClioSettings` type defined in Task 36 and re-exported from `src/domains/config/index.ts` (Task 41).
    - `ConfigContract` defined in Task 40 (contract.ts) and re-exported from the domain barrel.
    - `LifecycleContract` defined in Task 48 (contract.ts) and re-exported from the domain barrel.
    - `VersionInfo` defined in Task 44, referenced by the CLI version command (Task 52) and doctor (Task 46).
    - `BusChannels` constants in Task 18 are referenced by `termination.ts` (Task 20), `domain-loader.ts` (Task 24), `config/extension.ts` (Task 40), and `orchestrator.ts` (Task 57). The three config-change channels (`ConfigHotReload`, `ConfigNextTurn`, `ConfigRestartRequired`) implement the spec §13 hot-reload matrix.
    - `clioConfigDir`/`clioDataDir`/`clioCacheDir` defined in Task 14 are the only path accessors; used by `init.ts` (Task 26), `config.ts` (Task 36), `install.ts` (Task 45), `doctor.ts` (Task 46).

4. **Codex adversarial review — findings addressed in this plan revision.**

    | # | Finding | Task(s) touched |
    |---|---|---|
    | 1 | Wrong pi-mono API symbols | Task 0 (audit), Tasks 27-30 (rewrite against 0.67.4 real exports) |
    | 2 | DomainContext.getDependency returns live extensions | Task 24 (contracts pattern), Task 9 (rule 3 boundary check), Tasks 40/41/48/49 (bundle shape) |
    | 3 | Engine-boundary safety-ext carve-out | Task 9 (exception removed), Task 11 (tests rule 3 now), roadmap Phase 6 (engine/worker-runtime.ts owns worker-side pi-mono) |
    | 4 | Critical path wrong (TUI before dispatch) | Addressed in roadmap phase reorder; no Phase 1 change |
    | 5 | Config watcher stale snapshot, no hot-reload matrix | Task 39 (watcher + classify.ts), Task 40 (re-read + classify + emit typed events), Task 18 (new bus channels) |
    | 6 | Prompt reproducibility two-hash gap | Addressed in roadmap Phase 3 exit criteria; no Phase 1 change |
    | 7 | Windows claimed, never CI-tested | Addressed in roadmap "Platform scope for v0.1"; Phase 1 scripts remain Linux+macOS-only |
    | 8 | 43-hour estimate is theatre | Addressed in roadmap "Honest effort estimate (P50 / P90)" |

5. **New verification coverage introduced by this revision.**
    - Boundary rule 3 is tested in Task 11 (plants a cross-domain extension.ts import and confirms the checker rejects it).
    - The hot-reload classifier will need a diag script when it matters in Phase 2 (when safety + modes consume the `ConfigHotReload` event). Phase 1 stops at emitting the event; downstream consumption is a Phase 2 concern.

---

## Execution handoff

**Plan complete and saved to `docs/superpowers/plans/2026-04-16-clio-coder-phase-1-foundation.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration. Works well for tight scaffolding like Phase 1.

**2. Inline Execution** — Execute tasks in this session using `superpowers:executing-plans`, batch execution with checkpoints every ~10 tasks.

**Which approach?**

# Clio Harness Hot-Reload Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a `CLIO_SELF_DEV=1` mode that hot-swaps `src/tools/*.ts` edits live and offers a one-key restart for every other source change, preserving the session across the restart.

**Architecture:** A new `src/harness/` subsystem runs inside the orchestrator process. It watches `src/**` with native `fs.watch`, classifies each change, hot-compiles single tool files via `esbuild.transform` into `$CLIO_CACHE_DIR/hot/`, re-registers them on the live `ToolRegistry`, and surfaces state through the TUI footer. For non-hot changes it emits a restart prompt; pressing `R` detaches a respawned `clio`, hands off the TTY via `stdio: "inherit"`, then runs the existing 4-phase shutdown. Session continuity is carried through a new `CLIO_RESUME_SESSION_ID` env var that the orchestrator honors after `loadDomains`.

**Tech Stack:** TypeScript 5.7 (strict, NodeNext), Node 20+, `node:fs.watch` recursive, `esbuild` (new explicit dep, already transitive via `tsup`), `node:test`, `node-pty` (existing devDep), tsup ESM bundles.

**Spec:** `docs/superpowers/specs/2026-04-22-clio-harness-hot-reload-design.md`

---

## File Structure

**New files (all under `src/harness/`):**

- `src/harness/classifier.ts` — pure `(absPath, repoRoot) => { class, reason }`. No I/O.
- `src/harness/state.ts` — footer-indicator state machine, last-event bookkeeping.
- `src/harness/watcher.ts` — `fs.watch(repoRoot/src)` + root-config-files watcher, debounce, emits `FileChangeEvent`.
- `src/harness/hot-compile.ts` — `esbuild.transform({ loader: "ts", format: "esm" })` → write to `$CLIO_CACHE_DIR/hot/`.
- `src/harness/tool-reloader.ts` — compile + dynamic-import + `toolRegistry.register(spec)`.
- `src/harness/restart.ts` — spawn detached child with session env + run 4-phase shutdown.
- `src/harness/index.ts` — `startHarness(deps): HarnessHandle`, wires watcher → classifier → reloader/restart-state.

**Modified files:**

- `package.json` — add `esbuild` dep, pinned.
- `src/core/bus-events.ts` — add 6 harness channels.
- `src/entry/orchestrator.ts` — add `CLIO_RESUME_SESSION_ID` handling + `CLIO_SELF_DEV` harness gate + extend banner.
- `src/interactive/footer-panel.ts` — accept `harnessState` dep, render extra line when non-idle.
- `src/interactive/index.ts` — wire footer to harness state + `R` keystroke when state is `restart-required`.
- `tests/boundaries/check-boundaries.ts` — add `rule4` for `src/harness/**`.

**New test files:**

- `tests/unit/harness-classifier.test.ts`
- `tests/unit/harness-state.test.ts`
- `tests/unit/harness-restart.test.ts`
- `tests/integration/harness-hotreload.test.ts`
- `tests/e2e/self-dev.test.ts`

---

## Task 0: Branch + dep setup

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Verify branch**

Run: `git branch --show-current`
Expected: `feat/harness-hot-reload`

- [ ] **Step 2: Verify clean working tree (spec commit already landed)**

Run: `git status --short`
Expected: empty or only untracked test artifacts; no modified tracked files.

- [ ] **Step 3: Add esbuild as an explicit dep**

Run: `npm install --save --save-exact esbuild@0.24.2`
Expected: `package.json` gains `"esbuild": "0.24.2"` under `dependencies`; `package-lock.json` updated; no new top-level packages beyond esbuild itself (already transitive via tsup).

- [ ] **Step 4: Baseline CI stays green**

Run: `npm run typecheck && npm run lint && npm run test`
Expected: all green. No changes to behavior yet.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json
git commit -m "build(harness): add esbuild@0.24.2 as explicit dep

required for src/harness/hot-compile.ts to transform src/tools/*.ts
on-demand when CLIO_SELF_DEV=1. already present transitively via tsup;
pinning makes it a first-class surface."
```

---

## Task 1: Bus channels for harness events

**Files:**
- Modify: `src/core/bus-events.ts`

- [ ] **Step 1: Add the six harness channels**

Edit `src/core/bus-events.ts` to add these entries inside `BusChannels` (place after `ShutdownPersisted`):

```ts
	HarnessWatcherStarted: "harness.watcher.started",
	HarnessFileChanged: "harness.file.changed",
	HarnessHotreloadSucceeded: "harness.hotreload.succeeded",
	HarnessHotreloadFailed: "harness.hotreload.failed",
	HarnessRestartRequired: "harness.restart.required",
	HarnessRestartTriggered: "harness.restart.triggered",
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: pass.

- [ ] **Step 3: Commit**

```bash
git add src/core/bus-events.ts
git commit -m "feat(core): harness bus channels for watcher/hotreload/restart"
```

---

## Task 2: Classifier (pure)

**Files:**
- Create: `src/harness/classifier.ts`
- Create: `tests/unit/harness-classifier.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/harness-classifier.test.ts`:

```ts
import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import { classifyChange } from "../../src/harness/classifier.js";

const REPO = "/repo";

function classify(rel: string) {
	return classifyChange(join(REPO, rel), REPO);
}

describe("classifyChange", () => {
	it("hot: src/tools/read.ts", () => strictEqual(classify("src/tools/read.ts").class, "hot"));
	it("hot: src/tools/edit.ts", () => strictEqual(classify("src/tools/edit.ts").class, "hot"));
	it("restart: src/tools/registry.ts", () => strictEqual(classify("src/tools/registry.ts").class, "restart"));
	it("restart: src/tools/bootstrap.ts", () => strictEqual(classify("src/tools/bootstrap.ts").class, "restart"));
	it("restart: src/tools/truncate-utf8.ts", () => strictEqual(classify("src/tools/truncate-utf8.ts").class, "restart"));
	it("restart: src/engine/agent.ts", () => strictEqual(classify("src/engine/agent.ts").class, "restart"));
	it("restart: src/core/config.ts", () => strictEqual(classify("src/core/config.ts").class, "restart"));
	it("restart: src/domains/session/extension.ts", () =>
		strictEqual(classify("src/domains/session/extension.ts").class, "restart"));
	it("restart: src/domains/providers/runtimes/local.ts", () =>
		strictEqual(classify("src/domains/providers/runtimes/local.ts").class, "restart"));
	it("worker-next-dispatch: src/worker/entry.ts", () =>
		strictEqual(classify("src/worker/entry.ts").class, "worker-next-dispatch"));
	it("restart: src/entry/orchestrator.ts", () =>
		strictEqual(classify("src/entry/orchestrator.ts").class, "restart"));
	it("restart: src/cli/clio.ts", () => strictEqual(classify("src/cli/clio.ts").class, "restart"));
	it("restart: src/interactive/overlays/model-selector.ts", () =>
		strictEqual(classify("src/interactive/overlays/model-selector.ts").class, "restart"));
	it("restart: src/harness/classifier.ts (self)", () =>
		strictEqual(classify("src/harness/classifier.ts").class, "restart"));
	it("ignore: tests/unit/foo.test.ts", () =>
		strictEqual(classify("tests/unit/foo.test.ts").class, "ignore"));
	it("ignore: docs/README.md", () => strictEqual(classify("docs/README.md").class, "ignore"));
	it("ignore: src/tools/README.md", () => strictEqual(classify("src/tools/README.md").class, "ignore"));
	it("restart: package.json", () => strictEqual(classify("package.json").class, "restart"));
	it("restart: tsconfig.json", () => strictEqual(classify("tsconfig.json").class, "restart"));
	it("restart: tsup.config.ts", () => strictEqual(classify("tsup.config.ts").class, "restart"));
	it("ignore: dist/cli/index.js", () => strictEqual(classify("dist/cli/index.js").class, "ignore"));
	it("ignore: node_modules/foo/index.js", () =>
		strictEqual(classify("node_modules/foo/index.js").class, "ignore"));
	it("ignore: absolute path outside repo", () => {
		strictEqual(classifyChange("/tmp/other/file.ts", REPO).class, "ignore");
	});
	it("returns a non-empty reason for every class", () => {
		const paths = [
			"src/tools/read.ts",
			"src/domains/session/extension.ts",
			"src/worker/entry.ts",
			"docs/README.md",
		];
		for (const p of paths) {
			const result = classify(p);
			strictEqual(typeof result.reason, "string");
			deepStrictEqual(result.reason.length > 0, true);
		}
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test tests/unit/harness-classifier.test.ts`
Expected: FAIL with "Cannot find module '../../src/harness/classifier.js'".

- [ ] **Step 3: Write minimal implementation**

Create `src/harness/classifier.ts`:

```ts
import { isAbsolute, relative, sep } from "node:path";

export type ChangeClass = "hot" | "restart" | "worker-next-dispatch" | "ignore";

export interface ClassifyResult {
	class: ChangeClass;
	reason: string;
}

const HOT_TOOL_EXCLUSIONS = new Set(["registry.ts", "bootstrap.ts", "truncate-utf8.ts"]);
const ROOT_CONFIG_FILES = new Set([
	"package.json",
	"package-lock.json",
	"tsconfig.json",
	"tsconfig.tests.json",
	"tsup.config.ts",
	"biome.json",
	".gitignore",
]);
const IGNORE_EXTENSIONS = new Set([".md", ".mdx"]);

function toPosix(p: string): string {
	return p.split(sep).join("/");
}

/**
 * Pure classifier. Given an absolute path and the repo root, returns which
 * runtime action the harness should take when this file changes. No I/O.
 */
export function classifyChange(absPath: string, repoRoot: string): ClassifyResult {
	if (!isAbsolute(absPath)) {
		return { class: "ignore", reason: "not an absolute path" };
	}
	const rel = toPosix(relative(repoRoot, absPath));
	if (rel === "" || rel.startsWith("..")) {
		return { class: "ignore", reason: "outside repo root" };
	}

	// Ignore dirs first.
	if (rel.startsWith("dist/") || rel.startsWith("node_modules/") || rel.startsWith(".git/")) {
		return { class: "ignore", reason: "generated or vendored path" };
	}
	if (rel.startsWith("tests/") || rel.startsWith("docs/")) {
		return { class: "ignore", reason: "tests/docs do not affect runtime" };
	}

	const lastDot = rel.lastIndexOf(".");
	const ext = lastDot >= 0 ? rel.slice(lastDot) : "";
	if (IGNORE_EXTENSIONS.has(ext)) {
		return { class: "ignore", reason: "markdown has no runtime impact" };
	}

	// Root config files: full restart.
	if (!rel.includes("/") && ROOT_CONFIG_FILES.has(rel)) {
		return { class: "restart", reason: `root config file ${rel} changes the build graph` };
	}
	if (!rel.includes("/")) {
		return { class: "ignore", reason: "top-level non-source file" };
	}

	if (rel.startsWith("src/tools/")) {
		const basename = rel.slice("src/tools/".length);
		if (basename.includes("/")) {
			return { class: "restart", reason: `nested tool file ${basename} is not a flat tool spec` };
		}
		if (!basename.endsWith(".ts")) {
			return { class: "ignore", reason: `non-ts tool file ${basename}` };
		}
		if (HOT_TOOL_EXCLUSIONS.has(basename)) {
			return { class: "restart", reason: `${basename} is registry/bootstrap/utility, shape changes affect every tool` };
		}
		return { class: "hot", reason: `tool spec ${basename} is self-contained and re-registerable` };
	}

	if (rel.startsWith("src/worker/")) {
		return { class: "worker-next-dispatch", reason: "workers re-spawn each dispatch" };
	}

	if (rel.startsWith("src/engine/")) {
		return { class: "restart", reason: "engine owns pi-mono; re-import mid-run is ill-defined" };
	}
	if (rel.startsWith("src/core/")) {
		return { class: "restart", reason: "core is boot foundation held in singletons" };
	}
	if (rel.startsWith("src/domains/")) {
		return { class: "restart", reason: "domain extensions hold untracked bus subscriptions" };
	}
	if (rel.startsWith("src/interactive/")) {
		return { class: "restart", reason: "interactive root statically imports its children" };
	}
	if (rel.startsWith("src/entry/")) {
		return { class: "restart", reason: "boot composition root" };
	}
	if (rel.startsWith("src/cli/")) {
		return { class: "restart", reason: "argv already parsed" };
	}
	if (rel.startsWith("src/harness/")) {
		return { class: "restart", reason: "changing hot-reload code while hot-reload runs is a footgun" };
	}

	if (rel.startsWith("src/")) {
		return { class: "restart", reason: `unknown src subtree ${rel}` };
	}

	return { class: "ignore", reason: `unhandled path ${rel}` };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test tests/unit/harness-classifier.test.ts`
Expected: all 24+ tests PASS.

- [ ] **Step 5: Boundaries still clean**

Run: `npm run test 2>&1 | tail -20`
Expected: new unit test passes alongside existing ones; boundary check reports 0 violations.

- [ ] **Step 6: Commit**

```bash
git add src/harness/classifier.ts tests/unit/harness-classifier.test.ts
git commit -m "feat(harness): classifier maps every src/** path to hot/restart/worker/ignore"
```

---

## Task 3: State machine

**Files:**
- Create: `src/harness/state.ts`
- Create: `tests/unit/harness-state.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/harness-state.test.ts`:

```ts
import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { HarnessState } from "../../src/harness/state.js";

describe("HarnessState", () => {
	it("starts idle", () => {
		const state = new HarnessState({ now: () => 1000 });
		deepStrictEqual(state.snapshot(), { kind: "idle" });
	});

	it("transitions to hot-ready with expiry", () => {
		const state = new HarnessState({ now: () => 1000 });
		state.hotSucceeded("src/tools/read.ts", 14);
		deepStrictEqual(state.snapshot(), {
			kind: "hot-ready",
			message: "read.ts (14ms)",
			until: 4000,
		});
	});

	it("hot-ready expires back to idle after the TTL", () => {
		let t = 1000;
		const state = new HarnessState({ now: () => t });
		state.hotSucceeded("src/tools/read.ts", 14);
		t = 3999;
		strictEqual(state.snapshot().kind, "hot-ready");
		t = 4001;
		deepStrictEqual(state.snapshot(), { kind: "idle" });
	});

	it("hot-failed shows error message", () => {
		const state = new HarnessState({ now: () => 2000 });
		state.hotFailed("src/tools/edit.ts", "syntax error line 42");
		deepStrictEqual(state.snapshot(), {
			kind: "hot-failed",
			message: "edit.ts: syntax error line 42",
			until: 5000,
		});
	});

	it("restart-required accumulates files and persists", () => {
		let t = 1000;
		const state = new HarnessState({ now: () => t });
		state.restartRequired("src/domains/session/manifest.ts", "manifest");
		t = 5000;
		state.restartRequired("src/engine/agent.ts", "engine");
		deepStrictEqual(state.snapshot(), {
			kind: "restart-required",
			files: ["src/domains/session/manifest.ts", "src/engine/agent.ts"],
		});
	});

	it("restart-required dedupes repeated paths", () => {
		const state = new HarnessState({ now: () => 1000 });
		state.restartRequired("src/core/config.ts", "core");
		state.restartRequired("src/core/config.ts", "core");
		const snap = state.snapshot();
		if (snap.kind !== "restart-required") throw new Error("expected restart-required");
		deepStrictEqual(snap.files, ["src/core/config.ts"]);
	});

	it("hot events do not clear restart-required", () => {
		let t = 1000;
		const state = new HarnessState({ now: () => t });
		state.restartRequired("src/engine/agent.ts", "engine");
		t = 2000;
		state.hotSucceeded("src/tools/read.ts", 7);
		strictEqual(state.snapshot().kind, "restart-required");
	});

	it("workerPending accumulates and is informational", () => {
		const state = new HarnessState({ now: () => 1000 });
		state.workerChanged("src/worker/entry.ts");
		state.workerChanged("src/worker/heartbeat.ts");
		deepStrictEqual(state.snapshot(), { kind: "worker-pending", count: 2 });
	});

	it("restart-required supersedes worker-pending", () => {
		const state = new HarnessState({ now: () => 1000 });
		state.workerChanged("src/worker/entry.ts");
		state.restartRequired("src/engine/agent.ts", "engine");
		strictEqual(state.snapshot().kind, "restart-required");
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test tests/unit/harness-state.test.ts`
Expected: FAIL with "Cannot find module '../../src/harness/state.js'".

- [ ] **Step 3: Write minimal implementation**

Create `src/harness/state.ts`:

```ts
import { basename } from "node:path";

export type HarnessSnapshot =
	| { kind: "idle" }
	| { kind: "hot-ready"; message: string; until: number }
	| { kind: "hot-failed"; message: string; until: number }
	| { kind: "restart-required"; files: string[] }
	| { kind: "worker-pending"; count: number };

const HOT_READY_TTL_MS = 3000;
const HOT_FAILED_TTL_MS = 3000;

export interface HarnessStateDeps {
	now: () => number;
}

/**
 * Footer-indicator state machine. Transient events (hot success/failure)
 * auto-expire; persistent events (restart-required, worker-pending) stay
 * until superseded. Restart-required is the highest-priority state.
 */
export class HarnessState {
	private readonly now: () => number;
	private transient: { kind: "hot-ready" | "hot-failed"; message: string; until: number } | null = null;
	private readonly restartFiles: string[] = [];
	private readonly workerFiles: Set<string> = new Set();

	constructor(deps: HarnessStateDeps) {
		this.now = deps.now;
	}

	snapshot(): HarnessSnapshot {
		if (this.restartFiles.length > 0) {
			return { kind: "restart-required", files: [...this.restartFiles] };
		}
		if (this.transient && this.now() < this.transient.until) {
			return { ...this.transient };
		}
		if (this.transient && this.now() >= this.transient.until) {
			this.transient = null;
		}
		if (this.workerFiles.size > 0) {
			return { kind: "worker-pending", count: this.workerFiles.size };
		}
		return { kind: "idle" };
	}

	hotSucceeded(path: string, elapsedMs: number): void {
		this.transient = {
			kind: "hot-ready",
			message: `${basename(path)} (${elapsedMs}ms)`,
			until: this.now() + HOT_READY_TTL_MS,
		};
	}

	hotFailed(path: string, error: string): void {
		this.transient = {
			kind: "hot-failed",
			message: `${basename(path)}: ${error}`,
			until: this.now() + HOT_FAILED_TTL_MS,
		};
	}

	restartRequired(path: string, _reason: string): void {
		if (!this.restartFiles.includes(path)) {
			this.restartFiles.push(path);
		}
	}

	workerChanged(path: string): void {
		this.workerFiles.add(path);
	}

	clearRestartRequired(): void {
		this.restartFiles.length = 0;
	}
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test tests/unit/harness-state.test.ts`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/harness/state.ts tests/unit/harness-state.test.ts
git commit -m "feat(harness): footer-indicator state machine with TTL + priority"
```

---

## Task 4: Hot-compile (esbuild transform)

**Files:**
- Create: `src/harness/hot-compile.ts`
- Create: `tests/integration/harness-hot-compile.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/integration/harness-hot-compile.test.ts`:

```ts
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { ok, strictEqual } from "node:assert/strict";
import { compileTool } from "../../src/harness/hot-compile.js";

describe("compileTool", () => {
	let tmp: string;
	let cache: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "clio-hot-compile-"));
		cache = join(tmp, "cache");
	});
	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("transforms a valid TS tool file to an ESM bundle on disk", async () => {
		const source = join(tmp, "fake.ts");
		writeFileSync(source, `export const fakeTool = { name: "fake", run: async () => ({ kind: "ok", output: "hi" }) };\n`);
		const result = await compileTool(source, cache);
		strictEqual(result.kind, "ok");
		if (result.kind !== "ok") return;
		ok(result.outputPath.endsWith(".mjs"), `expected .mjs, got ${result.outputPath}`);
		const contents = readFileSync(result.outputPath, "utf8");
		ok(contents.includes("fakeTool"), "compiled output should reference fakeTool");
		ok(contents.includes("export"), "compiled output should be ESM");
	});

	it("returns an error result for invalid TS", async () => {
		const source = join(tmp, "broken.ts");
		writeFileSync(source, "export const x: = }\n");
		const result = await compileTool(source, cache);
		strictEqual(result.kind, "error");
		if (result.kind === "error") ok(result.error.length > 0);
	});

	it("uses content-hashed filenames so repeated compiles are cache-busted", async () => {
		const source = join(tmp, "same.ts");
		writeFileSync(source, `export const sameTool = { name: "same" };\n`);
		const a = await compileTool(source, cache);
		writeFileSync(source, `export const sameTool = { name: "same2" };\n`);
		const b = await compileTool(source, cache);
		strictEqual(a.kind, "ok");
		strictEqual(b.kind, "ok");
		if (a.kind === "ok" && b.kind === "ok") ok(a.outputPath !== b.outputPath);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test tests/integration/harness-hot-compile.test.ts`
Expected: FAIL with "Cannot find module '../../src/harness/hot-compile.js'".

- [ ] **Step 3: Write minimal implementation**

Create `src/harness/hot-compile.ts`:

```ts
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { transform } from "esbuild";

export type CompileResult = { kind: "ok"; outputPath: string } | { kind: "error"; error: string };

/**
 * Transform a TypeScript file to an ESM module on disk under `cacheRoot`.
 * The output filename is content-hashed so every successful compile produces
 * a fresh URL (Node's ESM loader caches by URL, so a new name bypasses the
 * cache without a loader hook).
 */
export async function compileTool(sourcePath: string, cacheRoot: string): Promise<CompileResult> {
	let source: string;
	try {
		source = readFileSync(sourcePath, "utf8");
	} catch (err) {
		return { kind: "error", error: `read failed: ${err instanceof Error ? err.message : String(err)}` };
	}

	let js: string;
	try {
		const result = await transform(source, {
			loader: "ts",
			format: "esm",
			target: "node20",
			sourcefile: sourcePath,
			sourcemap: "inline",
		});
		js = result.code;
	} catch (err) {
		return { kind: "error", error: err instanceof Error ? err.message : String(err) };
	}

	const hash = createHash("sha256").update(js).digest("hex").slice(0, 10);
	const base = basename(sourcePath, ".ts");
	const outDir = join(cacheRoot, "hot", "tools");
	try {
		mkdirSync(outDir, { recursive: true });
	} catch (err) {
		return { kind: "error", error: `mkdir failed: ${err instanceof Error ? err.message : String(err)}` };
	}
	const outputPath = join(outDir, `${base}-${hash}.mjs`);
	try {
		writeFileSync(outputPath, js);
	} catch (err) {
		return { kind: "error", error: `write failed: ${err instanceof Error ? err.message : String(err)}` };
	}
	return { kind: "ok", outputPath };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test tests/integration/harness-hot-compile.test.ts`
Expected: all 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/harness/hot-compile.ts tests/integration/harness-hot-compile.test.ts
git commit -m "feat(harness): esbuild-backed TS→ESM hot compile with content-hashed cache"
```

---

## Task 5: Tool reloader

**Files:**
- Create: `src/harness/tool-reloader.ts`
- Create: `tests/integration/harness-tool-reloader.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/integration/harness-tool-reloader.test.ts`:

```ts
import { strictEqual } from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { reloadToolFile } from "../../src/harness/tool-reloader.js";
import type { ToolRegistry, ToolSpec } from "../../src/tools/registry.js";

function fakeRegistry(): ToolRegistry & { lastRegistered: ToolSpec | null } {
	let last: ToolSpec | null = null;
	return {
		lastRegistered: null,
		get lastRegistered_(): ToolSpec | null {
			return last;
		},
		register(spec: ToolSpec) {
			last = spec;
			(this as ToolRegistry & { lastRegistered: ToolSpec | null }).lastRegistered = spec;
		},
		listAll: () => (last ? [last] : []),
		listVisible: () => (last ? [last] : []),
		get: (name) => (last && last.name === name ? last : undefined),
		listForMode: () => (last ? [last.name] : []),
		invoke: async () => ({ kind: "not_visible", reason: "stub" }),
	} as unknown as ToolRegistry & { lastRegistered: ToolSpec | null };
}

describe("reloadToolFile", () => {
	let tmp: string;
	let cache: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "clio-tool-reload-"));
		cache = join(tmp, "cache");
	});
	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("compiles, imports, and re-registers a valid tool file", async () => {
		const source = join(tmp, "fake.ts");
		writeFileSync(
			source,
			`export const fakeTool = {
				name: "fake",
				description: "fake",
				parameters: { type: "object", properties: {}, additionalProperties: false },
				baseActionClass: "read",
				async run() { return { kind: "ok", output: "v1" }; },
			};\n`,
		);
		const registry = fakeRegistry();
		const allowedModesByName = new Map<string, ReadonlyArray<string>>([["fake", ["default"]]]);
		const result = await reloadToolFile(source, cache, registry, allowedModesByName);
		strictEqual(result.kind, "ok");
		strictEqual(registry.lastRegistered?.name, "fake");
		const run = await registry.lastRegistered?.run({});
		strictEqual(run?.kind, "ok");
		if (run?.kind === "ok") strictEqual(run.output, "v1");
	});

	it("re-running on an edited file swaps the behavior", async () => {
		const source = join(tmp, "fake.ts");
		writeFileSync(source, `export const fakeTool = { name: "fake", description: "d", parameters: { type: "object", properties: {}, additionalProperties: false }, baseActionClass: "read", async run() { return { kind: "ok", output: "v1" }; } };\n`);
		const registry = fakeRegistry();
		const allowedModesByName = new Map<string, ReadonlyArray<string>>();
		await reloadToolFile(source, cache, registry, allowedModesByName);
		writeFileSync(source, `export const fakeTool = { name: "fake", description: "d", parameters: { type: "object", properties: {}, additionalProperties: false }, baseActionClass: "read", async run() { return { kind: "ok", output: "v2" }; } };\n`);
		await reloadToolFile(source, cache, registry, allowedModesByName);
		const run = await registry.lastRegistered?.run({});
		strictEqual(run?.kind, "ok");
		if (run?.kind === "ok") strictEqual(run.output, "v2");
	});

	it("returns an error when compile fails", async () => {
		const source = join(tmp, "broken.ts");
		writeFileSync(source, "export const broken: = }\n");
		const registry = fakeRegistry();
		const result = await reloadToolFile(source, cache, registry, new Map());
		strictEqual(result.kind, "error");
	});

	it("returns an error when the module exports no recognizable tool", async () => {
		const source = join(tmp, "empty.ts");
		writeFileSync(source, `export const unrelated = 42;\n`);
		const registry = fakeRegistry();
		const result = await reloadToolFile(source, cache, registry, new Map());
		strictEqual(result.kind, "error");
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test tests/integration/harness-tool-reloader.test.ts`
Expected: FAIL with "Cannot find module '../../src/harness/tool-reloader.js'".

- [ ] **Step 3: Write minimal implementation**

Create `src/harness/tool-reloader.ts`:

```ts
import { pathToFileURL } from "node:url";
import type { ToolRegistry, ToolSpec } from "../tools/registry.js";
import { compileTool } from "./hot-compile.js";

export type ReloadResult = { kind: "ok"; name: string; elapsedMs: number } | { kind: "error"; error: string };

/**
 * Inspects the dynamic import result for a single property whose name ends
 * with "Tool" and whose value looks like a ToolSpec (has string name + fn run).
 */
function findToolExport(mod: Record<string, unknown>): ToolSpec | null {
	for (const [key, value] of Object.entries(mod)) {
		if (!key.endsWith("Tool")) continue;
		if (value && typeof value === "object" && typeof (value as { name?: unknown }).name === "string" && typeof (value as { run?: unknown }).run === "function") {
			return value as ToolSpec;
		}
	}
	return null;
}

/**
 * Compile a single src/tools/*.ts file, dynamic-import it, and re-register
 * the resulting tool spec on the live ToolRegistry. allowedModesByName is
 * captured once at boot from bootstrap.ts and preserved across reloads so
 * re-registration doesn't silently widen the mode visibility.
 */
export async function reloadToolFile(
	sourcePath: string,
	cacheRoot: string,
	registry: ToolRegistry,
	allowedModesByName: ReadonlyMap<string, ReadonlyArray<string>>,
): Promise<ReloadResult> {
	const started = Date.now();
	const compiled = await compileTool(sourcePath, cacheRoot);
	if (compiled.kind === "error") return compiled;

	let mod: Record<string, unknown>;
	try {
		mod = (await import(pathToFileURL(compiled.outputPath).href)) as Record<string, unknown>;
	} catch (err) {
		return { kind: "error", error: `import failed: ${err instanceof Error ? err.message : String(err)}` };
	}

	const spec = findToolExport(mod);
	if (!spec) {
		return { kind: "error", error: "no export ending in 'Tool' with a valid ToolSpec shape" };
	}

	const preservedModes = allowedModesByName.get(spec.name);
	const finalSpec: ToolSpec =
		preservedModes !== undefined
			? ({ ...spec, allowedModes: preservedModes } as ToolSpec)
			: spec;
	registry.register(finalSpec);

	return { kind: "ok", name: spec.name, elapsedMs: Date.now() - started };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test tests/integration/harness-tool-reloader.test.ts`
Expected: all 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/harness/tool-reloader.ts tests/integration/harness-tool-reloader.test.ts
git commit -m "feat(harness): hot tool reloader preserving allowedModes metadata"
```

---

## Task 6: Watcher

**Files:**
- Create: `src/harness/watcher.ts`
- Create: `tests/integration/harness-watcher.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/integration/harness-watcher.test.ts`:

```ts
import { deepStrictEqual, ok } from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { watchRepo } from "../../src/harness/watcher.js";

describe("watchRepo", () => {
	let repo: string;

	beforeEach(() => {
		repo = mkdtempSync(join(tmpdir(), "clio-watch-"));
		mkdirSync(join(repo, "src"), { recursive: true });
		mkdirSync(join(repo, "src", "tools"), { recursive: true });
	});
	afterEach(() => {
		rmSync(repo, { recursive: true, force: true });
	});

	it("emits a change event for a file under src/", async () => {
		const events: { path: string }[] = [];
		const handle = watchRepo(repo, (event) => events.push({ path: event.path }));
		try {
			await delay(50);
			writeFileSync(join(repo, "src", "tools", "foo.ts"), "export const x = 1;\n");
			await delay(200);
			ok(events.some((e) => e.path.endsWith("foo.ts")), `expected a foo.ts event, got ${JSON.stringify(events)}`);
		} finally {
			handle.close();
		}
	});

	it("debounces rapid edits to the same path", async () => {
		const events: { path: string }[] = [];
		const handle = watchRepo(repo, (event) => events.push({ path: event.path }), { debounceMs: 100 });
		try {
			await delay(50);
			const target = join(repo, "src", "tools", "bar.ts");
			writeFileSync(target, "1");
			writeFileSync(target, "2");
			writeFileSync(target, "3");
			await delay(300);
			const barEvents = events.filter((e) => e.path.endsWith("bar.ts"));
			deepStrictEqual(barEvents.length, 1, `expected 1 debounced event, got ${barEvents.length}`);
		} finally {
			handle.close();
		}
	});

	it("ignores editor sidecar files", async () => {
		const events: { path: string }[] = [];
		const handle = watchRepo(repo, (event) => events.push({ path: event.path }));
		try {
			await delay(50);
			writeFileSync(join(repo, "src", "tools", ".swp"), "swap");
			writeFileSync(join(repo, "src", "tools", "baz.ts~"), "backup");
			await delay(200);
			ok(!events.some((e) => e.path.endsWith(".swp") || e.path.endsWith("~")));
		} finally {
			handle.close();
		}
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test tests/integration/harness-watcher.test.ts`
Expected: FAIL with missing module.

- [ ] **Step 3: Write minimal implementation**

Create `src/harness/watcher.ts`:

```ts
import { type FSWatcher, existsSync, watch } from "node:fs";
import { join, resolve } from "node:path";

export interface FileChangeEvent {
	path: string;
}

export interface WatchOptions {
	debounceMs?: number;
}

export interface WatchHandle {
	close(): void;
}

const DEFAULT_DEBOUNCE_MS = 50;
const ROOT_FILES = ["package.json", "package-lock.json", "tsconfig.json", "tsconfig.tests.json", "tsup.config.ts", "biome.json"];

function isSidecar(name: string): boolean {
	if (name.endsWith("~")) return true;
	if (name.endsWith(".swp") || name.endsWith(".swx") || name === "4913") return true;
	if (name.startsWith(".")) return true;
	return false;
}

/**
 * Watch src/ recursively and a small set of root config files. Emits a
 * FileChangeEvent per path after a per-path debounce window.
 */
export function watchRepo(
	repoRoot: string,
	onChange: (event: FileChangeEvent) => void,
	options: WatchOptions = {},
): WatchHandle {
	const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
	const pending = new Map<string, NodeJS.Timeout>();
	const watchers: FSWatcher[] = [];

	const fire = (absPath: string): void => {
		const existing = pending.get(absPath);
		if (existing) clearTimeout(existing);
		const timer = setTimeout(() => {
			pending.delete(absPath);
			onChange({ path: absPath });
		}, debounceMs);
		pending.set(absPath, timer);
	};

	const srcDir = join(repoRoot, "src");
	if (existsSync(srcDir)) {
		try {
			const w = watch(srcDir, { recursive: true }, (_event, filename) => {
				if (!filename) return;
				const name = filename.toString();
				const basename = name.split(/[\\/]/).pop() ?? name;
				if (isSidecar(basename)) return;
				fire(resolve(srcDir, name));
			});
			watchers.push(w);
		} catch {
			// recursive watch unsupported; caller can degrade
		}
	}

	for (const root of ROOT_FILES) {
		const p = join(repoRoot, root);
		if (!existsSync(p)) continue;
		try {
			const w = watch(p, () => fire(p));
			watchers.push(w);
		} catch {
			// ignore
		}
	}

	return {
		close(): void {
			for (const w of watchers) {
				try {
					w.close();
				} catch {
					// ignore
				}
			}
			for (const timer of pending.values()) clearTimeout(timer);
			pending.clear();
		},
	};
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test tests/integration/harness-watcher.test.ts`
Expected: all 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/harness/watcher.ts tests/integration/harness-watcher.test.ts
git commit -m "feat(harness): debounced fs.watch recursive with sidecar filtering"
```

---

## Task 7: Restart coordinator

**Files:**
- Create: `src/harness/restart.ts`
- Create: `tests/unit/harness-restart.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/harness-restart.test.ts`:

```ts
import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { buildRestartPlan } from "../../src/harness/restart.js";

describe("buildRestartPlan", () => {
	it("captures argv from index 1 onwards and injects CLIO_RESUME_SESSION_ID", () => {
		const plan = buildRestartPlan({
			execPath: "/usr/bin/node",
			argv: ["/usr/bin/node", "/app/dist/cli/index.js", "run", "foo"],
			env: { HOME: "/h", CLIO_SELF_DEV: "1" },
			sessionId: "abc-123",
		});
		strictEqual(plan.execPath, "/usr/bin/node");
		deepStrictEqual(plan.argv, ["/app/dist/cli/index.js", "run", "foo"]);
		strictEqual(plan.env.CLIO_RESUME_SESSION_ID, "abc-123");
		strictEqual(plan.env.CLIO_SELF_DEV, "1");
		strictEqual(plan.env.HOME, "/h");
	});

	it("omits CLIO_RESUME_SESSION_ID when sessionId is null", () => {
		const plan = buildRestartPlan({
			execPath: "/usr/bin/node",
			argv: ["/usr/bin/node", "/app/dist/cli/index.js"],
			env: { HOME: "/h" },
			sessionId: null,
		});
		strictEqual(plan.env.CLIO_RESUME_SESSION_ID, undefined);
	});

	it("ensures CLIO_SELF_DEV=1 is set in the respawn env", () => {
		const plan = buildRestartPlan({
			execPath: "/usr/bin/node",
			argv: ["/usr/bin/node", "/app/dist/cli/index.js"],
			env: { HOME: "/h" },
			sessionId: "s1",
		});
		strictEqual(plan.env.CLIO_SELF_DEV, "1");
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test tests/unit/harness-restart.test.ts`
Expected: FAIL with missing module.

- [ ] **Step 3: Write minimal implementation**

Create `src/harness/restart.ts`:

```ts
import { spawn } from "node:child_process";

export interface RestartPlan {
	execPath: string;
	argv: string[];
	env: NodeJS.ProcessEnv;
}

export interface RestartPlanInput {
	execPath: string;
	argv: ReadonlyArray<string>;
	env: NodeJS.ProcessEnv;
	sessionId: string | null;
}

/**
 * Pure helper that computes the spawn arguments for a self-restart. Extracted
 * from executeRestart so it can be unit-tested without spawning a child.
 */
export function buildRestartPlan(input: RestartPlanInput): RestartPlan {
	const argv = input.argv.slice(1);
	const env: NodeJS.ProcessEnv = { ...input.env, CLIO_SELF_DEV: "1" };
	if (input.sessionId) {
		env.CLIO_RESUME_SESSION_ID = input.sessionId;
	}
	return { execPath: input.execPath, argv, env };
}

export interface ExecuteRestartDeps {
	sessionId: string | null;
	shutdown: (code?: number) => Promise<void>;
}

/**
 * Spawns a detached replacement process and triggers the existing 4-phase
 * shutdown on the parent. The child inherits stdio so the TTY transitions
 * seamlessly when the parent exits.
 */
export async function executeRestart(deps: ExecuteRestartDeps): Promise<void> {
	const plan = buildRestartPlan({
		execPath: process.execPath,
		argv: process.argv,
		env: process.env,
		sessionId: deps.sessionId,
	});
	const child = spawn(plan.execPath, plan.argv, {
		stdio: "inherit",
		detached: true,
		env: plan.env,
	});
	child.unref();
	await deps.shutdown(0);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test tests/unit/harness-restart.test.ts`
Expected: all 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/harness/restart.ts tests/unit/harness-restart.test.ts
git commit -m "feat(harness): restart plan + detached respawn with session env"
```

---

## Task 8: Harness index

**Files:**
- Create: `src/harness/index.ts`
- Create: `tests/integration/harness-index.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/integration/harness-index.test.ts`:

```ts
import { ok, strictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { startHarness } from "../../src/harness/index.js";
import { createSafeBus } from "../../src/core/event-bus.js";
import type { ToolRegistry, ToolSpec } from "../../src/tools/registry.js";

function fakeRegistry(): ToolRegistry & { specs: ToolSpec[] } {
	const specs: ToolSpec[] = [];
	return {
		specs,
		register(spec: ToolSpec) {
			const idx = specs.findIndex((s) => s.name === spec.name);
			if (idx === -1) specs.push(spec);
			else specs[idx] = spec;
		},
		listAll: () => specs,
		listVisible: () => specs,
		get: (name) => specs.find((s) => s.name === name),
		listForMode: () => specs.map((s) => s.name),
		invoke: async () => ({ kind: "not_visible", reason: "stub" }),
	} as unknown as ToolRegistry & { specs: ToolSpec[] };
}

describe("startHarness", () => {
	let repo: string;
	let cache: string;

	beforeEach(() => {
		repo = mkdtempSync(join(tmpdir(), "clio-harness-"));
		mkdirSync(join(repo, "src", "tools"), { recursive: true });
		cache = mkdtempSync(join(tmpdir(), "clio-harness-cache-"));
	});
	afterEach(() => {
		rmSync(repo, { recursive: true, force: true });
		rmSync(cache, { recursive: true, force: true });
	});

	it("hot-swaps a changed tool file and updates registry + state", async () => {
		const source = join(repo, "src", "tools", "fake.ts");
		writeFileSync(
			source,
			`export const fakeTool = { name: "fake", description: "f", parameters: { type: "object", properties: {}, additionalProperties: false }, baseActionClass: "read", async run() { return { kind: "ok", output: "v1" }; } };\n`,
		);
		const registry = fakeRegistry();
		const bus = createSafeBus();
		const allowedModesByName = new Map<string, ReadonlyArray<string>>([["fake", ["default"]]]);
		const handle = startHarness({ repoRoot: repo, cacheRoot: cache, toolRegistry: registry, bus, allowedModesByName });
		try {
			await delay(100);
			writeFileSync(
				source,
				`export const fakeTool = { name: "fake", description: "f", parameters: { type: "object", properties: {}, additionalProperties: false }, baseActionClass: "read", async run() { return { kind: "ok", output: "v2" }; } };\n`,
			);
			await delay(400);
			const spec = registry.get("fake");
			ok(spec, "expected fake to be registered");
			const run = await spec?.run({});
			strictEqual(run?.kind, "ok");
			if (run?.kind === "ok") strictEqual(run.output, "v2");
			const snap = handle.state.snapshot();
			ok(snap.kind === "hot-ready" || snap.kind === "idle", `unexpected state ${snap.kind}`);
		} finally {
			handle.stop();
		}
	});

	it("sets restart-required when an engine file changes", async () => {
		mkdirSync(join(repo, "src", "engine"), { recursive: true });
		const engineFile = join(repo, "src", "engine", "agent.ts");
		writeFileSync(engineFile, "export const x = 1;\n");
		const registry = fakeRegistry();
		const bus = createSafeBus();
		const handle = startHarness({ repoRoot: repo, cacheRoot: cache, toolRegistry: registry, bus, allowedModesByName: new Map() });
		try {
			await delay(100);
			writeFileSync(engineFile, "export const x = 2;\n");
			await delay(400);
			const snap = handle.state.snapshot();
			strictEqual(snap.kind, "restart-required");
		} finally {
			handle.stop();
		}
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test tests/integration/harness-index.test.ts`
Expected: FAIL with missing module.

- [ ] **Step 3: Write minimal implementation**

Create `src/harness/index.ts`:

```ts
import { BusChannels } from "../core/bus-events.js";
import type { SafeEventBus } from "../core/event-bus.js";
import type { ToolRegistry } from "../tools/registry.js";
import { classifyChange } from "./classifier.js";
import { executeRestart } from "./restart.js";
import { HarnessState } from "./state.js";
import { reloadToolFile } from "./tool-reloader.js";
import { watchRepo } from "./watcher.js";

export interface HarnessDeps {
	repoRoot: string;
	cacheRoot: string;
	toolRegistry: ToolRegistry;
	bus: SafeEventBus;
	allowedModesByName: ReadonlyMap<string, ReadonlyArray<string>>;
	getSessionId?: () => string | null;
	shutdown?: (code?: number) => Promise<void>;
}

export interface HarnessHandle {
	state: HarnessState;
	restart(): Promise<void>;
	stop(): void;
}

/**
 * Compose watcher → classifier → reloader/restart-state for the current
 * orchestrator process. Emits bus events for every transition; callers wire
 * the state snapshot into the footer and the restart keystroke.
 */
export function startHarness(deps: HarnessDeps): HarnessHandle {
	const state = new HarnessState({ now: () => Date.now() });
	const sessionIdProvider = deps.getSessionId ?? (() => null);

	deps.bus.emit(BusChannels.HarnessWatcherStarted, { root: deps.repoRoot });

	const watch = watchRepo(deps.repoRoot, async (event) => {
		const verdict = classifyChange(event.path, deps.repoRoot);
		deps.bus.emit(BusChannels.HarnessFileChanged, { path: event.path, class: verdict.class });

		if (verdict.class === "ignore") return;
		if (verdict.class === "restart") {
			state.restartRequired(event.path, verdict.reason);
			deps.bus.emit(BusChannels.HarnessRestartRequired, { paths: [event.path], reason: verdict.reason });
			return;
		}
		if (verdict.class === "worker-next-dispatch") {
			state.workerChanged(event.path);
			return;
		}

		const result = await reloadToolFile(event.path, deps.cacheRoot, deps.toolRegistry, deps.allowedModesByName);
		if (result.kind === "ok") {
			state.hotSucceeded(event.path, result.elapsedMs);
			deps.bus.emit(BusChannels.HarnessHotreloadSucceeded, { path: event.path, elapsedMs: result.elapsedMs });
		} else {
			state.hotFailed(event.path, result.error);
			deps.bus.emit(BusChannels.HarnessHotreloadFailed, { path: event.path, error: result.error });
		}
	});

	return {
		state,
		async restart(): Promise<void> {
			const sessionId = sessionIdProvider();
			deps.bus.emit(BusChannels.HarnessRestartTriggered, { sessionId });
			if (!deps.shutdown) {
				throw new Error("harness: shutdown hook not provided; cannot restart");
			}
			await executeRestart({ sessionId, shutdown: deps.shutdown });
		},
		stop(): void {
			watch.close();
		},
	};
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test tests/integration/harness-index.test.ts`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/harness/index.ts tests/integration/harness-index.test.ts
git commit -m "feat(harness): index wires watcher+classifier+reloader+state+restart"
```

---

## Task 9: Boundary rule for src/harness/**

**Files:**
- Modify: `tests/boundaries/check-boundaries.ts`

- [ ] **Step 1: Add the new rule in check-boundaries.ts**

Edit `tests/boundaries/check-boundaries.ts`:

In `runBoundaryCheck`, after the existing `providersDomainRoot` line, add:

```ts
	const harnessRoot = path.join(srcRoot, "harness");
```

Inside the `for (const filePath of walk(srcRoot))` loop, after the existing `fromDomain` line add:

```ts
		const inHarness = isWithin(filePath, harnessRoot);
```

Inside the `evaluate` closure, after the `rule3` block, add:

```ts
			if (inHarness) {
				if (isWithin(resolved, path.join(srcRoot, "engine")) && !typeOnly) {
					violations.push(
						`rule4: ${path.relative(projectRoot, filePath)} ${kind} ${specifier} which resolves inside src/engine (harness must not import pi-mono engine)`,
					);
					return;
				}
				if (
					isWithin(resolved, domainsRoot) &&
					!typeOnly &&
					!isWithin(resolved, providersDomainRoot)
				) {
					violations.push(
						`rule4: ${path.relative(projectRoot, filePath)} ${kind} ${specifier} which resolves inside src/domains (harness may only value-import src/core, src/tools/registry.ts, and node)`,
					);
					return;
				}
				if (isWithin(resolved, path.join(srcRoot, "interactive")) && !typeOnly) {
					violations.push(
						`rule4: ${path.relative(projectRoot, filePath)} ${kind} ${specifier} which resolves inside src/interactive (harness must not reach into the TUI layer)`,
					);
					return;
				}
				if (isWithin(resolved, path.join(srcRoot, "worker")) && !typeOnly) {
					violations.push(
						`rule4: ${path.relative(projectRoot, filePath)} ${kind} ${specifier} which resolves inside src/worker (harness is orchestrator-only)`,
					);
					return;
				}
			}
```

- [ ] **Step 2: Run tests**

Run: `npm run test 2>&1 | tail -10`
Expected: `boundaries` test reports 0 violations (harness/ files only import from core/ and tools/registry). Every other test still passes.

- [ ] **Step 3: Commit**

```bash
git add tests/boundaries/check-boundaries.ts
git commit -m "test(boundaries): rule4 restricts src/harness to core + tools/registry"
```

---

## Task 10: Orchestrator integration

**Files:**
- Modify: `src/entry/orchestrator.ts`

- [ ] **Step 1: Read the current orchestrator carefully**

Run: `grep -n "startInteractive\|registerAllTools\|ensureInstalled" src/entry/orchestrator.ts`
Expected: lines showing the interactive start point and the bootstrap call.

- [ ] **Step 2: Add harness wiring**

Edit `src/entry/orchestrator.ts`:

(a) Add imports near the existing imports:

```ts
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { clioCacheDir } from "../core/xdg.js";
import { type HarnessHandle, startHarness } from "../harness/index.js";
```

(b) After `registerAllTools(toolRegistry)`, capture the mode metadata:

```ts
	const allowedModesByName = new Map<string, ReadonlyArray<string>>();
	for (const spec of toolRegistry.listAll()) {
		if (spec.allowedModes) allowedModesByName.set(spec.name, spec.allowedModes);
	}
```

(c) After `loadDomains` but before `startInteractive`, handle `CLIO_RESUME_SESSION_ID`:

```ts
	const resumeId = process.env.CLIO_RESUME_SESSION_ID?.trim();
	if (resumeId && session) {
		try {
			session.resume(resumeId);
		} catch (err) {
			process.stderr.write(
				`clio: failed to resume session ${resumeId}: ${err instanceof Error ? err.message : String(err)}\n`,
			);
		}
	}
	Reflect.deleteProperty(process.env, "CLIO_RESUME_SESSION_ID");
```

(d) Add a helper above `bootOrchestrator`:

```ts
function resolveRepoRoot(): string | null {
	try {
		const here = dirname(fileURLToPath(import.meta.url));
		let cursor = here;
		for (let i = 0; i < 8; i++) {
			if (existsSync(join(cursor, "package.json")) && existsSync(join(cursor, "src"))) {
				return cursor;
			}
			const parent = dirname(cursor);
			if (parent === cursor) break;
			cursor = parent;
		}
	} catch {
		// fall through
	}
	return null;
}
```

(e) After `createChatLoop(...)` and before `startInteractive(...)`, gate the harness:

```ts
	let harness: HarnessHandle | null = null;
	if (process.env.CLIO_SELF_DEV === "1") {
		const repoRoot = resolveRepoRoot();
		if (!repoRoot) {
			process.stderr.write("clio: CLIO_SELF_DEV=1 but no repo checkout found; hot-reload disabled.\n");
		} else {
			harness = startHarness({
				repoRoot,
				cacheRoot: clioCacheDir(),
				toolRegistry,
				bus,
				allowedModesByName,
				getSessionId: () => session?.current()?.id ?? null,
				shutdown: async (code?: number) => {
					await termination.shutdown(code ?? 0);
				},
			});
			termination.onDrain(() => {
				harness?.stop();
			});
		}
	}
```

(f) Extend the banner. Replace:

```ts
	process.stdout.write(buildBanner());
```

with:

```ts
	process.stdout.write(buildBanner());
	if (process.env.CLIO_SELF_DEV === "1") {
		process.stdout.write(`  ${chalk.magenta("CLIO_SELF_DEV=1 · hot-reload on src/tools/*.ts · watching src/")}\n`);
	}
```

(g) Pass `harness` through the `startInteractive` options. Add a new prop `harness: harness ?? undefined` to the call object. (Actual wiring in Task 11.)

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: pass.

- [ ] **Step 4: Run the full unit + integration + boundaries suite**

Run: `npm run test 2>&1 | tail -20`
Expected: all green. No behavior change unless `CLIO_SELF_DEV=1` is set.

- [ ] **Step 5: Commit**

```bash
git add src/entry/orchestrator.ts
git commit -m "feat(orchestrator): CLIO_SELF_DEV gate + CLIO_RESUME_SESSION_ID handling"
```

---

## Task 11: Footer indicator

**Files:**
- Modify: `src/interactive/footer-panel.ts`
- Modify: `src/interactive/index.ts`
- Create: `tests/unit/footer-harness.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/footer-harness.test.ts`:

```ts
import { strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { formatHarnessIndicator } from "../../src/interactive/footer-panel.js";

describe("formatHarnessIndicator", () => {
	it("returns null for idle", () => {
		strictEqual(formatHarnessIndicator({ kind: "idle" }), null);
	});
	it("formats hot-ready", () => {
		const line = formatHarnessIndicator({ kind: "hot-ready", message: "read.ts (14ms)", until: 0 });
		strictEqual(typeof line, "string");
		strictEqual((line as string).includes("read.ts"), true);
	});
	it("formats restart-required with file count", () => {
		const line = formatHarnessIndicator({
			kind: "restart-required",
			files: ["src/domains/session/manifest.ts", "src/engine/agent.ts"],
		});
		strictEqual((line as string).includes("restart"), true);
		strictEqual((line as string).includes("press R"), true);
	});
	it("formats worker-pending with count", () => {
		const line = formatHarnessIndicator({ kind: "worker-pending", count: 3 });
		strictEqual((line as string).includes("3"), true);
	});
	it("formats hot-failed with message", () => {
		const line = formatHarnessIndicator({ kind: "hot-failed", message: "edit.ts: syntax error", until: 0 });
		strictEqual((line as string).includes("edit.ts"), true);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test tests/unit/footer-harness.test.ts`
Expected: FAIL with "formatHarnessIndicator is not exported" or similar.

- [ ] **Step 3: Extend footer-panel.ts**

Edit `src/interactive/footer-panel.ts`:

Add type-only import at the top:

```ts
import type { HarnessSnapshot } from "../harness/state.js";
```

Add this export after `scopedSegment`:

```ts
const HARNESS_GLYPHS = {
	hot: "⚡",      // ⚡
	warn: "⚠",     // ⚠
	restart: "⟳",  // ⟳
	worker: "⟲",   // ⟲
} as const;

export function formatHarnessIndicator(state: HarnessSnapshot): string | null {
	if (state.kind === "idle") return null;
	if (state.kind === "hot-ready") return `${HARNESS_GLYPHS.hot} ${state.message}`;
	if (state.kind === "hot-failed") return `${HARNESS_GLYPHS.warn} ${state.message}`;
	if (state.kind === "worker-pending") {
		const plural = state.count === 1 ? "" : "s";
		return `${HARNESS_GLYPHS.worker} worker refresh on next dispatch (${state.count} file${plural})`;
	}
	const first = state.files[0];
	const extra = state.files.length > 1 ? ` +${state.files.length - 1}` : "";
	const name = first ? first.split("/").slice(-2).join("/") : "unknown";
	return `${HARNESS_GLYPHS.restart} restart required (${name}${extra}). press R`;
}
```

Update `FooterDeps` to accept an optional harness getter:

```ts
export interface FooterDeps {
	modes: ModesContract;
	providers: ProvidersContract;
	getSettings?: () => Readonly<ClioSettings>;
	getHarnessState?: () => HarnessSnapshot;
}
```

Update the `refresh` function in `buildFooter` to append the indicator line:

Replace:

```ts
			view.setText(`clio${SEP}${mode}${SEP}${targetLabel}${scopedPart}${suffix}`);
			view.invalidate();
```

with:

```ts
			let text = `clio${SEP}${mode}${SEP}${targetLabel}${scopedPart}${suffix}`;
			if (deps.getHarnessState) {
				const indicator = formatHarnessIndicator(deps.getHarnessState());
				if (indicator) text += `\n${ANSI_DIM}${indicator}${ANSI_RESET}`;
			}
			view.setText(text);
			view.invalidate();
```

- [ ] **Step 4: Run the footer test**

Run: `node --import tsx --test tests/unit/footer-harness.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire interactive/index.ts**

Edit `src/interactive/index.ts`:

Add to `InteractiveOptions` (near where `onShutdown` is declared):

```ts
	harness?: import("../harness/index.js").HarnessHandle;
```

In the footer construction (search for `buildFooter(`), add:

```ts
		...(opts.harness ? { getHarnessState: () => opts.harness!.state.snapshot() } : {}),
```

to the `deps` object passed to `buildFooter`.

Add a footer repaint timer alongside the other per-frame updates. In `startInteractive`, after the TUI is running, install:

```ts
	if (opts.harness) {
		const timer = setInterval(() => {
			footer.refresh();
		}, 500);
		timer.unref?.();
	}
```

(If `footer` is not already the identifier used for the footer panel, match the local name.)

Wire the R-key handler. Find `addInputListener` (or the existing key-routing function) and add a branch before the default fall-through:

```ts
		if (opts.harness && chat && !editor.focused) {
			const snap = opts.harness.state.snapshot();
			if (snap.kind === "restart-required" && (data === "r" || data === "R")) {
				void opts.harness.restart();
				return;
			}
		}
```

(Adjust `editor` to the real editor binding name in this file.)

- [ ] **Step 6: Hook harness from orchestrator call site**

In `src/entry/orchestrator.ts`, pass `harness` to `startInteractive`:

```ts
	await startInteractive({
		bus,
		// ... existing args
		...(harness ? { harness } : {}),
	});
```

- [ ] **Step 7: Typecheck + unit tests**

Run: `npm run typecheck && npm run test 2>&1 | tail -20`
Expected: all green.

- [ ] **Step 8: Commit**

```bash
git add src/interactive/footer-panel.ts src/interactive/index.ts src/entry/orchestrator.ts tests/unit/footer-harness.test.ts
git commit -m "feat(interactive): harness footer indicator + R-key restart binding"
```

---

## Task 12: End-to-end pty test

**Files:**
- Create: `tests/e2e/self-dev.test.ts`

- [ ] **Step 1: Write the test**

Create `tests/e2e/self-dev.test.ts`:

```ts
import { ok } from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { runCli } from "../harness/spawn.js";
import { spawnClioPty } from "../harness/pty.js";

const REPO_ROOT = new URL("../..", import.meta.url).pathname;

describe("CLIO_SELF_DEV end-to-end", () => {
	let home: string;

	beforeEach(async () => {
		home = mkdtempSync(join(tmpdir(), "clio-selfdev-e2e-"));
		await runCli(["install"], { env: { CLIO_HOME: home } });
	});
	afterEach(() => {
		rmSync(home, { recursive: true, force: true });
	});

	it("banner shows CLIO_SELF_DEV line and footer flips to restart-required on engine edit", async () => {
		const readToolPath = join(REPO_ROOT, "src", "tools", "read.ts");
		const original = readFileSync(readToolPath, "utf8");
		const pty = spawnClioPty({
			env: { CLIO_HOME: home, CLIO_SELF_DEV: "1" },
		});
		try {
			await pty.expect(/CLIO_SELF_DEV=1/, 8000);
			await pty.expect(/clio\s+IOWarp/, 8000);
			// touch read.ts (safe: change only a comment)
			const patched = original.replace(
				"export const readTool",
				"/* hot-reload smoke test */\nexport const readTool",
			);
			writeFileSync(readToolPath, patched);
			await pty.expect(/read\.ts/, 5000);
			// Now trigger a restart prompt via an engine-boundary file.
			const sessionTouch = join(REPO_ROOT, "src", "engine", "types.ts");
			const engineOriginal = readFileSync(sessionTouch, "utf8");
			try {
				writeFileSync(sessionTouch, `${engineOriginal}\n// hot-reload smoke test\n`);
				await pty.expect(/restart required/, 5000);
			} finally {
				writeFileSync(sessionTouch, engineOriginal);
			}
			ok(true);
		} finally {
			pty.kill();
			writeFileSync(readToolPath, original);
		}
	});
});
```

- [ ] **Step 2: Run the e2e**

Run: `npm run test:e2e 2>&1 | tail -20`
Expected: build runs, new test passes. (`test:e2e` rebuilds `dist/` first; the harness picks up the freshly built code.)

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/self-dev.test.ts
git commit -m "test(e2e): CLIO_SELF_DEV banner + hot-reload + restart-required footer"
```

---

## Task 13: Full CI green + manual verification

**Files:**
- None (verification only)

- [ ] **Step 1: Full CI locally**

Run: `npm run ci`
Expected: typecheck, lint, unit+integration+boundaries, build, e2e all green.

- [ ] **Step 2: Manual smoke (document the run)**

From the repo root:

```bash
npm run build
npm link
CLIO_SELF_DEV=1 clio
```

- Banner should include `CLIO_SELF_DEV=1 · hot-reload on src/tools/*.ts · watching src/`.
- In another shell, `echo "// smoke" >> src/tools/read.ts`. Footer should flash `⚡ read.ts (<n>ms)` within ~500ms, then idle.
- Ask Clio to read a file; tool result should be normal.
- In another shell, `echo "// smoke" >> src/domains/session/manifest.ts`. Footer flips to `⟳ restart required (session/manifest.ts). press R`.
- Press `R` in the TUI. Banner reappears. `/tree` shows the same session.
- Revert the two appended comments.

- [ ] **Step 3: Commit a short verification note (only if the manual run changed anything tracked)**

If no tracked file changed during the manual run, skip. Otherwise:

```bash
git add <only-modified-intentional-files>
git commit -m "docs(harness): manual verification note"
```

---

## Self-review

**Spec coverage.** Walking the spec:

- §2 goal (hot-swap tools / restart prompt / ignore) → Tasks 2 (classifier), 5 (reloader), 8 (index), 11 (footer + R-key).
- §3 constraint: three invariants → Task 9 (boundary rule) + no engine imports in harness.
- §3 constraint: esbuild only new dep → Task 0.
- §3 constraint: `CLIO_SELF_DEV=1` gate → Task 10.
- §3 constraint: workers remain subprocess → classifier returns `worker-next-dispatch` (Task 2); reloader never runs on worker files.
- §3 constraint: session resume via env var → Task 10 step 2(c).
- §4 matrix → Task 2 test cases.
- §5 module layout → Tasks 2–8 create each file.
- §6.1 boot path → Task 10.
- §6.2 watcher → Task 6.
- §6.3 classifier → Task 2.
- §6.4 hot-swap pipeline → Tasks 4, 5, 8.
- §6.5 restart path → Task 7, Task 10 (banner), Task 11 (R-key).
- §6.6 worker-next-dispatch → Task 8 handler.
- §7 bus contract → Task 1.
- §8.1 footer indicator → Task 11.
- §8.2 restart keystroke → Task 11 step 5.
- §8.3 banner message → Task 10 step 2(f).
- §9 error handling → caught inside compileTool / reloadToolFile / startHarness; tests in Tasks 4/5/8.
- §10 testing → Tasks 2, 3, 5, 6, 7, 8, 11, 12.
- §11 risks → acceptable; fs.watch failure is try/caught in Task 6; memory drift counter deferred (§12 out-of-scope).
- §12 out-of-scope → no tasks for those; correct.
- §13 success criterion → Task 13 step 2.

**Placeholder scan.** No TBDs. Every code step shows the exact code. All exact test assertions. All commit messages provided.

**Type consistency.** `ToolSpec`, `ToolRegistry`, `HarnessHandle`, `HarnessState`, `HarnessSnapshot`, `ChangeClass`, `ClassifyResult`, `CompileResult`, `ReloadResult`, `RestartPlan` names are consistent across tasks. `formatHarnessIndicator` signature is stable (takes `HarnessSnapshot`, returns `string | null`).

**One gap found and fixed:** initial plan did not capture `allowedModes` preservation across reloads. Added to Task 5 implementation and Task 10 step 2(b) (capture at boot via `toolRegistry.listAll()`).

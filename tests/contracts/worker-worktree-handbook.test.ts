import { deepEqual, deepStrictEqual, equal, ok, rejects } from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import type { DomainName } from "../../src/core/domain-loader.js";
import { createTelemetryHub } from "../../src/core/telemetry/hub.js";
import { captureProjectSurface, recordProjectSurfaceTrust } from "../../src/core/workspace-trust.js";
import { refreshCompiledHandbook, renderEffectivePromptContext } from "../../src/domains/context/compiled-handbook.js";
import type { ContextContract, StartupHint } from "../../src/domains/context/contract.js";
import { createContextBundle, type StartupHintHost } from "../../src/domains/context/extension.js";
import { HANDBOOK_ABSENT_FRAGMENT, renderPromptContext } from "../../src/domains/context/prompt-context.js";
import {
	refreshSisterRepositoryRules,
	sisterRepositoryRules,
	stopSisterRepositoryRefreshes,
} from "../../src/domains/context/sister-repository.js";
import { createMiddlewareBundle } from "../../src/domains/middleware/extension.js";
import { createSisterRepositoryReminderRegistration } from "../../src/domains/middleware/sister-repository-reminder.js";
import codexCliRuntime from "../../src/domains/providers/runtimes/codex/codex-cli.js";
import { dispatchRequestsFromArgs, prepareDispatchArguments } from "../../src/tools/dispatch-arguments.js";
import { makeDispatchBundle } from "../harness/dispatch.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

// Repositories often keep CLIO-CODER.md out of git. A `worktree: true` task
// checks out the committed tree, so the handbook was absent there, and the
// handbook walk stops at the worktree's own `.git` file: coders dispatched into
// task worktrees received no project rules at all.
const handbook = [
	"# Fixture",
	"",
	"## Hard invariants",
	"",
	"1. Never write `src/generated/**` by hand; `scripts/gen.sh` owns it.",
	"",
].join("\n");

test("a worker in a task worktree receives the source checkout's untracked handbook", async () => {
	const env = await isolateClioEnv("clio-coder-worktree-handbook-");
	const repo = join(env.dir, "repo");
	mkdirSync(join(repo, "src"), { recursive: true });
	const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
	git("init", "-q", "-b", "main");
	git("config", "user.email", "fixture@example.invalid");
	git("config", "user.name", "Fixture");
	writeFileSync(join(repo, ".gitignore"), "CLIO-CODER.md\n.clio-coder/\n");
	writeFileSync(join(repo, "src", "index.ts"), "export const x = 1;\n");
	git("add", "-A");
	git("commit", "-qm", "fixture");
	writeFileSync(join(repo, "CLIO-CODER.md"), handbook);

	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.fleet.retry.maxRetries = 0;
	const base = dispatchStubContext({ settings });
	let delivered: ReadonlyArray<{ body: string }> = [];
	let workerCwd = "";
	const context: Pick<ContextContract, "renderPromptContext"> = {
		renderPromptContext: (cwd) => renderPromptContext(cwd),
	};
	const bundle = makeDispatchBundle(
		{
			bus: base.bus,
			getContract: ((name: DomainName) =>
				name === "context" ? context : base.getContract(name)) as typeof base.getContract,
		},
		{
			spawnWorker(spec, opts) {
				delivered = spec.dynamicPromptMessages ?? [];
				workerCwd = opts?.cwd ?? "";
				throw new Error("captured prompt");
			},
		},
	);
	// A session runs from its repository's root.
	const previous = process.cwd();
	process.chdir(repo);
	try {
		await bundle.extension.start();
		await rejects(
			bundle.contract.dispatch({
				agentId: "coder",
				task: "Edit src/index.ts.",
				executionRole: "builder",
				requestOrigin: "internal",
				cwd: repo,
				worktree: true,
			}),
			/captured prompt/,
		);
		ok(workerCwd.length > 0 && workerCwd !== repo, `worker ran in ${workerCwd}`);
		ok(
			delivered.some(({ body }) => body.includes("`scripts/gen.sh` owns it")),
			JSON.stringify(delivered.map(({ body }) => body.slice(0, 200))),
		);
	} finally {
		process.chdir(previous);
		await bundle.extension.stop?.();
		env.restore();
	}
});

// A repository with no CLIO-CODER.md still has rules a tool can check: what its
// checkers fail on and what other harnesses' handbooks state about files that
// exist. Every tier gets those, compiled without a model, instead of nothing.
const checker = [
	"export function checkImports(file, source) {",
	"\tconst out = [];",
	`\tif (/from "\\.\\.\\/ui\\//.test(source)) out.push(\`rule1: ${"$"}{file} imports src/ui from src/core; the core never depends on the user interface.\`);`,
	"\treturn out;",
	"}",
	"",
].join("\n");
const agents = [
	"# Agents",
	"",
	"- Run `tests/boundaries/check-imports.mjs` after every change to `src/core/`.",
	"- Never edit `src/legacy/old-api.ts` by hand.",
	"",
].join("\n");

function fixtureRepo(dir: string, files: Record<string, string>): string {
	const repo = join(dir, "repo");
	mkdirSync(repo, { recursive: true });
	const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
	git("init", "-q", "-b", "main");
	git("config", "user.email", "fixture@example.invalid");
	git("config", "user.name", "Fixture");
	for (const [path, content] of Object.entries(files)) {
		mkdirSync(join(repo, path, ".."), { recursive: true });
		writeFileSync(join(repo, path), content);
	}
	git("add", "-A");
	git("commit", "-qm", "fixture");
	return repo;
}

function untracked(repo: string): string[] {
	return execFileSync("git", ["-C", repo, "status", "--porcelain", "--ignored", "--untracked-files=all"], {
		encoding: "utf8",
	})
		.split("\n")
		.filter(Boolean)
		.map((line) => line.slice(3));
}

async function capturedWorkerContext(repo: string, peer: boolean, worktree = false): Promise<string> {
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.fleet.retry.maxRetries = 0;
	if (peer) {
		settings.targets = [
			{ id: "codex-test", runtime: "codex-cli", defaultModel: "codex-cli-default", trustedUnmediated: true },
		];
		settings.fleet.default.target = "codex-test";
		settings.fleet.default.model = "codex-cli-default";
	}
	const base = dispatchStubContext({ settings, ...(peer ? { runtime: codexCliRuntime } : {}) });
	let delivered: ReadonlyArray<{ body: string }> = [];
	let runtime = "";
	const context: Pick<ContextContract, "renderPromptContext"> = { renderPromptContext: renderEffectivePromptContext };
	const bundle = makeDispatchBundle(
		{
			bus: base.bus,
			getContract: ((name: DomainName) =>
				name === "context" ? context : base.getContract(name)) as typeof base.getContract,
		},
		{
			spawnWorker(spec) {
				delivered = spec.dynamicPromptMessages ?? [];
				runtime = spec.runtimeId ?? "";
				throw new Error("captured prompt");
			},
		},
	);
	// A session runs from its repository's root.
	const previous = process.cwd();
	process.chdir(repo);
	try {
		await bundle.extension.start();
		await rejects(
			bundle.contract.dispatch({
				agentId: "coder",
				task: "Edit src/core/index.ts.",
				executionRole: "builder",
				requestOrigin: "internal",
				cwd: repo,
				...(worktree ? { worktree: true } : {}),
			}),
			/captured prompt/,
		);
	} finally {
		process.chdir(previous);
		await bundle.extension.stop?.();
	}
	equal(runtime, peer ? "codex-cli" : "openai");
	return delivered.map(({ body }) => body).join("\n\n");
}

/** The hints a session starting in `repo` shows; the handbook compile it starts has landed when this returns. */
async function sessionStartHints(repo: string, host: StartupHintHost): Promise<StartupHint[]> {
	const bus = createTelemetryHub();
	const context = createContextBundle({ bus, getContract: () => undefined }, { startupHintHost: host });
	const previous = process.cwd();
	await context.extension.start();
	try {
		process.chdir(repo);
		bus.emit("session.started", { at: Date.now() });
		const hints = context.contract.startupHints();
		await refreshCompiledHandbook(repo);
		return hints;
	} finally {
		process.chdir(previous);
		await context.extension.stop?.();
	}
}

const attended: StartupHintHost = { initCommand: "clio-coder context init", suggest: true };

test("a repository without a handbook gets one compiled off the prompt path from its checkers and verified rules", async () => {
	const env = await isolateClioEnv("clio-coder-compiled-handbook-");
	try {
		const repo = fixtureRepo(env.dir, {
			"package.json": `${JSON.stringify({ name: "fixture", scripts: { test: "node --test" } })}\n`,
			"tests/boundaries/check-imports.mjs": checker,
			"src/core/index.ts": "export const core = 1;\n",
			"src/ui/view.ts": "export const view = 1;\n",
			"AGENTS.md": agents,
		});
		// The prompt and dispatch paths read the cache and never list or compile the tree themselves.
		const cold = renderEffectivePromptContext(repo);
		equal(cold.compiledHandbook, undefined);
		ok(cold.text.includes(HANDBOOK_ABSENT_FRAGMENT), cold.text);
		deepStrictEqual(untracked(repo), []);

		// A session start compiles in the background; that session still runs as one without a handbook.
		const first = await sessionStartHints(repo, attended);
		ok(!first.some(({ text }) => text.includes("No project handbook")), JSON.stringify(first));

		const main = renderEffectivePromptContext(repo);
		ok(main.compiledHandbook, main.text);
		ok(main.text.includes("no CLIO-CODER.md in this repository"), main.text);
		ok(!main.text.includes("Every rule in it was checked"), main.text);
		ok(main.text.includes("Checked as `rule1` by `tests/boundaries/check-imports.mjs`"), main.text);
		ok(main.text.includes("after every change to `src/core/`"), main.text);
		ok(!main.text.includes("old-api"), "a rule citing a missing file is not compiled");
		ok(!main.text.includes(HANDBOOK_ABSENT_FRAGMENT));
		deepStrictEqual(main.handbookFiles, []);
		deepStrictEqual(main.compiledHandbook.sources, ["AGENTS.md", "tests/boundaries/check-imports.mjs"]);

		for (const peer of [false, true]) {
			const worker = await capturedWorkerContext(repo, peer);
			ok(worker.includes("Checked as `rule1`"), `${peer ? "peer" : "native"}: ${worker}`);
		}
		// A fresh task worktree has no compile of its own; the source checkout's stands in.
		const inWorktree = await capturedWorkerContext(repo, false, true);
		ok(inWorktree.includes("Checked as `rule1`"), `worktree: ${inWorktree}`);

		const hints = await sessionStartHints(repo, attended);
		ok(
			hints.some(({ text }) =>
				text.includes(
					`No project handbook; using ${main.compiledHandbook?.rules} rules compiled from AGENTS.md, tests/boundaries/check-imports.mjs. Run clio-coder context init to write one.`,
				),
			),
			JSON.stringify(hints),
		);
		const unattended = await sessionStartHints(repo, { initCommand: "x", suggest: false });
		ok(!unattended.some(({ text }) => text.includes("No project handbook")), JSON.stringify(unattended));

		// An edited input retires the cache until the next compile, which picks the edit up.
		writeFileSync(join(repo, "AGENTS.md"), `${agents}- Keep \`src/ui/\` free of state; see \`src/ui/view.ts\`.\n`);
		equal(renderEffectivePromptContext(repo).compiledHandbook, undefined);
		await refreshCompiledHandbook(repo);
		const edited = renderEffectivePromptContext(repo);
		ok(edited.text.includes("Keep `src/ui/` free of state"), edited.text);
		ok(readFileSync(join(repo, ".clio-coder", ".gitignore"), "utf8").includes("/*"));
		const written = untracked(repo).filter((path) => path !== "AGENTS.md");
		ok(
			written.every((path) => path.startsWith(".clio-coder/")),
			JSON.stringify(written),
		);
	} finally {
		env.restore();
	}
});

test("an empty repository compiles no handbook and says nothing about one", async () => {
	const env = await isolateClioEnv("clio-coder-compiled-handbook-empty-");
	try {
		const repo = fixtureRepo(env.dir, { "README.md": "# Fixture\n" });
		await refreshCompiledHandbook(repo);
		const main = renderEffectivePromptContext(repo);
		equal(main.compiledHandbook, undefined);
		ok(main.text.includes(HANDBOOK_ABSENT_FRAGMENT));
		deepStrictEqual(untracked(repo), []);
		const hints = await sessionStartHints(repo, attended);
		ok(!hints.some(({ text }) => text.includes("No project handbook")), JSON.stringify(hints));
	} finally {
		env.restore();
	}
});

// Work in a sister repository follows that repository's rules: a run is keyed
// by the repository that owns its files, never by where the session started.
function fixtureRepository(root: string, name: string, script: string, extra: ReadonlyArray<string> = []): void {
	mkdirSync(join(root, "src", "generated"), { recursive: true });
	mkdirSync(join(root, "scripts"), { recursive: true });
	const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
	git("init", "-q", "-b", "main");
	git("config", "user.email", "fixture@example.invalid");
	git("config", "user.name", "Fixture");
	writeFileSync(join(root, "package.json"), `${JSON.stringify({ name, scripts: { [script]: "node --test" } })}\n`);
	writeFileSync(join(root, "scripts", "gen.sh"), "#!/bin/sh\n");
	writeFileSync(join(root, "src", "generated", "index.ts"), "export const generated = 1;\n");
	writeFileSync(join(root, "src", "index.ts"), "export const x = 1;\n");
	writeFileSync(
		join(root, "CLIO-CODER.md"),
		[
			`# ${name}`,
			"",
			"## Hard invariants",
			"",
			`1. Never write \`src/generated/\` by hand in ${name}; \`scripts/gen.sh\` owns it.`,
			"",
			"## Testing",
			"",
			`- Run the suite with \`npm run ${script}\`.`,
			...extra,
			"",
		].join("\n"),
	);
	git("add", "-A");
	git("commit", "-qm", "fixture");
}

function treeListing(root: string): string[] {
	return execFileSync("git", ["-C", root, "status", "--porcelain", "--ignored", "--untracked-files=all"], {
		encoding: "utf8",
	})
		.split("\n")
		.filter(Boolean)
		.sort();
}

/** A dispatch bundle that captures a read-only scout's prompt and the scope notices it raises. */
function scoutHarness() {
	const base = dispatchStubContext({ settings: structuredClone(DEFAULT_SETTINGS) });
	const notices: Array<{ code: string; message: string }> = [];
	const unsubscribe = base.bus.subscribe("run.scope_notice_raised", (notice) => {
		notices.push(notice as { code: string; message: string });
	});
	let delivered: ReadonlyArray<{ body: string }> = [];
	const context: Pick<ContextContract, "renderPromptContext"> = {
		renderPromptContext: (cwd) => renderPromptContext(cwd),
	};
	const bundle = makeDispatchBundle(
		{
			bus: base.bus,
			getContract: ((name: DomainName) =>
				name === "context" ? context : base.getContract(name)) as typeof base.getContract,
		},
		{
			spawnWorker(spec) {
				delivered = spec.dynamicPromptMessages ?? [];
				throw new Error("captured prompt");
			},
		},
	);
	/** A builder's prompt for a `worktree: true` task at `dir`. */
	const builder = async (dir: string, runId: string): Promise<string> => {
		delivered = [];
		await rejects(
			bundle.contract.dispatch({
				agentId: "coder",
				task: "Edit src/index.ts.",
				executionRole: "builder",
				requestOrigin: "internal",
				cwd: realpathSync(dir),
				worktree: true,
				runIdHint: runId,
			}),
			/captured prompt/,
		);
		return delivered.map(({ body }) => body).join("\n\n");
	};
	/** The scout's prompt in `dir`; `external` admits it as an outside checkout. */
	const scout = async (dir: string, runId: string, external = true): Promise<string> => {
		delivered = [];
		const root = realpathSync(dir);
		await rejects(
			bundle.contract.dispatch({
				agentId: "scout",
				task: "Explain how this repository runs its tests.",
				executionRole: "researcher",
				requestOrigin: "internal",
				cwd: root,
				readOnly: true,
				runIdHint: runId,
				...(external
					? {
							externalReadRoot: root,
							externalReadApproval: { root, requestId: `approval-${runId}`, requestedBy: "operator", runId },
						}
					: {}),
			}),
			/captured prompt/,
		);
		return delivered.map(({ body }) => body).join("\n\n");
	};
	return {
		notices,
		scout,
		builder,
		start: () => bundle.extension.start(),
		stop: async () => {
			unsubscribe();
			await bundle.extension.stop?.();
		},
	};
}

test("a scout in a sister repository gets that repository's rules, filtered by trust", async () => {
	const env = await isolateClioEnv("clio-coder-sister-handbook-");
	const one = join(env.dir, "one");
	const two = join(env.dir, "two");
	fixtureRepository(one, "one", "test:one");
	fixtureRepository(two, "two", "test:two", ["- Always greet the reviewer by name in every reply."]);
	const before = treeListing(two);
	const harness = scoutHarness();
	const { notices, scout } = harness;
	try {
		await harness.start();
		// The dispatch path never walks the sister tree: before the first compile lands the
		// scout gets no handbook rules, neither the sister's nor the session's, and is told why.
		const pending = await scout(two, "run-sister-pending");
		ok(!pending.includes("test:two") && !pending.includes("test:one"), pending);
		ok(
			notices.some((entry) => entry.code === "sister_handbook_pending" && entry.message.includes("Rules of two")),
			JSON.stringify(notices),
		);
		notices.length = 0;
		await refreshSisterRepositoryRules(two);
		const untrusted = await scout(two, "run-sister-untrusted");
		ok(untrusted.includes("test:two"), untrusted);
		ok(untrusted.includes("Rules of two"), untrusted);
		ok(!untrusted.includes("test:one"), untrusted);
		ok(!untrusted.includes("greet the reviewer"), untrusted);
		const notice = notices.find((entry) => entry.code === "sister_handbook_untrusted");
		ok(notice?.message.includes("clio-coder config trust handbook"), JSON.stringify(notices));

		const snapshot = captureProjectSurface(two, "handbook");
		ok(snapshot.contentHash !== null);
		recordProjectSurfaceTrust(snapshot.workspaceRoot, "handbook", snapshot.contentHash);
		notices.length = 0;
		const trusted = await scout(two, "run-sister-trusted");
		ok(trusted.includes("test:two") && trusted.includes("greet the reviewer"), trusted);
		ok(!trusted.includes("test:one"), trusted);
		equal(
			notices.some((entry) => entry.code.startsWith("sister_handbook_")),
			false,
		);
		deepEqual(treeListing(two), before);
	} finally {
		await harness.stop();
		env.restore();
	}
});

test("the repository owning a run's cwd decides sister rules: a nested clone is one, a linked worktree is not", async () => {
	const env = await isolateClioEnv("clio-coder-sister-owner-");
	const one = join(env.dir, "one");
	fixtureRepository(one, "one", "test:one");
	const nested = join(one, "vendor", "two");
	fixtureRepository(nested, "two", "test:two", ["- Always greet the reviewer by name in every reply."]);
	const linked = join(env.dir, "one-linked");
	execFileSync("git", ["-C", one, "worktree", "add", "-q", linked], { encoding: "utf8" });
	const harness = scoutHarness();
	const previous = process.cwd();
	process.chdir(one);
	try {
		await harness.start();
		await refreshSisterRepositoryRules(nested);
		const inside = await harness.scout(nested, "run-nested", false);
		ok(inside.includes("Rules of two") && inside.includes("test:two"), inside);
		ok(!inside.includes("test:one"), inside);
		ok(!inside.includes("greet the reviewer"), inside);
		// A task worktree of the nested clone belongs to the nested clone, so it is a sister too.
		harness.notices.length = 0;
		const nestedTask = await harness.builder(nested, "run-nested-worktree");
		ok(!nestedTask.includes("greet the reviewer") && !nestedTask.includes("test:one"), nestedTask);
		ok(
			harness.notices.some((entry) => entry.code.startsWith("sister_handbook_")),
			JSON.stringify(harness.notices),
		);
		harness.notices.length = 0;
		const worktree = await harness.scout(linked, "run-linked");
		ok(!worktree.includes("Rules of"), worktree);
		equal(
			harness.notices.some((entry) => entry.code.startsWith("sister_handbook_")),
			false,
			JSON.stringify(harness.notices),
		);
	} finally {
		process.chdir(previous);
		await harness.stop();
		env.restore();
	}
});

test("a sister compile is shared by every directory of the repository and stops with the session", async () => {
	const env = await isolateClioEnv("clio-coder-sister-shared-");
	try {
		const two = join(env.dir, "two");
		fixtureRepository(two, "two", "test:two");
		// A stop cuts the running refresh off; nothing is cached and the next read starts again.
		const cut = refreshSisterRepositoryRules(two);
		await stopSisterRepositoryRefreshes();
		await rejects(cut, /stopped/);
		equal(sisterRepositoryRules(two)?.rules, null);
		await refreshSisterRepositoryRules(two);
		// A dispatch from a subdirectory reads the compile its root's refresh left.
		ok(sisterRepositoryRules(join(two, "src"))?.rules?.sources.some(({ source }) => source.includes("test:two")));
	} finally {
		await stopSisterRepositoryRefreshes();
		env.restore();
	}
});

test("a task whose paths span two repositories is refused with the split instruction", async () => {
	const env = await isolateClioEnv("clio-coder-sister-span-");
	try {
		fixtureRepository(join(env.dir, "one"), "one", "test:one");
		fixtureRepository(join(env.dir, "two"), "two", "test:two");
		const parsed = dispatchRequestsFromArgs(
			prepareDispatchArguments({
				agent: "coder",
				task: "Align the two packages.",
				intent: { relevant_paths: ["one/src/index.ts", "two/src/index.ts"] },
			}),
			{
				workspaceRoot: env.dir,
				auto: { approvedAuthorities: ["read-only"], authorityBasis: "yolo-policy" },
				resolveIntent: () => ({ ok: false, message: "intent resolver reached" }),
			},
		);
		equal(parsed.ok, false);
		const message = parsed.ok ? "" : parsed.message;
		ok(message.includes("Use one repository per task; all declared paths must stay inside it."), message);
		ok(message.includes("dispatch one task per repository"), message);
	} finally {
		env.restore();
	}
});

test("the main session reading a sister repository gets its invariants once, labeled", async () => {
	const env = await isolateClioEnv("clio-coder-sister-reminder-");
	try {
		const one = join(env.dir, "one");
		const two = join(env.dir, "two");
		fixtureRepository(one, "one", "test:one");
		fixtureRepository(two, "two", "test:two");
		const before = treeListing(two);
		const registration = createSisterRepositoryReminderRegistration({ getCwd: () => one });
		const read = (path: string, sessionId = "s1") =>
			registration.evaluate({ hook: "after_tool", sessionId, toolName: "read", toolArgs: { path } }, { priorEffects: [] });
		deepEqual(read(join(one, "src", "index.ts")), []);
		// The tool-result path only reads the cached compile: the first touch starts it and appends nothing.
		deepEqual(read(join(two, "src", "index.ts")), []);
		await refreshSisterRepositoryRules(two);
		const first = read(join(two, "src", "index.ts"));
		equal(first.length, 1);
		const effect = first[0];
		ok(effect?.kind === "annotate_tool_result");
		ok(effect.message.startsWith("Rules of two, compiled from CLIO-CODER.md"), effect.message);
		ok(effect.message.includes("`scripts/gen.sh` owns it"), effect.message);
		ok(!effect.message.includes("in one;"), effect.message);
		ok(effect.message.length <= 1500, String(effect.message.length));
		deepEqual(read(join(two, "package.json")), []);
		// Each session gets the reminder once.
		equal(read(join(two, "package.json"), "s2").length, 1);
		deepEqual(treeListing(two), before);
		// The session's middleware carries the reminder with no composition-root wiring.
		const wired = createMiddlewareBundle().contract.runHook({
			hook: "after_tool",
			toolName: "read",
			toolArgs: { path: join(two, "src", "index.ts") },
		});
		ok(
			wired.effects.some((entry) => entry.kind === "annotate_tool_result" && entry.message.startsWith("Rules of two")),
			JSON.stringify(wired.effects),
		);
		// A new commit is compiled in the background: the stale invariant leaves the compile.
		execFileSync("git", ["-C", two, "rm", "-q", "scripts/gen.sh"]);
		execFileSync("git", ["-C", two, "-c", "commit.gpgsign=false", "commit", "-qm", "drop gen"]);
		const recompiled = await refreshSisterRepositoryRules(two);
		ok(
			recompiled !== null && !recompiled.sources.some(({ source }) => source.includes("scripts/gen.sh")),
			JSON.stringify(recompiled),
		);
		deepEqual(read(join(two, "src", "index.ts"), "s3"), []);
	} finally {
		env.restore();
	}
});

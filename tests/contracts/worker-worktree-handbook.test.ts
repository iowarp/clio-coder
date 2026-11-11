import { deepStrictEqual, equal, ok, rejects } from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import type { DomainName } from "../../src/core/domain-loader.js";
import { createTelemetryHub } from "../../src/core/telemetry/hub.js";
import { refreshCompiledHandbook, renderEffectivePromptContext } from "../../src/domains/context/compiled-handbook.js";
import type { ContextContract, StartupHint } from "../../src/domains/context/contract.js";
import { createContextBundle, type StartupHintHost } from "../../src/domains/context/extension.js";
import { HANDBOOK_ABSENT_FRAGMENT, renderPromptContext } from "../../src/domains/context/prompt-context.js";
import codexCliRuntime from "../../src/domains/providers/runtimes/codex/codex-cli.js";
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
					`No project handbook; using ${main.compiledHandbook?.rules} verified rules compiled from AGENTS.md, tests/boundaries/check-imports.mjs. Run clio-coder context init to write one.`,
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

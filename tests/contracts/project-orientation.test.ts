import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fallbackBootstrapOutput, runBootstrap } from "../../src/domains/context/bootstrap.js";
import { runContextClear } from "../../src/domains/context/clear.js";
import {
	codemapPath,
	codewikiPath,
	legacyCodewikiPath,
	readCodewiki,
} from "../../src/domains/context/codewiki/artifact.js";
import { coordinateCodewikiWrite } from "../../src/domains/context/codewiki/coordinator.js";
import { buildProjectOrientation } from "../../src/domains/context/orientation.js";
import { readProjectStatus } from "../../src/domains/context/project-status.js";
import { renderPromptContext } from "../../src/domains/context/prompt-context.js";
import { readClioState, writeClioState } from "../../src/domains/context/state.js";
import { runWikiGenerate } from "../../src/domains/context/wiki/generate.js";
import { writeWikiMeta } from "../../src/domains/context/wiki/meta.js";
import { buildDynamicPromptMessages } from "../../src/domains/dispatch/extension.js";
import { codeNavTool } from "../../src/tools/codewiki/code-nav.js";
import { loadCodewikiForTool } from "../../src/tools/codewiki/shared.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

async function index(cwd: string) {
	const result = await coordinateCodewikiWrite(cwd, () => ({ kind: "build", cwd, language: "typescript" }), {
		afterCommit: ({ codewiki, fingerprint }, root) =>
			writeClioState(root, { version: 1, fingerprint, projectType: codewiki.language }, codewiki),
	});
	ok(result);
	return result;
}

test("preset commands preserve literal shell arguments and omit overlong names", {
	skip: process.platform === "win32",
}, async () => {
	const env = await isolateClioEnv("clio-preset-literals-");
	try {
		const names = ["release  local $CLIO_PRESET `printf expanded` $(printf substituted) 'quote'", "x".repeat(81)];
		writeFileSync(
			join(env.dir, "CMakePresets.json"),
			JSON.stringify({ configurePresets: names.map((name) => ({ name })) }),
		);
		const result = await index(env.dir);
		const orientation = buildProjectOrientation(env.dir, result.codewiki, result.worker.fingerprint);
		strictEqual(orientation.commands.length, 1);
		const command = orientation.commands[0]?.command;
		ok(command);
		const args = execFileSync("sh", ["-c", `cmake() { printf '%s\\n' "$@"; }; ${command}`], { encoding: "utf8" });
		strictEqual(args, `--preset\n${names[0]}\n`);
	} finally {
		env.restore();
	}
});

test("CMake orientation ignores commented and quoted example declarations", async () => {
	const env = await isolateClioEnv("clio-cmake-declaration-");
	try {
		writeFileSync(
			join(env.dir, "CMakeLists.txt"),
			[
				'# project(line_example DESCRIPTION "Example only")',
				'#[=[\nproject(bracket_example DESCRIPTION "Example only")\n]=]',
				'set(EXAMPLE "\nproject(quoted_example DESCRIPTION \\"Example only\\")\n")',
				'project(actual DESCRIPTION "Real solver")',
			].join("\n"),
		);
		await index(env.dir);
		strictEqual(readClioState(env.dir)?.orientation?.identity?.name, "actual");
		strictEqual(readClioState(env.dir)?.orientation?.identity?.purpose, "Real solver");
	} finally {
		env.restore();
	}
});

test("project status counts and bounds whole Git rename records", async () => {
	const env = await isolateClioEnv("clio-status-renames-");
	try {
		const git = (...args: string[]) => execFileSync("git", args, { cwd: env.dir, encoding: "utf8" });
		git("init", "-q");
		for (let i = 0; i < 25; i++) writeFileSync(join(env.dir, `before-${i}.txt`), `unique ${i}\n`);
		git("add", ".");
		git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture");
		for (let i = 0; i < 25; i++) git("mv", `before-${i}.txt`, `after-${i}.txt`);
		const status = (await readProjectStatus(env.dir)).git as {
			statusRecords: number;
			statusTruncated: boolean;
			porcelain: string[];
		};
		strictEqual(status.statusRecords, 25);
		strictEqual(status.statusTruncated, true);
		strictEqual(status.porcelain.length, 24);
		ok(
			status.porcelain.every(
				(entry) => entry.startsWith("R  after-") && /^before-\d+\.txt$/.test(entry.split("\0")[1] ?? ""),
			),
		);
	} finally {
		env.restore();
	}
});

test("project retrieval retains independent evidence when source indexing fails", {
	skip: process.platform === "win32",
}, async () => {
	const env = await isolateClioEnv("clio-status-index-failure-");
	const previous = process.cwd();
	const source = join(env.dir, "a.ts");
	try {
		execFileSync("git", ["init", "-q"], { cwd: env.dir });
		writeFileSync(source, "export const value = 1;\n");
		execFileSync("git", ["add", "a.ts"], { cwd: env.dir });
		execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture"], {
			cwd: env.dir,
		});
		await index(env.dir);
		mkdirSync(join(env.dir, ".clio-coder"), { recursive: true });
		writeFileSync(
			join(env.dir, ".clio-coder/user-tasks.json"),
			JSON.stringify({
				version: 1,
				nextId: 2,
				tasks: [{ id: "u1", title: "Inspect source", status: "open", createdAt: "2026-09-26", updatedAt: "2026-09-26" }],
			}),
		);
		chmodSync(source, 0);
		process.chdir(env.dir);
		const result = await codeNavTool.run({ mode: "project" });
		ok(result.kind === "ok");
		const status = JSON.parse(result.output);
		strictEqual(status.git.state, "observed");
		strictEqual(status.operatorTasks.state, "observed");
		strictEqual(status.operatorTasks.shown[0].id, "u1");
		strictEqual(status.orientation, null);
		strictEqual(status.codemap.state, "unknown");
	} finally {
		chmodSync(source, 0o644);
		process.chdir(previous);
		env.restore();
	}
});

test("orientation uses declared facts, invalidates changed/added manifests and survives lifecycle writes", async () => {
	const env = await isolateClioEnv("clio-orientation-");
	try {
		writeFileSync(
			join(env.dir, "package.json"),
			JSON.stringify({
				name: "solver",
				description: "Compute conserved flux",
				packageManager: "pnpm@10",
				scripts: { build: "tsc", test: "node --test" },
			}),
		);
		writeFileSync(join(env.dir, "main.ts"), "export const flux = 1;\n");
		await index(env.dir);
		const state = readClioState(env.dir);
		ok(state?.orientation);
		strictEqual(state.orientation.identity?.purpose, "Compute conserved flux");
		match(renderPromptContext(env.dir).text, /pnpm run test \[package.json#scripts.test\]/);
		match(renderPromptContext(env.dir).text, /current source\/status must be checked/);
		writeClioState(env.dir, { ...state, lastSessionAt: new Date().toISOString() });
		deepStrictEqual(readClioState(env.dir)?.orientation, state.orientation);
		writeFileSync(join(env.dir, "Cargo.toml"), '[package]\nname="added"\n');
		match(renderPromptContext(env.dir).text, /snapshot unavailable/);
		unlinkSync(join(env.dir, "Cargo.toml"));
		writeFileSync(join(env.dir, "package.json"), '{"name":"renamed","scripts":{"test":"changed"}}');
		match(renderPromptContext(env.dir).text, /snapshot unavailable/);
		const next = await loadCodewikiForTool(env.dir);
		ok(next.ok);
		strictEqual(readClioState(env.dir)?.orientation?.identity?.name, "renamed");
	} finally {
		env.restore();
	}
});

test("legacy codemap migrates under the existing lease; malformed canonical never falls back to old facts", async () => {
	const env = await isolateClioEnv("clio-codemap-migration-");
	try {
		writeFileSync(join(env.dir, "a.ts"), "export const before = 1;\n");
		await index(env.dir);
		renameSync(codemapPath(env.dir), legacyCodewikiPath(env.dir));
		strictEqual(codewikiPath(env.dir), legacyCodewikiPath(env.dir));
		const next = await loadCodewikiForTool(env.dir);
		ok(next.ok);
		ok(existsSync(codemapPath(env.dir)));
		strictEqual(codewikiPath(env.dir), codemapPath(env.dir));
		writeFileSync(codemapPath(env.dir), "{broken");
		strictEqual(readCodewiki(env.dir), null);
		writeFileSync(join(env.dir, "a.ts"), "export const after = 2;\n");
		const repaired = await loadCodewikiForTool(env.dir);
		ok(repaired.ok);
		ok(repaired.codewiki.symbols.some((s) => s.name === "after"));
		const reset = await runContextClear({ cwd: env.dir, confirmContext: () => true });
		ok(reset.removed.includes(".clio-coder/codemap.json"));
		ok(reset.removed.includes(".clio-coder/codewiki.json"));
	} finally {
		env.restore();
	}
});

test("prompt assembly does not read indexed source or wiki Markdown; damaged orientation is optional", {
	skip: process.platform === "win32",
}, async () => {
	const env = await isolateClioEnv("clio-prompt-no-walk-");
	try {
		writeFileSync(join(env.dir, "a.ts"), "export const fact = 1;\n");
		await index(env.dir);
		// A FIFO would hang an old synchronous fingerprint walk. Run in a bounded
		// child so failure is a regression, never a stuck test runner.
		unlinkSync(join(env.dir, "a.ts"));
		execFileSync("mkfifo", [join(env.dir, "a.ts")]);
		const loader = join(process.cwd(), "node_modules/tsx/dist/loader.mjs");
		const module = new URL("../../src/domains/context/prompt-context.ts", import.meta.url).href;
		const output = execFileSync(
			process.execPath,
			[
				"--import",
				loader,
				"--input-type=module",
				"-e",
				`import {renderPromptContext} from ${JSON.stringify(module)}; console.log(renderPromptContext(process.argv[1]).text)`,
				env.dir,
			],
			{ timeout: 5000, encoding: "utf8" },
		);
		match(output, /freshness checked on retrieval/);
		const path = join(env.dir, ".clio-coder/state.json");
		const state = JSON.parse(readFileSync(path, "utf8"));
		state.orientation = { version: 999 };
		writeFileSync(path, JSON.stringify(state));
		ok(readClioState(env.dir));
		strictEqual(readClioState(env.dir)?.orientation, undefined);
	} finally {
		env.restore();
	}
});

test("status reads operator intent and Git without certifying completion, malformed status stays unknown", async () => {
	const env = await isolateClioEnv("clio-project-status-");
	try {
		mkdirSync(join(env.dir, ".clio-coder"), { recursive: true });
		const path = join(env.dir, ".clio-coder/user-tasks.json");
		writeFileSync(
			path,
			JSON.stringify({
				version: 1,
				nextId: 2,
				tasks: [{ id: "u1", title: "Keep tolerance", status: "done", createdAt: "2026-09-26", updatedAt: "2026-09-26" }],
			}),
		);
		const status = await readProjectStatus(env.dir);
		strictEqual((status.operatorTasks as { state: string }).state, "observed");
		strictEqual((status.git as { state: string }).state, "unknown");
		match(String(status.interpretation), /not proof of passing checks/);
		writeFileSync(path, "{broken");
		strictEqual(((await readProjectStatus(env.dir)).operatorTasks as { state: string }).state, "unknown");
	} finally {
		env.restore();
	}
});

test("bounded workers discover context without a handbook; partial wiki is explicitly unvalidated", async () => {
	const env = await isolateClioEnv("clio-worker-orientation-");
	try {
		mkdirSync(join(env.dir, ".git")); // Hermetic handbook scope, even under a configured home.
		writeFileSync(join(env.dir, "a.ts"), "export const value = 1;\n");
		await index(env.dir);
		writeWikiMeta(env.dir, {
			version: 1,
			updatedAt: "2020-01-01T00:00:00Z",
			gitHead: null,
			model: "fixture",
			contentHash: "0".repeat(64),
			pages: [{ path: "present.md", title: "Present prose" }],
			generation: {
				requestedDepth: "simple",
				depth: "simple",
				sourceFiles: 1,
				sourceLines: 1,
				pagesPlanned: 3,
				pagesWritten: 0,
			},
		});
		const prompt = renderPromptContext(env.dir);
		strictEqual(prompt.handbookSources.length, 0);
		match(prompt.text, /0 of 3 planned pages validated, 3 owed/);
		const request = { agentId: "coder", task: "Inspect", cwd: env.dir, executionRole: "researcher" as const };
		const messages = buildDynamicPromptMessages(request, { projectPrompt: prompt, projectContextTier: "bounded" });
		const body = messages.find((m) => m.id === "dispatch-project-orientation")?.body;
		ok(body);
		match(body, /<codemap>/);
		match(body, /code_nav mode=project/);
		match(body, /planned pages validated/);
		ok(body.length <= 2400);
		strictEqual(buildDynamicPromptMessages(request, { projectPrompt: prompt, projectContextTier: "none" }).length, 0);
	} finally {
		env.restore();
	}
});

test("a copied worktree state never advertises another workspace's orientation", async () => {
	const env = await isolateClioEnv("clio-orientation-scope-");
	try {
		writeFileSync(join(env.dir, "a.ts"), "export const value = 1;\n");
		const result = await index(env.dir);
		const orientation = buildProjectOrientation(env.dir, result.codewiki, result.worker.fingerprint);
		const other = join(env.dir, "other");
		mkdirSync(join(other, ".clio-coder"), { recursive: true });
		copyFileSync(codemapPath(env.dir), codemapPath(other));
		writeClioState(other, { version: 1, projectType: "typescript", fingerprint: result.worker.fingerprint, orientation });
		match(renderPromptContext(other).text, /snapshot unavailable for current manifests\/workspace/);
	} finally {
		env.restore();
	}
});

test("project retrieval and wiki discovery are read-only in an unindexed workspace", async () => {
	const env = await isolateClioEnv("clio-project-read-only-");
	const previous = process.cwd();
	try {
		writeFileSync(join(env.dir, "package.json"), '{"name":"read-only-project"}');
		writeFileSync(join(env.dir, "a.ts"), "export const value = 1;\n");
		process.chdir(env.dir);
		const wiki = await codeNavTool.run({ mode: "wiki" });
		strictEqual(wiki.kind, "ok");
		strictEqual(existsSync(join(env.dir, ".clio-coder")), false);
		const status = await codeNavTool.run({ mode: "project" });
		ok(status.kind === "ok");
		match(status.output, /read-only-project/);
		strictEqual(existsSync(join(env.dir, ".clio-coder")), false);
	} finally {
		process.chdir(previous);
		env.restore();
	}
});

test("finishing bootstrap retains a concurrent index snapshot and records separate handbook inputs", async () => {
	const env = await isolateClioEnv("clio-bootstrap-snapshot-");
	try {
		writeFileSync(join(env.dir, "package.json"), '{"name":"concurrent-project"}');
		writeFileSync(join(env.dir, "a.ts"), "export const before = 1;\n");
		let generatedFrom = "";
		let latest = "";
		await runBootstrap({
			cwd: env.dir,
			confirmGitignore: () => true,
			generate: async (input) => {
				generatedFrom = readClioState(env.dir)?.fingerprint.treeHash ?? "";
				writeFileSync(join(env.dir, "a.ts"), "export const after = 2;\n");
				const result = await index(env.dir);
				latest = result.worker.fingerprint.treeHash;
				return fallbackBootstrapOutput(input).output;
			},
		});
		const state = readClioState(env.dir);
		ok(generatedFrom && latest && generatedFrom !== latest);
		strictEqual(state?.fingerprint.treeHash, latest);
		strictEqual(state?.orientation?.treeHash, latest);
		strictEqual(state?.bootstrapFingerprint?.treeHash, generatedFrom);
		ok(readCodewiki(env.dir)?.symbols.some((symbol) => symbol.name === "after"));
	} finally {
		env.restore();
	}
});

test("unreadable or oversized manifest evidence remains unknown", async () => {
	const env = await isolateClioEnv("clio-orientation-unknown-");
	try {
		writeFileSync(join(env.dir, "package.json"), " ".repeat(70 * 1024));
		writeFileSync(join(env.dir, "a.ts"), "export const value = 1;\n");
		await index(env.dir);
		strictEqual(readClioState(env.dir)?.orientation?.inputs["package.json"], "unknown");
		match(renderPromptContext(env.dir).text, /Manifest coverage partial/);
	} finally {
		env.restore();
	}
});

test("legacy configuration-only maps backfill content identities before canonical publication", async () => {
	const env = await isolateClioEnv("clio-codemap-config-upgrade-");
	try {
		writeFileSync(join(env.dir, "package.json"), '{"name":"configuration-only"}');
		const original = await index(env.dir);
		unlinkSync(codemapPath(env.dir));
		writeFileSync(legacyCodewikiPath(env.dir), JSON.stringify({ ...original.codewiki, version: 4 }));
		const migrated = await loadCodewikiForTool(env.dir);
		ok(migrated.ok);
		ok(readCodewiki(env.dir));
		ok(migrated.codewiki.files.every((file) => /^[0-9a-f]{16}$/.test(file.hash)));
		strictEqual(readClioState(env.dir)?.orientation?.identity?.name, "configuration-only");
	} finally {
		env.restore();
	}
});

test("wiki indexing refreshes orientation and preserves handbook generation provenance", async () => {
	const env = await isolateClioEnv("clio-wiki-orientation-");
	try {
		writeFileSync(join(env.dir, "a.ts"), "export const before = 1;\n");
		await index(env.dir);
		const state = readClioState(env.dir);
		ok(state);
		writeClioState(env.dir, { ...state, bootstrapFingerprint: state.fingerprint });
		writeFileSync(join(env.dir, "package.json"), '{"name":"updated-wiki-project"}');
		await runWikiGenerate({ cwd: env.dir, model: "fixture", generate: () => {} });
		strictEqual(readClioState(env.dir)?.orientation?.identity?.name, "updated-wiki-project");
		deepStrictEqual(readClioState(env.dir)?.bootstrapFingerprint, state.fingerprint);
	} finally {
		env.restore();
	}
});

test("oversized CMake does not hide checked Python/preset facts or certify unknown CMake inputs", async () => {
	const env = await isolateClioEnv("clio-partial-orientation-");
	try {
		mkdirSync(join(env.dir, ".git"));
		writeFileSync(join(env.dir, "a.py"), "def solve(): pass\n");
		writeFileSync(join(env.dir, "CMakeLists.txt"), `# ${"x".repeat(66_000)}`);
		writeFileSync(join(env.dir, "pyproject.toml"), '[project]\nname="flux"\ndescription="Preserve conservation"\n');
		writeFileSync(
			join(env.dir, "CMakePresets.json"),
			JSON.stringify({
				configurePresets: ["cuda", "rocm", "release", "debug"].map((name) => ({ name })),
				buildPresets: [{ name: "release" }],
				testPresets: [{ name: "release" }],
			}),
		);
		await index(env.dir);
		const prompt = renderPromptContext(env.dir).text;
		match(prompt, /Manifest coverage partial: CMakeLists.txt/);
		match(prompt, /Declared project \(pyproject.toml#project\): "flux"/);
		match(prompt, /cmake --preset/);
		match(prompt, /cmake --build --preset/);
		match(prompt, /ctest --preset/);
		match(
			String(((await readProjectStatus(env.dir)).orientation as { freshness: string }).freshness),
			/coverage partial/,
		);
		writeFileSync(join(env.dir, "pyproject.toml"), '[project]\nname="changed"\n');
		match(renderPromptContext(env.dir).text, /snapshot unavailable/);
	} finally {
		env.restore();
	}
});

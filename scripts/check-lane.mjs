#!/usr/bin/env node
// `pnpm run check:lane`: one pre-READY command for a lane branch. Runs the
// gates a landing fails on most, in order, for the diff against the lane's
// base: environment guards, typecheck and lint, the GUI check, OpenAPI and
// library freshness, the test files the diff adds or directly imports, and
// the gate-list check for new test files. It runs no suite, no build and no
// browser. Summary lines read `check: <step> pass|fail ...` or
// `not-run: <what> | <why>`. Exit 0 when everything ran and passed, 1 on a
// failure, 3 when everything that ran passed but something did not run.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Variables a git-driven runner exports that make a fixture write the shared repository config. */
export const REPOSITORY_ENV = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_PREFIX"];

const CONTRACT_SOURCES = [
	"src/core/telemetry/dto.ts",
	"src/core/telemetry/enums.ts",
	"src/core/telemetry/fact.ts",
	"src/core/telemetry/id-schemas.ts",
	"src/core/telemetry/schemas.ts",
	"src/engine/acp/types.ts",
	"src/engine/acp/runtime.ts",
];
const TEST_FILE = /\.test\.tsx?$/u;
const RELATIVE_IMPORT = /(?:from|import)\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/gu;
const MAX_TESTS = 40;

/** Relative import specifiers of `text`, resolved from `file` to repository paths with `.js` mapped to `.ts`. */
export function directImports(file, text) {
	const out = new Set();
	for (const match of text.matchAll(RELATIVE_IMPORT)) {
		const spec = match[1];
		if (spec === undefined) continue;
		const target = normalize(join(dirname(file), spec))
			.replace(/\.js$/u, ".ts")
			.replace(/\.jsx$/u, ".tsx");
		out.add(target.split("\\").join("/"));
	}
	return [...out];
}

/**
 * Pure selection. `changed` are repository paths in the diff, `added` the
 * subset the diff adds, `importsOf` maps each candidate test file to its
 * direct imports, `lists` holds the gate lists (`coreTests` paths, `guiTests`
 * paths relative to the GUI app, `packageTests` paths). Returns the affected
 * test files (changed tests, then direct importers of a changed module) and
 * the added tests no gate list names, outside the full-only directories.
 */
export function selectLaneTests({ changed, added, importsOf, lists }) {
	const changedSet = new Set(changed);
	const affected = new Set(changed.filter((path) => TEST_FILE.test(path) && importsOf.has(path)));
	for (const [test, imports] of importsOf) {
		if (imports.some((target) => changedSet.has(target))) affected.add(test);
	}
	const core = new Set(lists.coreTests);
	const gui = new Set(lists.guiTests.map((path) => `apps/clio-coder-gui/${path}`));
	const pkg = new Set(lists.packageTests);
	const unlisted = added.filter((path) => {
		if (!TEST_FILE.test(path)) return false;
		if (path.startsWith("tests/extended/") || path.startsWith("tests/extended-smoke/")) return false;
		if (!path.startsWith("tests/") && !path.startsWith("apps/clio-coder-gui/tests/")) return false;
		return !core.has(path) && !gui.has(path) && !pkg.has(path);
	});
	return { affected: [...affected].sort(), unlisted };
}

function git(args) {
	const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
	if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.trim()}`);
	return result.stdout.trim();
}

function versionBranch() {
	const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
	return `v${String(version).split("-")[0].replaceAll(".", "")}`;
}

function testFilesUnder(dir) {
	const abs = join(root, dir);
	if (!existsSync(abs)) return [];
	const out = [];
	for (const entry of readdirSync(abs, { withFileTypes: true })) {
		const rel = `${dir}/${entry.name}`;
		if (entry.isDirectory() && entry.name !== "fixtures" && entry.name !== "node_modules")
			out.push(...testFilesUnder(rel));
		else if (entry.isFile() && TEST_FILE.test(entry.name)) out.push(rel);
	}
	return out;
}

function parseArgs(argv) {
	const options = { base: process.env.CLIO_CODER_LANE_BASE, keepGoing: false, node: undefined };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--keep-going") options.keepGoing = true;
		else if (arg === "--base") options.base = argv[++i];
		else if (arg === "--node") options.node = argv[++i];
		else throw new Error(`unknown argument: ${arg}`);
	}
	return options;
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	const lines = [];
	let failed = false;
	let notRun = false;
	const pass = (step, detail = "") => lines.push(`check: ${step} pass${detail ? ` ${detail}` : ""}`);
	const fail = (step, detail = "") => {
		lines.push(`check: ${step} fail${detail ? ` ${detail}` : ""}`);
		failed = true;
	};
	const skip = (what, why) => {
		lines.push(`not-run: ${what} | ${why}`);
		notRun = true;
	};
	const finish = () => {
		console.log(`\n${lines.join("\n")}`);
		process.exit(failed ? 1 : notRun ? 3 : 0);
	};
	const stopIfFailed = () => {
		if (failed && !options.keepGoing) finish();
	};
	const run = (step, command, args, cwd = root) => {
		console.log(`\n── ${step}: ${command} ${args.join(" ")}`);
		const result = spawnSync(command, args, { cwd, stdio: "inherit", env: process.env });
		if (result.status === 0) pass(step);
		else fail(step, `(exit ${result.status ?? result.signal})`);
		stopIfFailed();
		return result.status === 0;
	};

	// 1. Environment guards.
	const exported = REPOSITORY_ENV.filter((name) => process.env[name] !== undefined);
	if (exported.length > 0) {
		fail("env", `${exported.join(", ")} exported; run: unset ${exported.join(" ")}`);
		finish();
	}
	const tmp = process.env.TMPDIR;
	if (!tmp || resolve(tmp) === "/tmp" || resolve(tmp) === "/var/tmp") {
		fail("env", "TMPDIR is unset or the system temp directory; export TMPDIR to a scratch directory");
		finish();
	}
	pass("env");

	const base = options.base ?? git(["merge-base", "HEAD", versionBranch()]);
	const status = git(["status", "--porcelain"]);
	const diff = (filter) =>
		[
			git(["diff", "--name-only", `--diff-filter=${filter}`, base]),
			filter.includes("A") ? git(["ls-files", "--others", "--exclude-standard"]) : "",
		]
			.join("\n")
			.split("\n")
			.filter(Boolean);
	const changed = [...new Set(diff("ACMR"))];
	const added = [...new Set(diff("A"))];
	console.log(`check:lane base ${base.slice(0, 10)}, ${changed.length} changed paths`);

	// 2. Typecheck and lint.
	run("typecheck", "pnpm", ["run", "typecheck"]);
	run("lint", "pnpm", ["run", "lint"]);

	// 3. GUI.
	if (changed.some((path) => path.startsWith("apps/clio-coder-gui/") || path.startsWith("packages/")))
		run("check:gui", "pnpm", ["run", "check:gui"]);

	// 4. Contract freshness.
	if (
		changed.some((path) => CONTRACT_SOURCES.includes(path) || /^apps\/clio-coder-gui\/contracts\/.*\.ts$/u.test(path))
	) {
		const generated = spawnSync(
			process.execPath,
			[
				"--import",
				"tsx",
				"--input-type=module",
				"-e",
				'import { openapiText } from "./apps/clio-coder-gui/contracts/openapi.ts"; process.stdout.write(openapiText());',
			],
			{ cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
		);
		const formatted =
			generated.status === 0
				? spawnSync("pnpm", ["exec", "biome", "format", "--stdin-file-path=apps/clio-coder-gui/contracts/openapi.json"], {
						cwd: root,
						input: generated.stdout,
						encoding: "utf8",
						maxBuffer: 64 * 1024 * 1024,
					})
				: generated;
		const current = readFileSync(join(root, "apps/clio-coder-gui/contracts/openapi.json"), "utf8");
		if (formatted.status !== 0) fail("openapi", `(could not regenerate: ${formatted.stderr.trim().split("\n")[0]})`);
		else if (formatted.stdout !== current)
			fail("openapi", "stale; run: pnpm --filter @iowarp/clio-coder-gui run openapi");
		else pass("openapi");
		stopIfFailed();
	}

	// 5. Library freshness.
	if (changed.some((path) => path.startsWith("library/"))) {
		run("skills:check", "pnpm", ["run", "skills:check"]);
		run("library:check", "pnpm", ["run", "library:check"]);
	}

	// 6-8. Affected and unlisted tests.
	const lists = await import("./ci-tests.mjs");
	const candidates = [...testFilesUnder("tests"), ...testFilesUnder("apps/clio-coder-gui/tests")];
	const importsOf = new Map(
		candidates.map((file) => [file, directImports(file, readFileSync(join(root, file), "utf8"))]),
	);
	const { affected, unlisted } = selectLaneTests({ changed, added, importsOf, lists });
	for (const file of unlisted)
		fail("test-lists", `${file} is in no gate list; add its stem to coreTests in scripts/ci-tests.mjs`);
	for (const file of added.filter((path) => /^tests\/extended(-smoke)?\/.*\.test\.ts$/u.test(path)))
		console.log(`notice: ${file} runs only in test:full`);
	if (unlisted.length === 0) pass("test-lists");
	stopIfFailed();

	const buildStamp = join(root, "dist/build.json");
	const headTime = Number(git(["log", "-1", "--format=%ct"])) * 1000;
	const staleBuild = !existsSync(buildStamp) || statSync(buildStamp).mtimeMs < headTime || status !== "";
	const runnable = [];
	for (const file of affected) {
		if (staleBuild && readFileSync(join(root, file), "utf8").includes("dist/cli/index.js"))
			skip(file, "needs `pnpm run build`");
		else runnable.push(file);
	}
	const selected = runnable.slice(0, MAX_TESTS);
	for (const file of runnable.slice(MAX_TESTS)) skip(file, `over the ${MAX_TESTS}-file cap`);
	const nodes = [process.execPath, ...(options.node ? [options.node] : [])];
	for (const node of nodes) {
		const version = spawnSync(node, ["--version"], { encoding: "utf8" }).stdout.trim();
		for (const [cwd, files, preloads] of [
			[root, selected.filter((file) => !file.startsWith("apps/")), ["./tests/harness/tmp-root.ts"]],
			[
				join(root, "apps/clio-coder-gui"),
				selected.filter((file) => file.startsWith("apps/")).map((file) => relative("apps/clio-coder-gui", file)),
				["../../tests/harness/tmp-root.ts", "./tests/harness/no-network.ts"],
			],
		]) {
			if (files.length === 0) continue;
			const args = ["--import", "tsx", ...preloads.flatMap((p) => ["--import", p]), "--test", ...files];
			console.log(`\n── test:file (${version}) ${files.join(" ")}`);
			const result = spawnSync(node, args, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
			process.stdout.write(result.stdout ?? "");
			process.stderr.write(result.stderr ?? "");
			const count = (name) => Number(new RegExp(`(?:ℹ|#) ${name} (\\d+)`, "u").exec(result.stdout ?? "")?.[1] ?? 0);
			const detail = `(${count("pass")} pass, ${count("fail")} fail, ${count("skipped")} skipped) node ${version.replace(/^v/u, "")}`;
			const label = `test:file ${files.length} files`;
			if (result.status !== 0) fail(label, detail);
			else if (count("skipped") > 0) skip(`${label} ${detail}`, "skipped tests");
			else pass(label, detail);
		}
	}
	if (affected.length === 0) pass("test:file", "(no affected test files; direct importers only)");
	finish();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	main().catch((error) => {
		console.error(`check:lane: ${error instanceof Error ? error.message : String(error)}`);
		process.exit(1);
	});
}

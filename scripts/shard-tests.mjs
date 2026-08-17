#!/usr/bin/env node
/**
 * The sharded test runner. `npm test` runs 369 files through Node's test
 * runner one process per file today, and every one of those processes loads
 * the `src/` module graph from scratch. `--experimental-test-isolation=none`
 * loads it once per process instead of once per file, so the fix is to run
 * a small, fixed number of processes rather than 369.
 *
 * This spawns N lanes, N defaulting to the machine's core count, each one a
 * single `node --test --experimental-test-isolation=none` process over a
 * slice of the test files. Lanes run concurrently and their results are
 * merged into the one pass/fail summary a caller of `npm test` expects.
 *
 * Shard assignment is deterministic: the same file list and the same lane
 * count always produce the same slices, so a failure that shows up in
 * "lane 3" reproduces by rerunning lane 3 alone (`--shard 3`), not by
 * guessing which files happened to land together.
 *
 * Weighting comes from .superpowers/uniq.json, per-file milliseconds from a
 * real run. Splitting by file count would let one 100s file share a lane
 * with nine 1s files while another lane gets ten 10s files; splitting by
 * measured cost balances the lanes instead. A file missing from that map
 * (new since the measurement, or never profiled) falls back to the median
 * of the known costs.
 *
 * Usage:
 *   node scripts/shard-tests.mjs [pattern...]
 *   node scripts/shard-tests.mjs --lanes 4
 *   node scripts/shard-tests.mjs --shard 2          (rerun lane 2 alone)
 *   node scripts/shard-tests.mjs --list              (print the assignment, run nothing)
 *   node scripts/shard-tests.mjs -- --test-name-pattern=foo   (forwarded to every lane)
 *
 * CLIO_TEST_LANES overrides the lane count the same way --lanes does; the
 * flag wins if both are given. Extra node --test flags (coverage, a name
 * filter) are forwarded to every lane if passed after a bare `--`.
 */

import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { availableParallelism } from "node:os";
import { relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const UNIQ_JSON = resolve(REPO_ROOT, ".superpowers/uniq.json");
const DEFAULT_PATTERNS = ["tests/contracts/**/*.test.ts", "tests/smoke/**/*.test.ts"];
const RUNNER_ARGS = [
	"--import",
	"tsx",
	"--import",
	"./tests/harness/tmp-root.ts",
	"--test",
	"--experimental-test-isolation=none",
];

function posix(path) {
	return path.split(sep).join("/");
}

function regexForGlob(pattern) {
	const escaped = posix(pattern)
		.replace(/[.+?^${}()|[\]\\]/g, "\\$&")
		.replace(/\*\*\//g, "__GLOBSTAR_SLASH__")
		.replace(/\*\*/g, "__GLOBSTAR__")
		.replace(/\*/g, "[^/]*")
		.replace(/__GLOBSTAR_SLASH__/g, "(?:.*/)?")
		.replace(/__GLOBSTAR__/g, ".*");
	return new RegExp(`^${escaped}$`);
}

function rootForPattern(pattern) {
	const normalized = posix(pattern);
	const star = normalized.search(/[*?]/);
	if (star === -1) return normalized;
	const slash = normalized.slice(0, star).lastIndexOf("/");
	return slash === -1 ? "." : normalized.slice(0, slash);
}

function walk(dir, out) {
	for (const entry of readdirSync(dir)) {
		const path = resolve(dir, entry);
		const stat = statSync(path);
		if (stat.isDirectory()) {
			walk(path, out);
			continue;
		}
		if (stat.isFile()) out.push(path);
	}
}

function expandPatterns(patterns) {
	const files = new Set();
	for (const pattern of patterns) {
		const absolute = resolve(REPO_ROOT, pattern);
		if (!pattern.includes("*") && existsSync(absolute)) {
			files.add(posix(relative(REPO_ROOT, absolute)));
			continue;
		}
		const root = resolve(REPO_ROOT, rootForPattern(pattern));
		if (!existsSync(root)) continue;
		const all = [];
		walk(root, all);
		const match = regexForGlob(pattern);
		for (const path of all) {
			const rel = posix(relative(REPO_ROOT, path));
			if (match.test(rel)) files.add(rel);
		}
	}
	return [...files].sort((left, right) => left.localeCompare(right));
}

function loadWeights() {
	const raw = JSON.parse(readFileSync(UNIQ_JSON, "utf8"));
	const byFile = new Map();
	for (const entry of raw) byFile.set(entry.file, entry.ms);
	const known = [...byFile.values()].sort((left, right) => left - right);
	const median = known.length === 0 ? 200 : known[Math.floor(known.length / 2)];
	return { byFile, fallback: median };
}

/**
 * Deterministic longest-processing-time bin packing: heaviest file first,
 * always dropped into whichever lane is currently lightest. Ties on lane
 * load go to the lowest lane index and ties on file weight go to the file
 * that sorts first by path, so the same inputs always produce the same
 * lanes regardless of filesystem read order.
 */
function assignLanes(files, weights, laneCount) {
	const weighed = files
		.map((file) => ({ file, weight: weights.byFile.get(file) ?? weights.fallback }))
		.sort((left, right) => right.weight - left.weight || left.file.localeCompare(right.file));
	const lanes = Array.from({ length: laneCount }, () => ({ files: [], total: 0 }));
	for (const { file, weight } of weighed) {
		let target = 0;
		for (let index = 1; index < lanes.length; index += 1) {
			if (lanes[index].total < lanes[target].total) target = index;
		}
		lanes[target].files.push(file);
		lanes[target].total += weight;
	}
	for (const lane of lanes) lane.files.sort((left, right) => left.localeCompare(right));
	return lanes;
}

function parseArgs(argv) {
	const out = { patterns: [], lanes: undefined, shard: undefined, list: false, forward: [] };
	let index = 0;
	for (; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--") {
			out.forward = argv.slice(index + 1);
			break;
		}
		if (arg === "--lanes") {
			const parsed = Number.parseInt(argv[index + 1] ?? "", 10);
			out.lanes = Number.isInteger(parsed) ? parsed : undefined;
			index += 1;
			continue;
		}
		if (arg === "--shard") {
			const parsed = Number.parseInt(argv[index + 1] ?? "", 10);
			out.shard = Number.isInteger(parsed) ? parsed : undefined;
			index += 1;
			continue;
		}
		if (arg === "--list") {
			out.list = true;
			continue;
		}
		out.patterns.push(arg);
	}
	if (out.patterns.length === 0) out.patterns = [...DEFAULT_PATTERNS];
	return out;
}

function laneName(index, total) {
	const width = String(total - 1).length;
	return `lane-${String(index).padStart(width, "0")}`;
}

/**
 * Node's default spec reporter ends each run with `ℹ tests N`, `ℹ pass N`,
 * `ℹ fail N`. Pulled out with a small regex rather than switched to the TAP
 * reporter and parsed properly, since the merge only needs the totals.
 */
function parseSummary(output) {
	const tests = /^ℹ tests (\d+)/m.exec(output);
	const pass = /^ℹ pass (\d+)/m.exec(output);
	const fail = /^ℹ fail (\d+)/m.exec(output);
	return {
		tests: tests ? Number(tests[1]) : 0,
		pass: pass ? Number(pass[1]) : 0,
		fail: fail ? Number(fail[1]) : 0,
	};
}

function runLane(name, files, forward) {
	return new Promise((resolvePromise) => {
		const args = [...RUNNER_ARGS, ...forward, ...files];
		const child = spawn(process.execPath, args, { cwd: REPO_ROOT, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.on("close", (code) => {
			resolvePromise({ name, files, code: code ?? 1, stdout, stderr, summary: parseSummary(stdout) });
		});
	});
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const envLanes = Number.parseInt(process.env.CLIO_TEST_LANES ?? "", 10);
	const requested = args.lanes ?? (Number.isInteger(envLanes) ? envLanes : undefined) ?? availableParallelism();
	const laneCount = Math.max(1, requested);
	const files = expandPatterns(args.patterns);
	if (files.length === 0) throw new Error(`no test files matched: ${args.patterns.join(", ")}`);
	const weights = loadWeights();
	const lanes = assignLanes(files, weights, Math.min(laneCount, files.length));

	if (args.list) {
		for (const [index, lane] of lanes.entries()) {
			process.stdout.write(
				`${laneName(index, lanes.length)}  ${(lane.total / 1000).toFixed(1)}s  ${lane.files.length} files\n`,
			);
			for (const file of lane.files) process.stdout.write(`  ${file}\n`);
		}
		return 0;
	}

	const toRun = args.shard === undefined ? lanes.entries() : [[args.shard, lanes[args.shard]]];
	if (args.shard !== undefined && !lanes[args.shard]) {
		throw new Error(`--shard ${args.shard} is out of range: ${lanes.length} lanes (0..${lanes.length - 1})`);
	}

	const started = Date.now();
	const results = await Promise.all(
		[...toRun].map(([index, lane]) => runLane(laneName(index, lanes.length), lane.files, args.forward)),
	);
	const wallSeconds = ((Date.now() - started) / 1000).toFixed(1);

	let totalTests = 0;
	let totalPass = 0;
	let totalFail = 0;
	const failedLanes = [];
	for (const result of results) {
		process.stdout.write(result.stdout);
		process.stderr.write(result.stderr);
		totalTests += result.summary.tests;
		totalPass += result.summary.pass;
		totalFail += result.summary.fail;
		if (result.code !== 0) failedLanes.push(result.name);
	}

	process.stdout.write(
		`\n# shards ${results.length}  # tests ${totalTests}  # pass ${totalPass}  # fail ${totalFail}  # wall ${wallSeconds}s\n`,
	);
	if (failedLanes.length > 0) {
		process.stdout.write(`# failed lanes: ${failedLanes.join(", ")}\n`);
		process.stdout.write(`# reproduce with: node scripts/shard-tests.mjs --shard <n>\n`);
		return 1;
	}
	return 0;
}

main()
	.then((code) => process.exit(code))
	.catch((error) => {
		process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
		process.exit(2);
	});

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
 * Weighting comes from scripts/shard-weights.json, per-file milliseconds
 * from a real run, checked in because it is a build input that every lane
 * assignment (including a fresh clone's first CI run) depends on, not
 * scratch. Splitting by file count would let one 100s file share a lane
 * with nine 1s files while another lane gets ten 10s files; splitting by
 * measured cost balances the lanes instead. A file missing from that map
 * (new since the measurement, or never profiled) falls back to the median
 * of the known costs. If the weights file itself is ever missing, every
 * file falls back to the same uniform weight, which keeps lane assignment
 * deterministic (still file-count based) but unbalanced until the file is
 * restored.
 *
 * scripts/shard-weights.json is machine-generated, not hand-edited. Each
 * entry is `{ "file": "<repo-relative path>", "ms": <wall-clock ms> }`,
 * one `node --test` process per file, run standalone rather than under
 * `--experimental-test-isolation=none` so the number reflects one file's
 * own cost and is not diluted by whatever else shared its lane's process
 * that run. Regenerate it whenever the file list or the relative cost of
 * the slow files has drifted enough that `--list` shows lopsided lane
 * totals (a new large test file is the common trigger); a few files off by
 * a fixed fallback median is not worth a regeneration. Command:
 *
 *   node scripts/shard-tests.mjs --emit-weights > scripts/shard-weights.json
 *
 * This runs every matched file through its own process and takes roughly
 * as long as the old one-process-per-file `npm test` did (minutes, not the
 * sharded run's seconds), because that per-file isolation is the point: it
 * is measuring the same cost `--list` will later divide across lanes.
 *
 * Usage:
 *   node scripts/shard-tests.mjs [pattern...]
 *   node scripts/shard-tests.mjs --lanes 4
 *   node scripts/shard-tests.mjs --shard 2          (rerun lane 2 alone)
 *   node scripts/shard-tests.mjs --shard serial     (rerun the serial lane alone)
 *   node scripts/shard-tests.mjs --list              (print the assignment, run nothing)
 *   node scripts/shard-tests.mjs --emit-weights      (regenerate shard-weights.json; prints to stdout)
 *   node scripts/shard-tests.mjs -- --test-name-pattern=foo   (forwarded to every lane)
 *
 * CLIO_TEST_LANES overrides the lane count the same way --lanes does; the
 * flag wins if both are given. Extra node --test flags (coverage, a name
 * filter) are forwarded to every lane if passed after a bare `--`.
 *
 * Every lane is handed CLIO_TEST_CONCURRENCY, how many lanes this run spawns
 * at once. tests/harness/load.ts reads it to widen watchdog timeouts by the
 * contention they actually run under, so a budget picked against an unloaded
 * measurement does not fire as a false failure in a 24-way run. The serial
 * lane is handed 1, because it is the only thing running.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const SHARD_WEIGHTS_JSON = resolve(REPO_ROOT, "scripts/shard-weights.json");
const DEFAULT_PATTERNS = ["tests/contracts/**/*.test.ts", "tests/smoke/**/*.test.ts"];

/**
 * Files whose assertions are measurements, run alone after the parallel lanes
 * have drained.
 *
 * Everything else in this suite treats a timeout as a watchdog, so the sharded
 * runner can widen it (tests/harness/load.ts) and lose nothing. These four
 * cannot: the number each one compares against is the claim. "The batch beat
 * serial" stops meaning anything if the bound is raised past serial, and
 * "SIGKILL followed the 2s grace" stops meaning anything if the grace is
 * scaled. Their only honest fix is a quiet box, so they get one.
 *
 * Cost is about 10s of wall clock added to a ~130s run, and every entry is
 * here because it failed under 24-way load and passed alone. Keep the list
 * short: a file belongs here only when widening its margin would weaken what
 * it proves. Anything that merely waits for something belongs in the parallel
 * lanes with a scaled watchdog.
 */
const SERIAL_FILES = [
	// per-call admission under 1ms; a concurrent batch under 2x one tool's delay
	"tests/contracts/tool-admission-cost.test.ts",
	// route decision p95 under the same 10ms bound the resolver enforces on itself
	"tests/contracts/joint-route-resolver.test.ts",
	// an operator's parked thinking time must not land in the tool's charged duration
	"tests/contracts/autonomy.test.ts",
	// a timed-out child dies to SIGTERM before the 2s grace, or to SIGKILL after it
	"tests/contracts/live-spawn.test.ts",
];
const SERIAL_LANE_NAME = "lane-serial";
const RUNNER_ARGS = [
	"--import",
	"tsx",
	"--import",
	"./tests/harness/tmp-root.ts",
	"--test",
	// Keep the reporter format stable across supported Node majors. Its destination
	// is supplied per lane by runLane so reporter writes cannot cross a contract's
	// temporary process.stdout/process.stderr capture and corrupt the output under
	// test.
	"--test-reporter=spec",
	"--experimental-test-isolation=none",
];
/** Same runner, one file at a time, for `--emit-weights`: no isolation flag, since each process already covers exactly one file. */
const EMIT_WEIGHTS_RUNNER_ARGS = ["--import", "tsx", "--import", "./tests/harness/tmp-root.ts", "--test"];

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

/**
 * Checked-in weights are the normal case, but a missing or unreadable file
 * must not take `npm test` down with it: every file falls back to the same
 * weight, which keeps `assignLanes` deterministic (it degrades to a
 * file-count split) instead of throwing before a single test runs.
 */
function loadWeights() {
	const byFile = new Map();
	if (existsSync(SHARD_WEIGHTS_JSON)) {
		try {
			const raw = JSON.parse(readFileSync(SHARD_WEIGHTS_JSON, "utf8"));
			for (const entry of raw) byFile.set(entry.file, entry.ms);
		} catch (error) {
			process.stderr.write(
				`shard-tests: ${SHARD_WEIGHTS_JSON} is present but unreadable (${error.message}); falling back to uniform weights\n`,
			);
			byFile.clear();
		}
	}
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
		.map((file) => ({
			file,
			weight: weights.byFile.get(file) ?? weights.fallback,
		}))
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
	for (const lane of lanes) {
		lane.files.sort((left, right) => left.localeCompare(right));
	}
	return lanes;
}

function parseArgs(argv) {
	const out = {
		patterns: [],
		lanes: undefined,
		shard: undefined,
		list: false,
		emitWeights: false,
		forward: [],
	};
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
			const raw = argv[index + 1] ?? "";
			const parsed = Number.parseInt(raw, 10);
			// `--shard serial` addresses the one lane that has no index.
			out.shard = raw === "serial" ? "serial" : Number.isInteger(parsed) ? parsed : undefined;
			index += 1;
			continue;
		}
		if (arg === "--list") {
			out.list = true;
			continue;
		}
		if (arg === "--emit-weights") {
			out.emitWeights = true;
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

function runLane(name, files, forward, concurrency) {
	return new Promise((resolvePromise) => {
		const reporterDir = mkdtempSync(join(tmpdir(), "clio-shard-reporter-"));
		const reporterPath = join(reporterDir, `${name}.log`);
		const args = [...RUNNER_ARGS, `--test-reporter-destination=${reporterPath}`, ...forward, ...files];
		const child = spawn(process.execPath, args, {
			cwd: REPO_ROOT,
			env: { ...process.env, CLIO_TEST_CONCURRENCY: String(concurrency) },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.on("close", (code) => {
			let reporter = "";
			try {
				reporter = readFileSync(reporterPath, "utf8");
			} finally {
				rmSync(reporterDir, { recursive: true, force: true });
			}
			resolvePromise({
				name,
				files,
				code: code ?? 1,
				stdout,
				stderr,
				reporter,
				summary: parseSummary(reporter),
			});
		});
	});
}

/** One file, its own process, wall-clock ms. This is the number `--emit-weights` records. */
function timeFile(file) {
	return new Promise((resolvePromise) => {
		const started = Date.now();
		const args = [...EMIT_WEIGHTS_RUNNER_ARGS, file];
		const child = spawn(process.execPath, args, {
			cwd: REPO_ROOT,
			env: process.env,
			stdio: ["ignore", "ignore", "ignore"],
		});
		child.on("close", () => {
			resolvePromise({ file, ms: Date.now() - started });
		});
	});
}

/**
 * Sequential on purpose: running files concurrently here would measure
 * contention, exactly the thing the sharded runner exists to avoid, and
 * would produce a weights file that mis-describes standalone cost.
 */
async function emitWeights(files) {
	const entries = [];
	for (const [index, file] of files.entries()) {
		process.stderr.write(`[${index + 1}/${files.length}] timing ${file}\n`);
		entries.push(await timeFile(file));
	}
	entries.sort((left, right) => left.file.localeCompare(right.file));
	// Tabs, because the redirect in the documented command writes straight into
	// the repository and `npm run lint` formats JSON with tabs. One-space indent
	// meant the regeneration command produced a file that failed the next lint.
	process.stdout.write(`${JSON.stringify(entries, null, "\t")}\n`);
	return 0;
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const files = expandPatterns(args.patterns);
	if (files.length === 0) {
		throw new Error(`no test files matched: ${args.patterns.join(", ")}`);
	}

	if (args.emitWeights) return emitWeights(files);

	const envLanes = Number.parseInt(process.env.CLIO_TEST_LANES ?? "", 10);
	const requested = args.lanes ?? (Number.isInteger(envLanes) ? envLanes : undefined) ?? availableParallelism();
	const laneCount = Math.max(1, requested);
	const weights = loadWeights();
	const serialSet = new Set(SERIAL_FILES);
	const serialFiles = files.filter((file) => serialSet.has(file));
	const parallelFiles = files.filter((file) => !serialSet.has(file));
	const lanes = assignLanes(parallelFiles, weights, Math.min(laneCount, Math.max(1, parallelFiles.length)));
	const serialTotal = serialFiles.reduce((sum, file) => sum + (weights.byFile.get(file) ?? weights.fallback), 0);

	if (args.list) {
		for (const [index, lane] of lanes.entries()) {
			process.stdout.write(
				`${laneName(index, lanes.length)}  ${(lane.total / 1000).toFixed(1)}s  ${lane.files.length} files\n`,
			);
			for (const file of lane.files) process.stdout.write(`  ${file}\n`);
		}
		if (serialFiles.length > 0) {
			process.stdout.write(
				`${SERIAL_LANE_NAME}  ${(serialTotal / 1000).toFixed(1)}s  ${serialFiles.length} files (runs alone, after the lanes above)\n`,
			);
			for (const file of serialFiles) process.stdout.write(`  ${file}\n`);
		}
		return 0;
	}

	const wantsSerialOnly = args.shard === "serial";
	if (wantsSerialOnly && serialFiles.length === 0) {
		throw new Error("--shard serial matched no files: none of SERIAL_FILES is in the expanded pattern");
	}
	if (typeof args.shard === "number" && !lanes[args.shard]) {
		throw new Error(`--shard ${args.shard} is out of range: ${lanes.length} lanes (0..${lanes.length - 1})`);
	}
	const toRun = wantsSerialOnly
		? []
		: typeof args.shard === "number"
			? [[args.shard, lanes[args.shard]]]
			: lanes.entries();
	// A named lane runs only what was asked for; a whole-suite run always ends
	// with the serial lane, on the box the parallel lanes just gave back.
	const runSerial = serialFiles.length > 0 && (args.shard === undefined || wantsSerialOnly);

	// A `.git` at the system temp root makes src/tools/ignore-policy.ts report
	// every mkdtemp scratch as inside a git repository, which fails the
	// ignore-policy contracts from whichever lane happens to run them. Lanes
	// carry tests/harness/tmp-git-guard.ts, which refuses the write and names the
	// caller; this is the run-level backstop for a creator outside every lane,
	// including this process. See issue #205.
	const strayGit = join(tmpdir(), ".git");
	const strayGitExistedBefore = existsSync(strayGit);
	if (strayGitExistedBefore) {
		process.stderr.write(
			`shard-tests: ${strayGit} already exists before this run. It will fail the ignore-policy contracts in tests/contracts/tool-hardening.test.ts. Remove it.\n`,
		);
	}

	const started = Date.now();
	const laneEntries = [...toRun];
	const results = await Promise.all(
		laneEntries.map(([index, lane]) =>
			runLane(laneName(index, lanes.length), lane.files, args.forward, laneEntries.length),
		),
	);
	// Awaited separately, not merged into the Promise.all above: the whole point
	// of this lane is that nothing else is competing for the box while it runs.
	if (runSerial) results.push(await runLane(SERIAL_LANE_NAME, serialFiles, args.forward, 1));
	const wallSeconds = ((Date.now() - started) / 1000).toFixed(1);

	let totalTests = 0;
	let totalPass = 0;
	let totalFail = 0;
	const failedLanes = [];
	for (const result of results) {
		process.stdout.write(result.stdout);
		process.stderr.write(result.stderr);
		process.stderr.write(result.reporter);
		totalTests += result.summary.tests;
		totalPass += result.summary.pass;
		totalFail += result.summary.fail;
		if (result.code !== 0) failedLanes.push(result.name);
	}

	const shardLabel = runSerial ? `${laneEntries.length}+serial` : String(laneEntries.length);
	process.stdout.write(
		`\n# shards ${shardLabel}  # tests ${totalTests}  # pass ${totalPass}  # fail ${totalFail}  # wall ${wallSeconds}s\n`,
	);
	if (!strayGitExistedBefore && existsSync(strayGit)) {
		process.stdout.write(
			`# ${strayGit} was created during this run. Nothing in this repository may write a .git at the system temp root: it makes every mkdtemp scratch look like it sits inside a git repository and breaks the ignore-policy contracts. Remove it, then look for a tmp-git-guard message in the lane output above for the caller. See issue #205.\n`,
		);
		return 1;
	}
	if (failedLanes.length > 0) {
		process.stdout.write(`# failed lanes: ${failedLanes.join(", ")}\n`);
		process.stdout.write(`# reproduce with: node scripts/shard-tests.mjs --shard <n|serial>\n`);
		return 1;
	}
	return 0;
}

main()
	.then((code) => {
		// Let piped stdout/stderr drain. process.exit() can discard the tail of a
		// lane reporter (including the aggregate summary) under backpressure.
		process.exitCode = code;
	})
	.catch((error) => {
		process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
		process.exitCode = 2;
	});

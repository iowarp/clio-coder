#!/usr/bin/env node
// Handbook benchmark: measures a handbook by what it does for the agents that read it.
//
//   score   static scorer: recall of a reference handbook's rules, invalid citations, duplicate pairs,
//           stale checker ids, size; prints JSON with one `score` key for `clio-coder research --metric score`.
//   replay  task source from history: landed commits become tasks (message without file names) run at the
//           commit's parent, keyed by the commit's own file set.
//   run     live A/B: every arm (a handbook file, or `none`) runs every task for N rounds in its own clone
//           under TMPDIR with a fresh Clio home; prints one JSON row per run, then a summary.
//
// Checkout-only (scripts/ does not ship). It never runs against the operator's real Clio home.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CHECKER = "tests/boundaries/check-boundaries.ts";

// ---------------------------------------------------------------------------
// Rules: the units a handbook states
// ---------------------------------------------------------------------------

/** Top-level numbered items and bullets of a Markdown handbook, continuation lines joined, fences skipped. */
export function handbookRules(markdown) {
	const rules = [];
	let current = null;
	let fenced = false;
	for (const line of markdown.split("\n")) {
		if (/^\s*```/.test(line)) {
			fenced = !fenced;
			current = null;
			continue;
		}
		if (fenced) continue;
		const item = /^(?:\d+[.)]|[-*+])\s+(.*)$/.exec(line);
		if (item) {
			current = { text: item[1] ?? "" };
			rules.push(current);
		} else if (current && /^\s+\S/.test(line) && !/^\s*(?:\d+[.)]|[-*+])\s/.test(line)) {
			current.text += ` ${line.trim()}`;
		} else {
			current = null;
		}
	}
	return rules.map((rule) => rule.text.trim()).filter((text) => text.length > 0);
}

/** Words of four letters or more and whole code spans: the same tokens `context init` compares. */
function ruleTokens(rule) {
	return new Set(
		[...rule.toLowerCase().matchAll(/`([^`\n]+)`|\b[a-z]{4,}\b/g)].map((match) =>
			match[1] !== undefined ? `\`${match[1]}` : match[0],
		),
	);
}

/** Code spans that name a path below the root. */
function citedPaths(rule) {
	return [...rule.matchAll(/`([^`\s]+\/[^`\s]*)`/g)].map((match) => match[1] ?? "").filter((path) => path.length > 0);
}

function ruleIds(rule) {
	return [...new Set(rule.match(/\brule\d+\b/g) ?? [])].sort();
}

/**
 * Two rules restate each other when most words match, or more than half match and they cite the same path.
 * Rules citing different checker ids never do.
 */
function restates(a, b) {
	const left = ruleIds(a).join(",");
	const right = ruleIds(b).join(",");
	if (left && right && left !== right) return false;
	const x = ruleTokens(a);
	const y = ruleTokens(b);
	const shorter = x.size <= y.size ? x : y;
	const longer = x.size <= y.size ? y : x;
	if (shorter.size === 0) return false;
	const shared = [...shorter].filter((token) => longer.has(token));
	const share = shared.length / shorter.size;
	if (share >= 0.7) return true;
	return share >= 0.55 && shared.some((token) => /^`[^`\s/]+\/[^`\s]/.test(token));
}

// ---------------------------------------------------------------------------
// Static scorer
// ---------------------------------------------------------------------------

/**
 * A cited path resolves when it exists, or for a pattern when the directory before its first wildcard does. A
 * short name may be relative to a directory the same rule cites (`apis/` after `src/engine/`). Absolute paths,
 * `.git/` and package names are not tree citations.
 */
function resolves(tree, path, rule = "") {
	const clean = path.replace(/[.,;:]+$/, "");
	const wild = clean.search(/[*<{]/);
	const literal = wild === -1 ? clean : clean.slice(0, wild).replace(/[^/]*$/, "");
	if (literal === "") return true;
	if (/^(?:[@~/]|\.git\/|https?:)/.test(literal)) return true;
	if (existsSync(join(tree, literal))) return true;
	const bases = citedPaths(rule)
		.filter((dir) => dir.endsWith("/") && dir !== path)
		.flatMap((dir) => {
			const wildAt = dir.search(/[*<{]/);
			if (wildAt === -1) return [dir];
			// `src/domains/<name>/`: any directory in that position.
			const prefix = dir.slice(0, wildAt);
			try {
				return readdirSync(join(tree, prefix), { withFileTypes: true })
					.filter((entry) => entry.isDirectory())
					.map((entry) => join(prefix, entry.name));
			} catch {
				return [];
			}
		});
	return bases.some((dir) => existsSync(join(tree, dir, literal)));
}

/** A sentence that forbids, retires or bans what it cites names a path that is meant to be absent. */
const PROHIBITION_RE =
	/\b(?:must not|never|not exist|retired|banned|outside|except|excluding|do not (?:add|restore|create|recreate)|no longer)\b/i;

/** Cited paths that do not resolve, less those a prohibiting or excluding sentence names. */
function missingCitations(tree, rule) {
	// A rule split on its colon still forbids the list after it, so the test is the sentence up to a period.
	const sentences = rule.split(/(?<=\.)\s+/);
	return citedPaths(rule).filter((path) => {
		if (resolves(tree, path, rule)) return false;
		const own = sentences.filter((sentence) => sentence.includes(`\`${path}\``));
		return !own.some((sentence) => PROHIBITION_RE.test(sentence));
	});
}

/** Checker ids and the text around each mention, from the tree's own checker. */
function checkerVocabulary(tree) {
	const path = join(tree, CHECKER);
	if (!existsSync(path)) return new Map();
	const lines = readFileSync(path, "utf8").split("\n");
	const vocabulary = new Map();
	lines.forEach((line, index) => {
		for (const id of line.match(/\brule\d+\b/g) ?? []) {
			const context = lines.slice(Math.max(0, index - 3), index + 2).join(" ");
			vocabulary.set(id, `${vocabulary.get(id) ?? ""} ${context}`);
		}
	});
	return vocabulary;
}

/**
 * A rule citing one checker id is stale when the id is gone, or when another id's checker text matches the rule
 * clearly better (a renumbering). Same thresholds as `context init`'s correction.
 */
function staleRuleId(rule, vocabulary) {
	const ids = ruleIds(rule);
	if (ids.length !== 1 || vocabulary.size === 0) return null;
	const id = ids[0];
	if (!vocabulary.has(id)) return { id, current: null };
	const tokens = ruleTokens(rule.replaceAll(id, " "));
	const score = (text) => {
		const own = ruleTokens(text);
		return own.size === 0 ? 0 : [...tokens].filter((token) => own.has(token)).length / tokens.size;
	};
	const cited = score(vocabulary.get(id) ?? "");
	let best = { id, score: cited };
	for (const [other, text] of vocabulary) {
		const value = score(text);
		if (value > best.score) best = { id: other, score: value };
	}
	return best.id !== id && best.score >= 0.4 && best.score - cited >= 0.15 ? { id, current: best.id } : null;
}

/** Tree facts a rule may assert: package manager from the lockfile, package script names, formatter. */
function treeFacts(tree) {
	const read = (name) => (existsSync(join(tree, name)) ? readFileSync(join(tree, name), "utf8") : null);
	const pkg = JSON.parse(read("package.json") ?? "{}");
	const managers = [
		["pnpm", "pnpm-lock.yaml"],
		["npm", "package-lock.json"],
		["yarn", "yarn.lock"],
		["bun", "bun.lockb"],
	].filter(([, lock]) => existsSync(join(tree, lock)));
	const manager = managers.length === 1 ? managers[0][0] : String(pkg.packageManager ?? "").split("@")[0] || null;
	const formatters = [
		["biome", ["biome.json", "biome.jsonc"]],
		["prettier", [".prettierrc", ".prettierrc.json", "prettier.config.js", ".prettierrc.yaml"]],
	]
		.filter(([, files]) => files.some((file) => existsSync(join(tree, file))))
		.map(([name]) => name);
	return {
		manager,
		scripts: new Set(Object.keys(pkg.scripts ?? {})),
		formatters,
		hasPackage: read("package.json") !== null,
	};
}

/** What a rule asserts that the tree's facts deny; empty when it asserts nothing the table holds. */
export function contradictions(rule, facts) {
	const found = [];
	for (const match of rule.matchAll(/`(pnpm|npm|yarn|bun)(?: run)? ([a-z][\w:.-]*)[^`]*`/g)) {
		const [, manager, script] = match;
		if (facts.manager && manager !== facts.manager && manager !== "npm")
			found.push(`package manager is ${facts.manager}, not ${manager}`);
		if (
			facts.hasPackage &&
			script &&
			!["install", "add", "exec", "dlx", "test", "i", "x", "publish", "pack", "run"].includes(script) &&
			!facts.scripts.has(script)
		)
			found.push(`no package script ${script}`);
	}
	for (const formatter of ["biome", "prettier"])
		if (
			facts.formatters.length > 0 &&
			!facts.formatters.includes(formatter) &&
			new RegExp(`\\b${formatter}\\b`, "i").test(rule) &&
			!/\bnot\b|\bnever\b/i.test(rule)
		)
			found.push(`formatter is ${facts.formatters.join(", ")}, not ${formatter}`);
	return [...new Set(found)];
}

/**
 * Share of the reference rules a `coder` worker receives that it also receives from the handbook, through the
 * real worker compile and its 6000-character budget. Null when the compile is unavailable (run under tsx).
 */
async function workerCoverage(handbook, reference, tree) {
	if (reference === undefined) return null;
	let units;
	try {
		units = await import("../src/domains/context/handbook-units.ts");
	} catch {
		return null;
	}
	const worker = (text) => {
		const compiled = units.compileHandbook(text, "CLIO-CODER.md");
		if (!compiled) return text.slice(0, 6000);
		return units.selectWorkerHandbook([compiled], {
			audience: units.workerHandbookAudience("coder", null),
			cwd: tree,
			workingPaths: [],
			maxChars: 6000,
		}).text;
	};
	const wanted = handbookRules(worker(reference));
	const got = handbookRules(worker(handbook));
	if (wanted.length === 0) return null;
	return Number((wanted.filter((rule) => got.some((other) => restates(rule, other))).length / wanted.length).toFixed(3));
}

/** Score `handbook` against `reference` in `tree`. Pure: reads only the tree and the two texts. */
export async function scoreHandbook({ handbook, reference, tree }) {
	const rules = handbookRules(handbook);
	const vocabulary = checkerVocabulary(tree);
	const invalid = rules.filter((rule) => missingCitations(tree, rule).length > 0);
	const duplicates = [];
	rules.forEach((rule, index) => {
		for (const other of rules.slice(index + 1)) if (restates(rule, other)) duplicates.push([rule, other]);
	});
	const stale = rules.map((rule) => staleRuleId(rule, vocabulary)).filter((entry) => entry !== null);
	const facts = treeFacts(tree);
	const contradicted = rules
		.map((rule) => ({ rule, facts: contradictions(rule, facts) }))
		.filter((entry) => entry.facts.length > 0);
	const referenceRules = reference === undefined ? [] : handbookRules(reference);
	const covered = referenceRules.filter((wanted) =>
		rules.some((rule) => {
			if (restates(rule, wanted)) return true;
			const shared = citedPaths(rule).filter((path) => citedPaths(wanted).includes(path));
			return shared.length >= 2;
		}),
	);
	const recall = referenceRules.length === 0 ? null : covered.length / referenceRules.length;
	const chars = handbook.length;
	const terms = {
		recall: recall === null ? 0 : 100 * recall,
		invalid: -5 * invalid.length,
		stale: -5 * stale.length,
		contradicted: -5 * contradicted.length,
		duplicates: -2 * duplicates.length,
		size: -Math.max(0, (chars - 12000) / 400),
	};
	return {
		score: Number(
			Object.values(terms)
				.reduce((sum, term) => sum + term, 0)
				.toFixed(2),
		),
		terms,
		recall,
		rules: rules.length,
		chars,
		invalid: invalid.map((rule) => ({ rule, paths: missingCitations(tree, rule) })),
		duplicates,
		staleRuleIds: stale,
		contradicted,
		workerCoverage: await workerCoverage(handbook, reference, tree),
	};
}

// ---------------------------------------------------------------------------
// Replay: tasks from landed commits
// ---------------------------------------------------------------------------

function git(args, cwd = root) {
	const result = spawnSync("git", args, { cwd, encoding: "utf8", env: withoutRepositoryEnv(process.env) });
	if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.trim()}`);
	return result.stdout;
}

function withoutRepositoryEnv(env) {
	const copy = { ...env };
	for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_PREFIX"]) delete copy[key];
	return copy;
}

const TRAILER = /^[A-Z][\w-]*(?:-[\w]+)*: .+$/;
const PATHISH = /`[^`]*`|(?:[\w.@-]+\/)+[\w.*-]+|\b[\w-]+\.(?:[cm]?[jt]sx?|json|md|ya?ml|mjs)\b/g;

/**
 * A task from one commit: its message with trailers and file names removed, run at the parent, keyed by the
 * files the commit touched. Null when the message is mostly a file list, since the task would leak the key.
 */
export function replayTask(commit, message, files) {
	const lines = message.split("\n").filter((line) => !TRAILER.test(line.trim()));
	const words = lines.join(" ").split(/\s+/).filter(Boolean);
	const pathWords = words.filter((word) => /\/|\.(?:[cm]?[jt]sx?|json|md|ya?ml|mjs)\b/.test(word));
	if (words.length === 0 || pathWords.length / words.length > 0.4) return null;
	const prompt = lines
		.join("\n")
		.replace(PATHISH, "a file")
		.replace(/^(?:feat|fix|docs|refactor|test|chore|perf|build|ci)(?:\([^)]*\))?!?:\s*/i, "")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	return { id: `replay-${commit.slice(0, 9)}`, kind: "replay", at: `${commit}^`, prompt, key: [...files].sort() };
}

/** Share of the commit's files the run touched, less a tenth for each file the commit did not need. */
export function scoreReplay(key, touched) {
	const wanted = new Set(key);
	const hit = touched.filter((file) => wanted.has(file)).length;
	const extra = touched.filter((file) => !wanted.has(file)).length;
	if (wanted.size === 0) return 0;
	return Math.max(0, Number((hit / wanted.size - 0.1 * extra).toFixed(3)));
}

function replayTasks(commits) {
	return commits.map((commit) => {
		const message = git(["log", "-1", "--format=%B", commit]);
		const files = git(["show", "--name-only", "--format=", commit]).split("\n").filter(Boolean);
		const task = replayTask(git(["rev-parse", commit]).trim(), message, files);
		return task ?? { id: `replay-${commit}`, rejected: "message is mostly a file list" };
	});
}

// ---------------------------------------------------------------------------
// Live runs
// ---------------------------------------------------------------------------

/** Why the environment may not run live arms, or null. The real home and the host's `/tmp` are refused. */
export function unsafeEnvironment(env, home = homedir()) {
	const tmp = env.TMPDIR;
	if (!tmp || resolve(tmp) === "/tmp" || resolve(tmp).startsWith("/tmp/")) return "export TMPDIR to a scratch directory";
	const real = [
		join(home, ".config", "clio-coder"),
		join(home, ".local", "share", "clio-coder"),
		join(home, ".local", "state", "clio-coder"),
		join(home, ".cache", "clio-coder"),
		join(home, ".clio-coder"),
	];
	for (const key of [
		"CLIO_CODER_HOME",
		"CLIO_CODER_CONFIG_DIR",
		"CLIO_CODER_DATA_DIR",
		"CLIO_CODER_STATE_DIR",
		"CLIO_CODER_CACHE_DIR",
	]) {
		const value = env[key];
		if (value && real.some((path) => resolve(value) === path || resolve(value).startsWith(`${path}/`)))
			return `${key} points at the real Clio home`;
	}
	return null;
}

/** A task file: `{ id, prompt, mode: "read"|"edit", keywords?, files?, traps?, at?, key? }`. */
function loadTasks(dir) {
	return readdirSync(dir)
		.filter((name) => name.endsWith(".json"))
		.sort()
		.map((name) => JSON.parse(readFileSync(join(dir, name), "utf8")));
}

/** Keywords found in the answer and files in the diff, less traps; or the replay score. Normalized to 0..1. */
export function scoreRun(task, answer, touched) {
	if (Array.isArray(task.key)) return scoreReplay(task.key, touched);
	const text = answer.toLowerCase();
	const checks = [
		...(task.keywords ?? []).map((word) => text.includes(String(word).toLowerCase())),
		...(task.files ?? []).map((file) => touched.includes(file)),
	];
	const traps = (task.traps ?? []).filter((trap) => text.includes(String(trap).toLowerCase()) || touched.includes(trap));
	if (checks.length === 0) return 0;
	return Math.max(0, Number(((checks.filter(Boolean).length - traps.length) / checks.length).toFixed(3)));
}

/** Measured input and output tokens from an `agent_end` frame's usage. */
function tokenTotals(frame) {
	if (frame.type !== "agent_end") return 0;
	return (frame.usage?.input?.measured ?? 0) + (frame.usage?.output?.measured ?? 0);
}

function runOne({ arm, task, round, options, scratch }) {
	const dir = join(scratch, `${arm.name}-${task.id}-${round}`);
	git(["clone", "--quiet", "--no-local", root, dir]);
	git(["checkout", "--quiet", "--detach", task.at ?? "HEAD"], dir);
	for (const name of ["CLIO-CODER.md", "CLIO-DEV.md"]) rmSync(join(dir, name), { force: true });
	if (arm.file) writeFileSync(join(dir, "CLIO-CODER.md"), readFileSync(arm.file, "utf8"));
	git(
		[
			"-c",
			"user.name=bench",
			"-c",
			"user.email=bench@localhost",
			"commit",
			"--quiet",
			"-am",
			"bench arm",
			"--allow-empty",
		],
		dir,
	);
	const home = join(scratch, `home-${arm.name}-${task.id}-${round}`);
	const env = {
		...withoutRepositoryEnv(process.env),
		CLIO_CODER_HOME: home,
		CLIO_CODER_CONFIG_DIR: options.configDir ?? join(home, "config"),
		CLIO_CODER_DATA_DIR: join(home, "data"),
		CLIO_CODER_STATE_DIR: join(home, "state"),
		CLIO_CODER_CACHE_DIR: join(home, "cache"),
		CLIO_CODER_INTEROP_HOME: "none",
	};
	const argv = [
		options.clio,
		"run",
		"--json-events",
		"terminal",
		"--cwd",
		dir,
		"--timeout",
		String(options.timeout),
		...(options.target ? ["--target", options.target] : []),
		...(options.model ? ["--model", options.model] : []),
		...(options.thinking ? ["--thinking", options.thinking] : []),
		...(task.mode === "read" ? ["--read-only"] : ["--autonomy", "yolo"]),
		// The worker tier runs a coder worker, whose handbook is the 6000-character compile for the declared paths.
		...(options.tier === "worker" ? ["--agent", "coder"] : []),
		"--",
		options.tier === "worker"
			? [task.prompt, ...(task.key ?? task.files ?? []).map((path) => `@${path}`)].join("\n")
			: task.prompt,
	];
	const started = Date.now();
	const result = spawnSync(process.execPath, argv, { cwd: dir, env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
	const frames = (result.stdout ?? "")
		.split("\n")
		.filter((line) => line.startsWith("{"))
		.map((line) => {
			try {
				return JSON.parse(line);
			} catch {
				return null;
			}
		})
		.filter((frame) => frame !== null);
	const end = frames.findLast((frame) => frame.type === "turn_end") ?? {};
	const touched = git(["diff", "--name-only", "HEAD"], dir)
		.split("\n")
		.concat(git(["ls-files", "--others", "--exclude-standard"], dir).split("\n"))
		.concat(git(["log", "--format=", "--name-only", "HEAD@{1}..HEAD"], dir).split("\n"))
		.filter(Boolean);
	writeFileSync(join(scratch, `${arm.name}-${task.id}-${round}.jsonl`), result.stdout ?? "");
	return {
		arm: arm.name,
		task: task.id,
		round,
		exitCode: result.status,
		score: scoreRun(task, String(end.text ?? ""), [...new Set(touched)]),
		toolCalls: frames.reduce((sum, frame) => sum + (frame.observed?.toolCalls ?? 0), 0),
		tokens: frames.reduce((sum, frame) => sum + tokenTotals(frame), 0),
		seconds: Math.round((Date.now() - started) / 1000),
	};
}

/** Per arm totals and per task mean and range; a difference is called only when it holds in every round. */
export function summarize(rows) {
	const arms = [...new Set(rows.map((row) => row.arm))];
	const tasks = [...new Set(rows.map((row) => row.task))];
	const cell = (arm, task) => rows.filter((row) => row.arm === arm && row.task === task);
	const mean = (values) => (values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length);
	return {
		arms: Object.fromEntries(
			arms.map((arm) => {
				const own = rows.filter((row) => row.arm === arm);
				return [
					arm,
					{
						score: Number(tasks.reduce((sum, task) => sum + mean(cell(arm, task).map((row) => row.score)), 0).toFixed(3)),
						toolCalls: mean(own.map((row) => row.toolCalls ?? 0)),
						tokens: mean(own.map((row) => row.tokens)),
						seconds: mean(own.map((row) => row.seconds)),
						runs: own.length,
					},
				];
			}),
		),
		tasks: Object.fromEntries(
			tasks.map((task) => [
				task,
				Object.fromEntries(
					arms.map((arm) => {
						const scores = cell(arm, task).map((row) => row.score);
						return [arm, { mean: mean(scores), min: Math.min(...scores), max: Math.max(...scores) }];
					}),
				),
			]),
		),
	};
}

// ---------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------

function flags(argv) {
	const out = { arm: [] };
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index] ?? "";
		if (!arg.startsWith("--")) continue;
		const name = arg.slice(2);
		const next = argv[index + 1];
		const value = next === undefined || next.startsWith("--") ? true : next;
		if (value !== true) index += 1;
		if (name === "arm") out.arm.push(String(value));
		else out[name] = value;
	}
	return out;
}

const USAGE = `usage:
  node --import tsx scripts/handbook-bench.mjs score --handbook <file> [--reference <file>] [--tree <dir>]
  node scripts/handbook-bench.mjs replay --commits <sha,sha,...> [--out <dir>]
  node scripts/handbook-bench.mjs run --arm <name>=<file>|none ... --tasks <dir> [--rounds 2] [--max-runs 40]
      [--target <id>] [--model <id>] [--thinking <level>] [--config-dir <dir>] [--timeout 600] [--tier main|worker] [--yes]`;

async function main(argv) {
	const [command, ...rest] = argv;
	const options = flags(rest);
	if (command === "score") {
		if (typeof options.handbook !== "string") throw new Error(USAGE);
		const tree = resolve(typeof options.tree === "string" ? options.tree : root);
		const reference = typeof options.reference === "string" ? readFileSync(options.reference, "utf8") : undefined;
		if (reference !== undefined) {
			// The reference is the answer key; one with stale citations would reward stale rules.
			const own = await scoreHandbook({ handbook: reference, tree });
			if (own.invalid.length > 0 || own.staleRuleIds.length > 0 || own.contradicted.length > 0) {
				process.stdout.write(
					`${JSON.stringify({ refused: "reference is stale", invalid: own.invalid, staleRuleIds: own.staleRuleIds, contradicted: own.contradicted })}\n`,
				);
				return 2;
			}
		}
		const handbook = readFileSync(options.handbook, "utf8");
		process.stdout.write(`${JSON.stringify(await scoreHandbook({ handbook, reference, tree }), null, 2)}\n`);
		return 0;
	}
	if (command === "replay") {
		if (typeof options.commits !== "string") throw new Error(USAGE);
		const tasks = replayTasks(options.commits.split(",").filter(Boolean));
		if (typeof options.out === "string") {
			mkdirSync(options.out, { recursive: true });
			for (const task of tasks)
				if (!task.rejected)
					writeFileSync(join(options.out, `${task.id}.json`), `${JSON.stringify({ mode: "edit", ...task }, null, 2)}\n`);
		}
		process.stdout.write(`${JSON.stringify(tasks, null, 2)}\n`);
		return 0;
	}
	if (command === "run") {
		const unsafe = unsafeEnvironment(process.env);
		if (unsafe) {
			process.stderr.write(`handbook-bench: refusing to start: ${unsafe}\n`);
			return 2;
		}
		if (typeof options.tasks !== "string" || options.arm.length === 0) throw new Error(USAGE);
		const arms = options.arm.map((spec) => {
			const [name, file] = spec.includes("=") ? spec.split("=", 2) : [spec, undefined];
			return { name, file: file && file !== "none" ? resolve(file) : undefined };
		});
		const tasks = loadTasks(options.tasks);
		const rounds = Number(options.rounds ?? 2);
		const runs = arms.length * tasks.length * rounds;
		const maxRuns = Number(options["max-runs"] ?? 40);
		process.stderr.write(
			`handbook-bench: ${arms.length} arms x ${tasks.length} tasks x ${rounds} rounds = ${runs} runs\n`,
		);
		if (runs > maxRuns) {
			process.stderr.write(`handbook-bench: ${runs} runs exceed --max-runs ${maxRuns}\n`);
			return 2;
		}
		if (options.yes !== true) {
			process.stderr.write("handbook-bench: estimate only; pass --yes to run\n");
			return 0;
		}
		const scratch = mkdtempSync(join(process.env.TMPDIR ?? "", "handbook-bench-"));
		const settings = {
			clio: resolve(typeof options.clio === "string" ? options.clio : join(root, "dist", "cli", "index.js")),
			target: typeof options.target === "string" ? options.target : undefined,
			model: typeof options.model === "string" ? options.model : undefined,
			thinking: typeof options.thinking === "string" ? options.thinking : undefined,
			configDir: typeof options["config-dir"] === "string" ? resolve(options["config-dir"]) : undefined,
			timeout: Number(options.timeout ?? 600),
			tier: options.tier === "worker" ? "worker" : "main",
		};
		const rows = [];
		for (let round = 1; round <= rounds; round += 1)
			for (const task of tasks)
				for (const arm of arms) {
					const row = runOne({ arm, task, round, options: settings, scratch });
					rows.push(row);
					process.stdout.write(`${JSON.stringify(row)}\n`);
				}
		process.stdout.write(`${JSON.stringify({ summary: summarize(rows), scratch })}\n`);
		return 0;
	}
	process.stderr.write(`${USAGE}\n`);
	return 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	process.exitCode = await main(process.argv.slice(2));
}

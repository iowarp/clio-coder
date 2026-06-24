#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const DEFAULT_PATTERNS = ["tests/smoke/**/*.test.ts", "tests/boundaries/**/*.test.ts"];

function usage() {
	process.stderr.write(
		[
			"usage: node tests/harness/repeat-tests.mjs [--runs N] [--seed text] [-- pattern...]",
			"",
			"Runs a deterministic shuffled test lane repeatedly. Defaults to smoke and boundaries.",
			"",
		].join("\n"),
	);
}

function parseArgs(argv) {
	const out = { runs: 2, seed: "clio-v026-repeat", patterns: [] };
	let positional = false;
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--") {
			positional = true;
			continue;
		}
		if (!positional && arg === "--help") {
			usage();
			process.exit(0);
		}
		if (!positional && arg === "--runs") {
			const value = argv[index + 1];
			index += 1;
			const parsed = Number.parseInt(value ?? "", 10);
			if (!Number.isInteger(parsed) || parsed <= 0) throw new Error("--runs requires a positive integer");
			out.runs = parsed;
			continue;
		}
		if (!positional && arg === "--seed") {
			const value = argv[index + 1];
			index += 1;
			if (!value) throw new Error("--seed requires text");
			out.seed = value;
			continue;
		}
		out.patterns.push(arg);
	}
	if (out.patterns.length === 0) out.patterns = [...DEFAULT_PATTERNS];
	return out;
}

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

function hashSeed(text) {
	let hash = 2166136261;
	for (let index = 0; index < text.length; index += 1) {
		hash ^= text.charCodeAt(index);
		hash = Math.imul(hash, 16777619);
	}
	return hash >>> 0;
}

function makeRandom(seedText) {
	let state = hashSeed(seedText) || 1;
	return () => {
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		return (state >>> 0) / 0x100000000;
	};
}

function shuffled(files, seed) {
	const out = [...files];
	const rand = makeRandom(seed);
	for (let index = out.length - 1; index > 0; index -= 1) {
		const swap = Math.floor(rand() * (index + 1));
		[out[index], out[swap]] = [out[swap], out[index]];
	}
	return out;
}

function runOnce(files, seed, index, total) {
	const order = shuffled(files, seed);
	process.stderr.write(`repeat test run ${index}/${total}, seed=${seed}, files=${order.length}\n`);
	const result = spawnSync(process.execPath, ["--import", "tsx", "--test", "--test-concurrency=1", ...order], {
		cwd: REPO_ROOT,
		stdio: "inherit",
		env: process.env,
	});
	return result.status ?? 1;
}

try {
	const args = parseArgs(process.argv.slice(2));
	const files = expandPatterns(args.patterns);
	if (files.length === 0) throw new Error(`no test files matched: ${args.patterns.join(", ")}`);
	for (let run = 1; run <= args.runs; run += 1) {
		const code = runOnce(files, `${args.seed}:${run}`, run, args.runs);
		if (code !== 0) process.exit(code);
	}
} catch (error) {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	usage();
	process.exit(2);
}

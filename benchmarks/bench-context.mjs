#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const DEFAULT_OUT = ".clio-benchmark/context";
const DEFAULT_CORPUS = [
	["rendergit", "~/tmp/clio-ctxtest/rendergit", "python"],
	["quipslop", "~/tmp/clio-ctxtest/quipslop", "typescript"],
	["mac-mini-agent", "~/tmp/clio-ctxtest/mac-mini-agent", "python"],
	["clio-coder", ROOT, "typescript"],
	["once", "~/tools/once", "go"],
	["opentui", "~/tools/opentui", "typescript"],
];

const SOURCE_EXTENSIONS = new Map([
	[".ts", "typescript"],
	[".tsx", "typescript"],
	[".mts", "typescript"],
	[".cts", "typescript"],
	[".js", "javascript"],
	[".jsx", "javascript"],
	[".mjs", "javascript"],
	[".cjs", "javascript"],
	[".py", "python"],
	[".pyw", "python"],
	[".rs", "rust"],
	[".go", "go"],
	[".c", "c"],
	[".h", "c"],
	[".cc", "c++"],
	[".cpp", "c++"],
	[".cxx", "c++"],
	[".hpp", "c++"],
	[".hh", "c++"],
	[".hxx", "c++"],
	[".java", "java"],
	[".rb", "ruby"],
]);
const EXCLUDED_DIRS = new Set([
	".git",
	".clio",
	"node_modules",
	"dist",
	"build",
	".venv",
	"venv",
	"__pycache__",
	"target",
	"vendor",
]);

function fail(message) {
	console.error(`bench-context: ${message}`);
	process.exit(2);
}

function usage(code = 0) {
	console.log(`Usage: node benchmarks/bench-context.mjs [--after <cli.js>] [--before <cli.js>] [--out <dir>]

Copies the context benchmark corpus to temp directories and measures codewiki coverage,
determinism, digest size, and local nav latency. A CLI may be a built dist JS file or an
executable. If --before is supplied, the report includes before/after deltas.`);
	process.exit(code);
}

function parseArgs(argv) {
	const out = { after: join(ROOT, "dist", "cli", "index.js"), before: "", outDir: DEFAULT_OUT };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const need = () => argv[++i] ?? fail(`${arg} requires a value`);
		if (arg === "--after") out.after = need();
		else if (arg === "--before") out.before = need();
		else if (arg === "--out") out.outDir = need();
		else if (arg === "--help" || arg === "-h") usage(0);
		else fail(`unknown flag: ${arg}`);
	}
	return out;
}

function expandHome(path) {
	if (path === "~") return process.env.HOME ?? path;
	if (path.startsWith("~/")) return join(process.env.HOME ?? "", path.slice(2));
	return path;
}

function runCli(cli, args, cwd) {
	const command = cli.endsWith(".js") ? process.execPath : cli;
	const finalArgs = cli.endsWith(".js") ? [cli, ...args] : args;
	return new Promise((resolve) => {
		const child = spawn(command, finalArgs, {
			cwd,
			env: { ...process.env, CLIO_NO_UPDATE_NOTIFIER: "1" },
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
		child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
	});
}

function extname(path) {
	const name = basename(path);
	const index = name.lastIndexOf(".");
	return index === -1 ? "" : name.slice(index);
}

async function collectSourceFiles(root) {
	const { readdir } = await import("node:fs/promises");
	const out = [];
	async function visit(dir) {
		let entries;
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (entry.isDirectory()) {
				if (EXCLUDED_DIRS.has(entry.name)) continue;
				await visit(join(dir, entry.name));
				continue;
			}
			if (!entry.isFile()) continue;
			const full = join(dir, entry.name);
			const rel = full
				.slice(root.length + 1)
				.split("\\")
				.join("/");
			if (rel.endsWith(".d.ts")) continue;
			const lang = SOURCE_EXTENSIONS.get(extname(rel));
			if (lang) out.push({ path: rel, lang });
		}
	}
	await visit(root);
	out.sort((a, b) => a.path.localeCompare(b.path));
	return out;
}

function copyCorpus(src, parent, name) {
	const dest = join(parent, name);
	cpSync(src, dest, {
		recursive: true,
		dereference: false,
		filter: (path) => {
			const rel = path.slice(src.length).split("\\").join("/");
			return !rel.split("/").some((part) => EXCLUDED_DIRS.has(part));
		},
	});
	return dest;
}

function readCodewiki(cwd) {
	const path = join(cwd, ".clio", "codewiki.json");
	if (!existsSync(path)) return null;
	return JSON.parse(readFileSync(path, "utf8"));
}

function normalizeStructural(codewiki) {
	if (!codewiki) return null;
	if (codewiki.version === 3) {
		return {
			version: 3,
			language: codewiki.language,
			files: [...(codewiki.files ?? [])].sort((a, b) => a.path.localeCompare(b.path)),
			symbols: [...(codewiki.symbols ?? [])].sort(
				(a, b) => a.fileId.localeCompare(b.fileId) || a.line - b.line || a.name.localeCompare(b.name),
			),
			edges: [...(codewiki.edges ?? [])].sort((a, b) => {
				const targetA = a.toFileId ?? `~${a.externalModule ?? ""}`;
				const targetB = b.toFileId ?? `~${b.externalModule ?? ""}`;
				return a.fileId.localeCompare(b.fileId) || targetA.localeCompare(targetB);
			}),
		};
	}
	if (codewiki.version === 2) {
		return {
			version: 2,
			language: codewiki.language,
			entries: [...(codewiki.entries ?? [])].sort((a, b) => a.path.localeCompare(b.path)),
		};
	}
	return codewiki;
}

function hashJson(value) {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function approxTokens(text) {
	return Math.ceil(text.length / 4);
}

function digestFromCodewiki(codewiki) {
	if (!codewiki) return "";
	if (codewiki.version === 2) {
		const entries = codewiki.entries ?? [];
		return JSON.stringify({
			version: 2,
			language: codewiki.language,
			moduleCount: entries.length,
			entryPoints: entries
				.filter((entry) => entry.kind === "entry-point")
				.map((entry) => entry.path)
				.slice(0, 12),
			topPaths: entries.map((entry) => entry.path).slice(0, 80),
		});
	}
	const files = (codewiki.files ?? [])
		.filter((file) => file.lang !== "config")
		.sort((a, b) => a.path.localeCompare(b.path));
	const fileById = new Map((codewiki.files ?? []).map((file) => [file.id, file]));
	const lines = [
		`codewiki v3 language=${codewiki.language} files=${files.length} symbols=${codewiki.symbols?.length ?? 0} edges=${codewiki.edges?.length ?? 0}`,
		"entry points:",
		...files
			.filter((file) => file.role === "entry")
			.slice(0, 12)
			.map((file) => `- ${file.path}`),
		"key symbols:",
		...(codewiki.symbols ?? []).slice(0, 80).map((symbol) => {
			const file = fileById.get(symbol.fileId);
			return `- ${symbol.name} ${symbol.kind} ${file?.path ?? symbol.fileId}:${symbol.line}`;
		}),
	];
	return lines.join("\n");
}

async function indexOnce(cli, repo) {
	let mode = "context-index";
	let result = await runCli(cli, ["context-index", "--json"], repo);
	if (result.code !== 0) {
		mode = "context-init";
		result = await runCli(cli, ["context-init", "--heuristic", "--yes"], repo);
		if (result.code !== 0)
			throw new Error(`index failed (${mode})\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
	}
	const codewiki = readCodewiki(repo);
	const structural = normalizeStructural(codewiki);
	return {
		mode,
		stdout: result.stdout,
		stderr: result.stderr,
		codewiki,
		structuralHash: hashJson(structural),
		digestTokens: approxTokens(digestFromCodewiki(codewiki)),
		handoffExists: existsSync(join(repo, ".clio", "handoffs")),
	};
}

function fileCount(codewiki) {
	if (!codewiki) return 0;
	if (codewiki.version === 3) return (codewiki.files ?? []).filter((file) => file.lang !== "config").length;
	if (codewiki.version === 2) return (codewiki.entries ?? []).length;
	return 0;
}

function navLatency(codewiki, iterations = 200) {
	if (!codewiki || codewiki.version !== 3) return null;
	const files = codewiki.files ?? [];
	const symbols = codewiki.symbols ?? [];
	const edges = codewiki.edges ?? [];
	const filesByPath = new Map(files.map((file) => [file.path, file]));
	const symbolToFileIds = new Map();
	const depsByFileId = new Map();
	const dependentsByFileId = new Map();
	for (const symbol of symbols) {
		const ids = symbolToFileIds.get(symbol.name) ?? [];
		if (!ids.includes(symbol.fileId)) ids.push(symbol.fileId);
		symbolToFileIds.set(symbol.name, ids);
	}
	for (const edge of edges) {
		const deps = depsByFileId.get(edge.fileId) ?? [];
		deps.push(edge.toFileId ?? edge.externalModule ?? "");
		depsByFileId.set(edge.fileId, deps);
		if (edge.toFileId) {
			const importers = dependentsByFileId.get(edge.toFileId) ?? [];
			importers.push(edge.fileId);
			dependentsByFileId.set(edge.toFileId, importers);
		}
	}
	const paths = files.map((file) => file.path);
	const symbolQuery = symbols[0]?.name ?? "";
	const pathQuery = paths[0] ?? "";
	const entryQuery = files.find((file) => file.role === "entry")?.path ?? pathQuery;
	const samples = [];
	const run = (mode, fn) => {
		for (let i = 0; i < iterations; i++) {
			const start = process.hrtime.bigint();
			fn();
			const ms = Number(process.hrtime.bigint() - start) / 1e6;
			samples.push({ mode, ms });
		}
	};
	run("symbol", () => symbolToFileIds.get(symbolQuery) ?? []);
	run("path", () => filesByPath.get(pathQuery));
	run("entries", () => files.filter((file) => file.role === "entry").slice(0, 25));
	run("outline", () => symbols.filter((symbol) => symbol.fileId === filesByPath.get(entryQuery)?.id));
	run("deps", () => depsByFileId.get(filesByPath.get(entryQuery)?.id ?? "") ?? []);
	run("dependents", () => dependentsByFileId.get(filesByPath.get(entryQuery)?.id ?? "") ?? []);
	const values = samples.map((sample) => sample.ms).sort((a, b) => a - b);
	const percentile = (p) => values[Math.min(values.length - 1, Math.floor((values.length - 1) * p))] ?? 0;
	return {
		iterations,
		p50Ms: percentile(0.5),
		p99Ms: percentile(0.99),
		paths: paths.length,
		symbols: symbols.length,
	};
}

async function measureCli(cli, corpus) {
	const temp = mkdtempSync(join(tmpdir(), "clio-context-bench-"));
	const results = [];
	try {
		for (const [name, rawPath, expectedLanguage] of corpus) {
			const src = resolve(expandHome(rawPath));
			if (!existsSync(src)) fail(`missing corpus path ${rawPath}`);
			const repo = copyCorpus(src, temp, name);
			const sources = await collectSourceFiles(repo);
			const first = await indexOnce(cli, repo);
			const second = await indexOnce(cli, repo);
			const indexed = fileCount(second.codewiki);
			const coverage = sources.length === 0 ? 1 : indexed / sources.length;
			const language = second.codewiki?.language ?? "unknown";
			const assertions = {
				hasFiles: indexed > 0,
				coverageOk: sources.length === 0 || coverage >= 0.95,
				languageOk:
					expectedLanguage === "typescript"
						? language === "typescript" || language === "javascript"
						: language === expectedLanguage,
				deterministic: first.structuralHash === second.structuralHash,
				noHandoffFromContextInit: !second.handoffExists,
			};
			results.push({
				name,
				sourcePath: src,
				expectedLanguage,
				mode: second.mode,
				sourceFiles: sources.length,
				indexedFiles: indexed,
				coverage,
				language,
				structuralHash: second.structuralHash,
				digestTokens: second.digestTokens,
				navLatency: name === "opentui" ? navLatency(second.codewiki) : null,
				assertions,
			});
		}
	} finally {
		rmSync(temp, { recursive: true, force: true });
	}
	return results;
}

function compare(before, after) {
	const byName = new Map(before.map((item) => [item.name, item]));
	return after.map((item) => {
		const prev = byName.get(item.name);
		return {
			name: item.name,
			coverageDelta: prev ? item.coverage - prev.coverage : null,
			indexedFilesDelta: prev ? item.indexedFiles - prev.indexedFiles : null,
			digestTokensDelta: prev ? item.digestTokens - prev.digestTokens : null,
			languageBefore: prev?.language ?? null,
			languageAfter: item.language,
		};
	});
}

async function main() {
	const opts = parseArgs(process.argv.slice(2));
	const corpus = DEFAULT_CORPUS;
	const after = await measureCli(resolve(opts.after), corpus);
	const before = opts.before ? await measureCli(resolve(opts.before), corpus) : [];
	const report = {
		generatedAt: new Date().toISOString(),
		corpus: corpus.map(([name, path, expectedLanguage]) => ({ name, path, expectedLanguage })),
		afterCli: resolve(opts.after),
		...(opts.before ? { beforeCli: resolve(opts.before) } : {}),
		after,
		...(before.length > 0 ? { before, delta: compare(before, after) } : {}),
	};
	mkdirSync(opts.outDir, { recursive: true });
	const outPath = join(opts.outDir, `bench-context-${Date.now()}.json`);
	writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
	console.log(`bench-context wrote ${outPath}`);
	for (const row of after) {
		const status = Object.values(row.assertions).every(Boolean) ? "ok" : "FAIL";
		console.log(
			`${status} ${row.name}: lang=${row.language} files=${row.indexedFiles}/${row.sourceFiles} coverage=${(row.coverage * 100).toFixed(1)} hash=${row.structuralHash.slice(0, 12)} digestTokens=${row.digestTokens}`,
		);
	}
	const failed = after.filter((row) => !Object.values(row.assertions).every(Boolean));
	if (failed.length > 0) {
		console.error(`bench-context failed assertions for ${failed.map((row) => row.name).join(", ")}`);
		process.exitCode = 1;
	}
}

main().catch((err) => {
	console.error(err instanceof Error ? err.stack || err.message : String(err));
	process.exitCode = 1;
});

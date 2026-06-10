#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const DEFAULT_OUT = ".clio-benchmark";
const DEFAULT_MATRIX = {
	thinking: ["off", "low", "medium"],
	contextWindow: [null],
	sampling: [
		{ name: "catalog", temperature: null, topP: null, topK: null, presencePenalty: null, repeatPenalty: null },
		{ name: "precise", temperature: 0.2, topP: 0.9, topK: 20, presencePenalty: 0, repeatPenalty: 1 },
		{ name: "balanced", temperature: 0.6, topP: 0.95, topK: 20, presencePenalty: 0, repeatPenalty: 1 },
	],
	kvCache: ["server-default"],
	weightQuantization: ["server-loaded"],
};

function parseArgs(argv) {
	const out = { outDir: DEFAULT_OUT, limit: 0, target: "", models: [], matrix: "", clio: "" };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		const need = () => argv[++i] ?? fail(`${a} requires a value`);
		if (a === "--out") out.outDir = need();
		else if (a === "--target") out.target = need();
		else if (a === "--model") out.models.push(need());
		else if (a === "--limit") out.limit = Number(need()) || 0;
		else if (a === "--matrix") out.matrix = need();
		else if (a === "--clio") out.clio = need();
		else if (a === "--help" || a === "-h") usage(0);
		else fail(`unknown flag: ${a}`);
	}
	return out;
}
function fail(msg) {
	console.error(`benchmark: ${msg}`);
	process.exit(2);
}
function usage(code) {
	console.log(
		`Usage: node benchmarks/clio-model-suite.mjs [--target id] [--model id ...] [--limit n] [--matrix file.json] [--out .clio-benchmark]\n\nRuns clio headless for each model/config combo, asks it to build a single-file website, and statically scores app.html outputs. Sampler fields are passed to clio run as per-request overrides; context and quantization fields are recorded as run metadata.`,
	);
	process.exit(code);
}

function run(cmd, args, opts = {}) {
	return new Promise((resolve) => {
		const p = spawn(cmd, args, {
			cwd: ROOT,
			env: process.env,
			stdio: ["ignore", "pipe", "pipe"],
			...opts,
		});
		let stdout = "",
			stderr = "";
		p.stdout.on("data", (b) => (stdout += b));
		p.stderr.on("data", (b) => (stderr += b));
		p.on("close", (code) => resolve({ code, stdout, stderr }));
	});
}

async function clioCmd(args, clio) {
	if (clio) return run(clio, args);
	const dist = join(ROOT, "dist/cli/index.js");
	if (existsSync(dist)) return run(process.execPath, [dist, ...args]);
	return run("npx", ["tsx", "src/cli/index.ts", ...args]);
}

async function discover(opts) {
	const r = await clioCmd(["models", "--probe", "--json"], opts.clio);
	if (r.code !== 0) fail(`clio models failed\n${r.stderr}`);
	const rows = JSON.parse(r.stdout);
	let candidates = rows.filter((r) => r.modelId && r.modelId !== "(no models)");
	if (opts.target) candidates = candidates.filter((r) => r.targetId === opts.target);
	if (opts.models.length) candidates = candidates.filter((r) => opts.models.includes(r.modelId));
	if (opts.limit > 0) candidates = candidates.slice(0, opts.limit);
	return candidates;
}

function loadMatrix(path) {
	if (!path) return DEFAULT_MATRIX;
	return JSON.parse(readFileSync(path, "utf8"));
}
function combos(matrix) {
	const out = [];
	for (const thinking of matrix.thinking ?? ["off"]) {
		for (const contextWindow of matrix.contextWindow ?? [null]) {
			for (const sampling of matrix.sampling ?? [{ name: "catalog" }]) {
				for (const weightQuantization of matrix.weightQuantization ?? ["server-loaded"]) {
					for (const kvCache of matrix.kvCache ?? ["server-default"])
						out.push({ thinking, contextWindow, sampling, weightQuantization, kvCache });
				}
			}
		}
	}
	return out;
}

function safeName(s) {
	return s.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 120);
}
function taskPrompt(runDir, combo) {
	return `You are being benchmarked directly. Do not use dispatch, subagents, read_skill, external web access, or any delegation. Use only local read/list/write/edit style tools yourself. Hard limit: at most 4 inspection tool calls, then you must call write. Read only README.md and docs/model-catalog.md (small excerpts are enough), optionally list assets once, then create ${runDir}/app.html with the write tool. Requirements for app.html: standalone HTML with embedded CSS, responsive layout, hero, model-management section, benchmark section, docs links, accessibility labels, no external network assets. Current benchmark config metadata: ${JSON.stringify(combo)}. Do not modify files outside ${runDir}.`;
}

function scoreHtml(file) {
	if (!existsSync(file)) return { total: 0, max: 100, checks: { exists: 0 }, notes: ["app.html missing"] };
	const html = readFileSync(file, "utf8");
	const checks = {
		exists: 10,
		doctype: /^\s*<!doctype html>/i.test(html) ? 5 : 0,
		title: /<title>[^<]{8,}<\/title>/i.test(html) ? 5 : 0,
		embeddedCss: /<style[\s>]/i.test(html) && html.length > 4000 ? 10 : 0,
		responsive: /@media|viewport/i.test(html) ? 10 : 0,
		clioContent: /Clio Coder/i.test(html) && /model/i.test(html) && /benchmark/i.test(html) ? 15 : 0,
		sections: (html.match(/<section\b/gi)?.length ?? 0) >= 4 ? 10 : 0,
		accessibility: /aria-label|alt=|role=/i.test(html) ? 10 : 0,
		navigation: /<nav\b/i.test(html) && /href="#/i.test(html) ? 10 : 0,
		visualPolish: /gradient|box-shadow|border-radius|grid|backdrop-filter/i.test(html) ? 10 : 0,
		noExternalAssets: !/https?:\/\//i.test(html) ? 5 : 0,
	};
	return { total: Object.values(checks).reduce((a, b) => a + b, 0), max: 100, checks, bytes: html.length };
}

function samplingArgs(sampling) {
	const args = [];
	const push = (flag, value) => {
		if (typeof value === "number" && Number.isFinite(value)) args.push(flag, String(value));
	};
	push("--temperature", sampling?.temperature);
	push("--top-p", sampling?.topP);
	push("--top-k", sampling?.topK);
	push("--min-p", sampling?.minP);
	push("--presence-penalty", sampling?.presencePenalty);
	push("--frequency-penalty", sampling?.frequencyPenalty);
	push("--repeat-penalty", sampling?.repeatPenalty);
	return args;
}

function walk(value, visit) {
	if (value === null || value === undefined) return;
	visit(value);
	if (Array.isArray(value)) {
		for (const item of value) walk(item, visit);
	} else if (typeof value === "object") {
		for (const item of Object.values(value)) walk(item, visit);
	}
}

function extractUsageFromJsonl(stdout) {
	const totals = { input: 0, output: 0, reasoning: 0, total: 0, cacheRead: 0, cacheWrite: 0, apiCalls: 0 };
	let firstDeltaAt = null;
	let agentStartedAt = null;
	let agentEndedAt = null;
	let lineNo = 0;
	const seenResponses = new Set();
	const lines = stdout.split(/\r?\n/).filter(Boolean);
	for (const line of lines) {
		lineNo += 1;
		let event;
		try {
			event = JSON.parse(line);
		} catch {
			continue;
		}
		if (event.type === "agent_start" && agentStartedAt === null) agentStartedAt = event.timestamp ?? null;
		if (event.type === "agent_end") agentEndedAt = event.timestamp ?? null;
		if (event.type === "message_update" && firstDeltaAt === null) firstDeltaAt = event.timestamp ?? null;
		walk(event, (node) => {
			if (!node || typeof node !== "object" || Array.isArray(node)) return;
			const usage = node.usage;
			if (!usage || typeof usage !== "object") return;
			const responseKey = node.responseId ?? node.id ?? null;
			if (!responseKey && event.type !== "message_end" && event.type !== "agent_end") return;
			const input = usage.input ?? usage.prompt_tokens ?? 0;
			const output = usage.output ?? usage.completion_tokens ?? 0;
			const total = usage.totalTokens ?? usage.total_tokens ?? input + output;
			const reasoning = usage.reasoning ?? usage.reasoningTokens ?? usage.completion_tokens_details?.reasoning_tokens ?? 0;
			if (input || output || total || reasoning) {
				const key = responseKey ?? `${lineNo}:${event.type}`;
				if (seenResponses.has(key)) return;
				seenResponses.add(key);
				totals.input += Number(input) || 0;
				totals.output += Number(output) || 0;
				totals.total += Number(total) || 0;
				totals.reasoning += Number(reasoning) || 0;
				totals.cacheRead += Number(usage.cacheRead) || 0;
				totals.cacheWrite += Number(usage.cacheWrite) || 0;
				totals.apiCalls += 1;
			}
		});
	}
	return { ...totals, firstDeltaAt, agentStartedAt, agentEndedAt };
}

async function main() {
	const opts = parseArgs(process.argv.slice(2));
	const outDir = resolve(ROOT, opts.outDir);
	mkdirSync(outDir, { recursive: true });
	const matrix = loadMatrix(opts.matrix);
	const models = await discover(opts);
	const allCombos = combos(matrix);
	const report = { startedAt: new Date().toISOString(), outDir, matrix, runs: [] };
	let previous = null;
	for (const model of models) {
		for (const combo of allCombos) {
			if (previous) previous.score = scoreHtml(join(previous.runDir, "app.html"));
			const id = `${safeName(model.targetId)}__${safeName(basename(model.modelId))}__${safeName(combo.thinking)}__${safeName(combo.sampling?.name ?? "sampling")}`;
			const runDir = join(outDir, id);
			mkdirSync(runDir, { recursive: true });
			writeFileSync(join(runDir, "config.json"), JSON.stringify({ model, combo }, null, 2));
			const started = Date.now();
			const r = await clioCmd(
				[
					"run",
					"--json",
					"--no-skills",
					"--target",
					model.targetId,
					"--model",
					model.modelId,
					"--thinking",
					combo.thinking,
					...samplingArgs(combo.sampling),
					taskPrompt(runDir, combo),
				],
				opts.clio,
			);
			const durationMs = Date.now() - started;
			const usage = extractUsageFromJsonl(r.stdout);
			const outputTokens = usage.output + usage.reasoning;
			const row = {
				model,
				combo,
				runDir,
				exitCode: r.code,
				durationMs,
				metrics: {
					...usage,
					wallTokensPerSecond: outputTokens > 0 ? outputTokens / (durationMs / 1000) : 0,
				},
			};
			writeFileSync(join(runDir, "stdout.txt"), r.stdout);
			writeFileSync(join(runDir, "stderr.txt"), r.stderr);
			report.runs.push(row);
			previous = row;
			writeFileSync(join(outDir, "report.json"), JSON.stringify(report, null, 2));
		}
	}
	if (previous) previous.score = scoreHtml(join(previous.runDir, "app.html"));
	report.finishedAt = new Date().toISOString();
	report.runs.sort((a, b) => (b.score?.total ?? -1) - (a.score?.total ?? -1));
	writeFileSync(join(outDir, "report.json"), JSON.stringify(report, null, 2));
	console.log(`benchmark complete: ${join(outDir, "report.json")}`);
	console.table(
		report.runs.slice(0, 10).map((r) => ({
			score: r.score?.total ?? 0,
			target: r.model.targetId,
			model: r.model.modelId.slice(0, 40),
			thinking: r.combo.thinking,
			sampler: r.combo.sampling?.name,
			outTok: r.metrics?.output ?? 0,
			reasonTok: r.metrics?.reasoning ?? 0,
			tokSec: Math.round((r.metrics?.wallTokensPerSecond ?? 0) * 10) / 10,
			exit: r.exitCode,
		})),
	);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});

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
	const out = { outDir: DEFAULT_OUT, limit: 0, target: "", models: [], matrix: "", clio: "", cwd: ROOT };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		const need = () => argv[++i] ?? fail(`${a} requires a value`);
		if (a === "--out") out.outDir = need();
		else if (a === "--target") out.target = need();
		else if (a === "--model") out.models.push(need());
		else if (a === "--limit") out.limit = Number(need()) || 0;
		else if (a === "--matrix") out.matrix = need();
		else if (a === "--clio") out.clio = need();
		// --clio-entry mirrors live-turns.mjs's flag name; both point at the CLI to run.
		else if (a === "--clio-entry") out.clio = need();
		// --cwd points at the repo the benchmarked agent operates in (default: this
		// checkout). The scored task is a fixed, repo-independent reference build
		// (see taskPrompt); --cwd only changes the file tree the model navigates and
		// where artifacts are written, mirroring live-turns.mjs's --cwd.
		else if (a === "--cwd") out.cwd = need();
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
		`Usage: node benchmarks/clio-model-suite.mjs [--target id] [--model id ...] [--limit n] [--matrix file.json] [--out .clio-benchmark] [--cwd repo] [--clio-entry path]\n\nRuns clio headless for each model/config combo, asks it to build a single-file website, and statically scores app.html outputs. Sampler fields are passed to clio run as per-request overrides; context and quantization fields are recorded as run metadata. --cwd runs the agent in an arbitrary repo (default: this checkout); the scored build task is fixed and repo-independent, so --cwd only varies the file tree the model navigates and where artifacts land. --clio-entry (alias --clio) selects the CLI to run.`,
	);
	process.exit(code);
}

// firstTokenMarker: when set, run() timestamps the first stdout chunk in which
// the marker appears, giving a wall-clock time-to-first-token (ttft) from
// process spawn. clio's --json stream carries no per-event timestamps (only the
// session header does), so ttft cannot be reconstructed from event times after
// the fact; measuring it live at the stream is the reliable path. Note this
// wall-clock ttft includes queue/model-load latency on a cold model swap; the
// per-run `coldStart` flag records whether the model was already resident.
function run(cmd, args, opts = {}) {
	const { firstTokenMarker = null, ...spawnOpts } = opts;
	return new Promise((resolve) => {
		const startedAt = Date.now();
		const p = spawn(cmd, args, {
			cwd: ROOT,
			env: process.env,
			stdio: ["ignore", "pipe", "pipe"],
			...spawnOpts,
		});
		let stdout = "",
			stderr = "",
			firstTokenMs = null;
		p.stdout.on("data", (b) => {
			stdout += b;
			if (firstTokenMarker && firstTokenMs === null && stdout.includes(firstTokenMarker)) {
				firstTokenMs = Date.now() - startedAt;
			}
		});
		p.stderr.on("data", (b) => (stderr += b));
		p.on("close", (code) => resolve({ code, stdout, stderr, firstTokenMs }));
	});
}

async function clioCmd(args, clio, opts = {}) {
	if (clio) return run(clio, args, opts);
	const dist = join(ROOT, "dist/cli/index.js");
	if (existsSync(dist)) return run(process.execPath, [dist, ...args], opts);
	// Absolute src path so the tsx fallback survives a non-ROOT --cwd.
	return run("npx", ["tsx", join(ROOT, "src/cli/index.ts"), ...args], opts);
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
// Fixed, repo-independent reference task. The facts the page needs are supplied
// inline, so the same scored build runs identically in any --cwd (this checkout
// or a foreign clone like graphify); the inspection budget still exercises the
// read/list tool loop against whatever file tree the model is dropped into,
// without depending on clio-coder-specific doc paths that a foreign repo lacks.
function taskPrompt(runDir, combo) {
	return `You are being benchmarked directly. Do not use dispatch, subagents, read_skill, external web access, or any delegation. Use only local read/list/write/edit style tools yourself. Hard limit: at most 4 inspection tool calls (you may read README.md if it exists and list the directory once to orient yourself), then you must call write to create ${runDir}/app.html. Build a standalone marketing landing page for "Clio Coder", a local-first AI coding CLI that runs open-weight models on your own hardware, manages model targets, and benchmarks them. Requirements for app.html: standalone HTML with embedded CSS, responsive layout, a hero, a model-management section, a benchmark section, docs links, accessibility labels, and no external network assets. Current benchmark config metadata: ${JSON.stringify(combo)}. Do not modify files outside ${runDir}.`;
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

// MTP / speculative-decoding acceptance rate is deliberately NOT captured here.
// It is a llama.cpp server-side counter (n_drafted / n_accepted), not present in
// clio's --json event stream, and mini fronts its models with a llama-swap
// router ("role":"router", max_instances 1) so /metrics is per-instance behind
// the swap and only meaningful for the MTP-tagged models. It does not gate the
// matrix analysis (score, tok/s, ttft, exit are the comparison signals), so per
// the battletest backlog it is noted and left out rather than bolted on here.
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
	const cwd = resolve(opts.cwd);
	// Resolve the out dir against --cwd so an absolute --out is honored verbatim
	// and the default lands inside the repo the agent writes to (keeping app.html
	// within the model's workspace). Default --cwd is ROOT, so the historical
	// ROOT/.clio-benchmark layout is unchanged when --cwd is not passed.
	const outDir = resolve(cwd, opts.outDir);
	mkdirSync(outDir, { recursive: true });
	const matrix = loadMatrix(opts.matrix);
	const models = await discover(opts);
	const allCombos = combos(matrix);
	const report = { startedAt: new Date().toISOString(), cwd, outDir, matrix, runs: [] };
	let previous = null;
	let lastModelId = null;
	for (const model of models) {
		for (const combo of allCombos) {
			if (previous) previous.score = scoreHtml(join(previous.runDir, "app.html"));
			const id = `${safeName(model.targetId)}__${safeName(basename(model.modelId))}__${safeName(combo.thinking)}__${safeName(combo.sampling?.name ?? "sampling")}`;
			const runDir = join(outDir, id);
			mkdirSync(runDir, { recursive: true });
			writeFileSync(join(runDir, "config.json"), JSON.stringify({ model, combo }, null, 2));
			// A model swap on mini's single-instance router evicts the prior model,
			// so the first combo per model pays the cold model-load latency in ttft.
			const coldStart = model.modelId !== lastModelId;
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
				{ cwd, firstTokenMarker: '"text_delta"' },
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
				coldStart,
				metrics: {
					...usage,
					ttftMs: r.firstTokenMs,
					wallTokensPerSecond: outputTokens > 0 ? outputTokens / (durationMs / 1000) : 0,
				},
			};
			writeFileSync(join(runDir, "stdout.txt"), r.stdout);
			writeFileSync(join(runDir, "stderr.txt"), r.stderr);
			report.runs.push(row);
			previous = row;
			lastModelId = model.modelId;
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
			ttftMs: r.metrics?.ttftMs ?? null,
			cold: r.coldStart ? "y" : "",
			exit: r.exitCode,
		})),
	);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});

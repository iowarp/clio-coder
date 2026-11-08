#!/usr/bin/env node
/**
 * Onboarding prompt eval: runs a fixed set of prompts against a live model in
 * isolated homes and scores each run from its tool events.
 *
 * Two surfaces compile different main prompts: `run` drives `clio-coder run
 * --json` (headless tier), `acp` drives `clio-coder acp` over stdio (attended
 * tier, the one a TUI, GUI or editor user gets). Every run gets a fresh copy of
 * the home template and of a small generated Python fixture project.
 *
 * Live model only; never part of CI. Example:
 *   TMPDIR=<scratch> LITELLM_API_KEY=... pnpm run eval:onboarding -- \
 *     --home-template <dir with config/settings.yaml> --target litellm \
 *     --model mini/qwen3.8-27b-iq4r-v4 --out <dir> --repeat 3
 */
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

type Surface = "run" | "acp";

interface ToolCall {
	/** Effective capability: `clio_docs` for gateway op=call, `gateway:find` for discovery. */
	name: string;
	args: Record<string, unknown>;
	/** The surface's call id, which pairs the call with its end event. */
	id?: string;
	/** How the call returned: its error flag and the tool result's details. */
	settled?: { isError: boolean; details: Record<string, unknown> };
}

interface RunRecord {
	caseId: string;
	surface: Surface;
	rep: number;
	pass: boolean;
	checks: Record<string, boolean>;
	tools: ToolCall[];
	modelCalls: number | null;
	inputTokens: number | null;
	outputTokens: number | null;
	cacheReadTokens: number | null;
	latencyMs: number;
	stoppedEarly: boolean;
	finalText: string;
	error: string | null;
}

interface Observation {
	tools: ToolCall[];
	finalText: string;
}

interface EvalCase {
	id: string;
	kind: "tool" | "skill" | "dispatch" | "docs" | "negative";
	prompt: string;
	/** Ends the run once the decision being scored is visible; the rest of the run would only cost time. */
	stopOn?: (tool: ToolCall) => boolean;
	/** Ends the run once a matching call has returned, for cases scored on the call's result. */
	stopAfter?: (tool: ToolCall) => boolean;
	score: (obs: Observation) => Record<string, boolean>;
}

const OBSERVE_TOOLS = new Set(["read", "grep", "find", "ls", "code_nav", "bash", "git", "data"]);
const WRITE_TOOLS = new Set(["write", "edit"]);

const usedObserve = (o: Observation): boolean => o.tools.some((t) => OBSERVE_TOOLS.has(t.name));
const usedDocs = (o: Observation): boolean => o.tools.some((t) => t.name === "clio_docs");
const lower = (o: Observation): string => o.finalText.toLowerCase();
/**
 * A docs page by path, a labeled source list, a "See <title>" pointer, a
 * titled guide, or a line-range citation.
 */
const cites = (o: Observation): boolean =>
	[
		/docs\/(?:guide|architecture)\/|\.md\b/u,
		/\b(?:sources?|references?|docs|see)\s*:/iu,
		/\bsee\s+(?:\*|\[|")/iu,
		/\b[A-Z][\w-]*(?:\s+[A-Z][\w-]*)*\s+guides?\b/u,
		/\blines?\s+\d+\s*[–-]\s*\d+/u,
	].some((re) => re.test(o.finalText));

/**
 * A dispatch call that returned without error and whose every run receipt
 * exited 0 with a succeeded outcome; a receipt carries `outcome` only when it
 * did not succeed. A detached dispatch returns ids, not receipts, so it does
 * not count.
 */
function dispatchSucceeded(t: ToolCall): boolean {
	if (t.name !== "dispatch" || t.settled === undefined || t.settled.isError) return false;
	const runs = t.settled.details.runs;
	return (
		Array.isArray(runs) &&
		runs.length > 0 &&
		runs.every((run) => asRecord(run).exitCode === 0 && asRecord(run).outcome === undefined)
	);
}

/** A skills lookup, a skill load, or a library package lookup. */
function isSkillLookup(t: ToolCall): boolean {
	if (t.name === "clio_library") return true;
	if (t.name === "context") return t.args.scope === "skills";
	if (t.name === "gateway:find") return /skill|library|package/iu.test(String(t.args.query ?? ""));
	return t.name === "skill" || t.name.startsWith("skill:");
}

const CASES: EvalCase[] = [
	{
		id: "code-empty-input",
		kind: "tool",
		prompt: "In this project, what does `summarize` return when it is given an empty list?",
		score: (o) => ({
			observed: usedObserve(o),
			noDocs: !usedDocs(o),
			correct: lower(o).includes("none") && /count|0/u.test(lower(o)),
		}),
	},
	{
		id: "code-delimiter",
		kind: "tool",
		prompt: "Which delimiter does this project's CSV loader assume, and in which file is that set?",
		score: (o) => ({
			observed: usedObserve(o),
			noDocs: !usedDocs(o),
			correct: lower(o).includes("io.py") && (o.finalText.includes(";") || lower(o).includes("semicolon")),
		}),
	},
	{
		id: "project-overview",
		kind: "negative",
		prompt: "What does this project do?",
		score: (o) => ({
			observed: usedObserve(o),
			noDocs: !usedDocs(o),
			correct: /statistic|\bmean\b|\bmedian\b/u.test(lower(o)),
		}),
	},
	{
		id: "docs-worker-model",
		kind: "docs",
		prompt: "How do I make Clio use a different model for dispatched workers than for chat?",
		score: (o) => ({
			docs: usedDocs(o),
			docsFirst: o.tools[0]?.name === "clio_docs",
			cited: cites(o),
			correct: lower(o).includes("fleet"),
		}),
	},
	{
		id: "docs-compaction",
		kind: "docs",
		prompt: "How does Clio decide when to compact the conversation, and how do I change that threshold?",
		score: (o) => ({
			docs: usedDocs(o),
			docsFirst: o.tools[0]?.name === "clio_docs",
			cited: cites(o),
			correct: lower(o).includes("threshold") && /0\.8|80 ?%|context\.compaction/u.test(lower(o)),
		}),
	},
	{
		id: "skill-slurm",
		kind: "skill",
		prompt: "Help me write a Slurm batch script that runs this project's tests on our cluster.",
		stopOn: (t) => isSkillLookup(t) || WRITE_TOOLS.has(t.name),
		score: (o) => {
			const firstWrite = o.tools.findIndex((t) => WRITE_TOOLS.has(t.name));
			const firstSkill = o.tools.findIndex(isSkillLookup);
			return { skillLookup: firstSkill >= 0 && (firstWrite < 0 || firstSkill < firstWrite) };
		},
	},
	{
		id: "skill-tdd",
		kind: "skill",
		prompt: "Add a `variance` function to this project using a strict test-driven workflow.",
		stopOn: (t) => isSkillLookup(t) || WRITE_TOOLS.has(t.name),
		score: (o) => {
			const firstWrite = o.tools.findIndex((t) => WRITE_TOOLS.has(t.name));
			const firstSkill = o.tools.findIndex(isSkillLookup);
			return { skillLookup: firstSkill >= 0 && (firstWrite < 0 || firstSkill < firstWrite) };
		},
	},
	{
		id: "dispatch-review",
		kind: "dispatch",
		prompt:
			"Do a thorough bug review of each of the three modules in tinystats (core.py, io.py, cli.py). The reviews are independent of each other. Do not edit anything.",
		stopAfter: (t) => t.name === "dispatch",
		score: (o) => ({
			dispatched: o.tools.some((t) => t.name === "dispatch"),
			succeeded: o.tools.some(dispatchSucceeded),
		}),
	},
	{
		id: "trivial-http",
		kind: "negative",
		prompt: "What does an HTTP 404 status code mean?",
		score: (o) => ({
			noTools: o.tools.length === 0,
			correct: /not found|(could\s?n.?t|could not|cannot|can.?t) (be )?f(i|ou)nd|does(n.?t| not) exist/.test(lower(o)),
		}),
	},
	{
		id: "trivial-python",
		kind: "negative",
		prompt: "In one sentence: what is the difference between a Python list and a tuple?",
		score: (o) => ({ noTools: o.tools.length === 0, correct: lower(o).includes("mutable") }),
	},
];

const FIXTURE: Record<string, string> = {
	"README.md": "# tinystats\n\nSmall descriptive statistics helpers and a CSV loader for lab measurements.\n",
	"pyproject.toml":
		'[project]\nname = "tinystats"\nversion = "0.1.0"\nrequires-python = ">=3.10"\n\n[project.scripts]\ntinystats = "tinystats.cli:main"\n',
	"tinystats/__init__.py": 'from .core import mean, median, summarize\n\n__all__ = ["mean", "median", "summarize"]\n',
	"tinystats/core.py": [
		"def mean(values):",
		"    return sum(values) / len(values)",
		"",
		"",
		"def median(values):",
		"    ordered = sorted(values)",
		"    mid = len(ordered) // 2",
		"    if len(ordered) % 2:",
		"        return ordered[mid]",
		"    return (ordered[mid - 1] + ordered[mid]) / 2",
		"",
		"",
		"def summarize(values):",
		"    if not values:",
		'        return {"count": 0, "mean": None, "median": None}',
		'    return {"count": len(values), "mean": mean(values), "median": median(values)}',
		"",
	].join("\n"),
	"tinystats/io.py": [
		"import csv",
		"",
		'DELIMITER = ";"',
		"",
		"",
		"def load_csv(path, column):",
		"    with open(path, newline='') as handle:",
		"        reader = csv.DictReader(handle, delimiter=DELIMITER)",
		"        return [float(row[column]) for row in reader]",
		"",
	].join("\n"),
	"tinystats/cli.py": [
		"import sys",
		"",
		"from .core import summarize",
		"from .io import load_csv",
		"",
		"",
		"def main(argv=None):",
		"    argv = sys.argv[1:] if argv is None else argv",
		"    path, column = argv[0], argv[1]",
		"    print(summarize(load_csv(path, column)))",
		"",
	].join("\n"),
	"tests/test_core.py": [
		"from tinystats import mean, median, summarize",
		"",
		"",
		"def test_mean():",
		"    assert mean([1, 2, 3]) == 2",
		"",
		"",
		"def test_median_even():",
		"    assert median([1, 2, 3, 4]) == 2.5",
		"",
		"",
		"def test_summarize_empty():",
		'    assert summarize([])["count"] == 0',
		"",
	].join("\n"),
};

interface Options {
	homeTemplate: string;
	surfaces: Surface[];
	repeat: number;
	cases: EvalCase[];
	target: string | null;
	model: string | null;
	out: string;
	clio: string;
	timeoutSec: number;
	label: string;
}

const HELP = `usage: pnpm run eval:onboarding -- --home-template <dir> --out <dir> [flags]

  --home-template <dir>  isolated home to copy per run (config/settings.yaml, optional state/)
  --out <dir>            results directory (homes, fixtures, raw events, results.json, summary.md)
  --target <id>          chat target for every run (written into each copied home)
  --model <id>           chat model for every run
  --surface run,acp      surfaces to drive (default both)
  --repeat <n>           runs per case and surface (default 3)
  --cases <ids>          comma-separated case ids (default all)
  --timeout <seconds>    per-run limit (default 300)
  --clio <path>          CLI entry (default this checkout's dist/cli/index.js)
  --label <text>         label recorded in results and the summary heading

       pnpm run eval:onboarding -- --rescore <dir>
  re-applies the current scoring to the runs recorded in <dir>
`;

function parseArgs(argv: string[]): Options {
	const value = (flag: string): string | undefined => {
		const i = argv.indexOf(flag);
		return i >= 0 ? argv[i + 1] : undefined;
	};
	if (argv.includes("--help") || argv.includes("-h")) {
		process.stdout.write(HELP);
		process.exit(0);
	}
	const homeTemplate = value("--home-template");
	const out = value("--out");
	if (homeTemplate === undefined || out === undefined) {
		process.stderr.write(HELP);
		process.exit(2);
	}
	const surfaces = (value("--surface") ?? "run,acp").split(",").map((s) => s.trim()) as Surface[];
	for (const s of surfaces) if (s !== "run" && s !== "acp") throw new Error(`unknown surface: ${s}`);
	const ids = value("--cases")
		?.split(",")
		.map((s) => s.trim());
	const cases = ids === undefined ? CASES : CASES.filter((c) => ids.includes(c.id));
	if (ids !== undefined && cases.length !== ids.length) {
		throw new Error(`unknown case id; known: ${CASES.map((c) => c.id).join(", ")}`);
	}
	const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
	return {
		homeTemplate: resolve(homeTemplate),
		surfaces,
		repeat: Number.parseInt(value("--repeat") ?? "3", 10),
		cases,
		target: value("--target") ?? null,
		model: value("--model") ?? null,
		out: resolve(out),
		clio: resolve(value("--clio") ?? join(root, "dist", "cli", "index.js")),
		timeoutSec: Number.parseInt(value("--timeout") ?? "300", 10),
		label: value("--label") ?? "eval",
	};
}

function writeFixture(dir: string): void {
	for (const [rel, text] of Object.entries(FIXTURE)) {
		mkdirSync(dirname(join(dir, rel)), { recursive: true });
		writeFileSync(join(dir, rel), text);
	}
	const env = {
		...process.env,
		GIT_AUTHOR_NAME: "eval",
		GIT_AUTHOR_EMAIL: "eval@example.invalid",
		GIT_COMMITTER_NAME: "eval",
		GIT_COMMITTER_EMAIL: "eval@example.invalid",
	};
	execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir, env });
	execFileSync("git", ["add", "-A"], { cwd: dir, env });
	execFileSync("git", ["commit", "-q", "--no-verify", "-m", "initial"], { cwd: dir, env });
}

function prepareHome(opts: Options, home: string): NodeJS.ProcessEnv {
	cpSync(opts.homeTemplate, home, { recursive: true });
	for (const sub of ["config", "data", "state", "cache"]) mkdirSync(join(home, sub), { recursive: true });
	const settingsPath = join(home, "config", "settings.yaml");
	if (opts.target !== null || opts.model !== null) {
		const settings = (existsSync(settingsPath) ? parseYaml(readFileSync(settingsPath, "utf8")) : {}) ?? {};
		settings.chat = {
			...(settings.chat ?? {}),
			...(opts.target !== null ? { target: opts.target } : {}),
			...(opts.model !== null ? { model: opts.model } : {}),
		};
		writeFileSync(settingsPath, stringifyYaml(settings));
	}
	return {
		...process.env,
		CLIO_CODER_HOME: home,
		CLIO_CODER_CONFIG_DIR: join(home, "config"),
		CLIO_CODER_DATA_DIR: join(home, "data"),
		CLIO_CODER_STATE_DIR: join(home, "state"),
		CLIO_CODER_CACHE_DIR: join(home, "cache"),
		CLIO_CODER_INTEROP_HOME: "none",
	};
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) =>
			part !== null && typeof part === "object" && (part as { type?: unknown }).type === "text"
				? String((part as { text?: unknown }).text ?? "")
				: "",
		)
		.join("");
}

function asRecord(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** Gateway discovery keeps its op so `find` and `describe` round trips are visible in the score. */
function normalizeTool(name: string, args: Record<string, unknown>): ToolCall {
	if (name === "gateway") {
		const op = String(args.op ?? "");
		if (op === "call" && typeof args.capability === "string") {
			return { name: args.capability, args: asRecord(args.args) };
		}
		return { name: `gateway:${op}`, args };
	}
	return { name, args };
}

/** Records how the call `id` returned on its first terminal event, and returns it. */
function settle(tools: ToolCall[], id: unknown, isError: unknown, result: unknown): ToolCall | undefined {
	const tool = tools.find((t) => t.id !== undefined && t.id === id);
	if (tool === undefined || tool.settled !== undefined) return undefined;
	tool.settled = { isError: isError === true, details: asRecord(asRecord(result).details) };
	return tool;
}

interface Driven {
	tools: ToolCall[];
	finalText: string;
	modelCalls: number | null;
	inputTokens: number | null;
	outputTokens: number | null;
	cacheReadTokens: number | null;
	stoppedEarly: boolean;
	error: string | null;
	raw: unknown[];
}

function killTree(child: ChildProcess): void {
	if (child.exitCode === null && child.pid !== undefined) {
		try {
			process.kill(-child.pid, "SIGTERM");
		} catch {
			// The group is already gone; nothing left to stop.
		}
	}
}

async function driveRun(opts: Options, evalCase: EvalCase, cwd: string, env: NodeJS.ProcessEnv): Promise<Driven> {
	const args = [opts.clio, "run", "--json", "--timeout", String(opts.timeoutSec)];
	if (opts.target !== null) args.push("--target", opts.target);
	if (opts.model !== null) args.push("--model", opts.model);
	args.push(evalCase.prompt);
	const child = spawn(process.execPath, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
	const driven: Driven = {
		tools: [],
		finalText: "",
		modelCalls: 0,
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		stoppedEarly: false,
		error: null,
		raw: [],
	};
	let stderr = "";
	child.stderr?.on("data", (chunk: Buffer) => {
		stderr += chunk.toString();
	});
	const lines = createInterface({ input: child.stdout as NodeJS.ReadableStream });
	lines.on("line", (line) => {
		let frame: Record<string, unknown>;
		try {
			frame = JSON.parse(line) as Record<string, unknown>;
		} catch {
			return;
		}
		if (frame.type === "text_delta" || frame.type === "tool_execution_update") return;
		driven.raw.push(frame);
		if (frame.type === "tool_execution_start") {
			const tool = normalizeTool(String(frame.toolName), asRecord(frame.args));
			if (typeof frame.toolCallId === "string") tool.id = frame.toolCallId;
			driven.tools.push(tool);
			if (evalCase.stopOn?.(tool) === true && !driven.stoppedEarly) {
				driven.stoppedEarly = true;
				killTree(child);
			}
		}
		if (frame.type === "tool_execution_end") {
			const tool = settle(driven.tools, frame.toolCallId, frame.isError, frame.result);
			if (tool !== undefined && evalCase.stopAfter?.(tool) === true && !driven.stoppedEarly) {
				driven.stoppedEarly = true;
				killTree(child);
			}
		}
		if (frame.type === "turn_end") {
			const message = asRecord(frame.message);
			if (message.role !== "assistant") return;
			const text = textOf(message.content);
			if (text.trim().length > 0) driven.finalText = text;
		}
	});
	const timer = setTimeout(
		() => {
			driven.error = "timeout";
			killTree(child);
		},
		(opts.timeoutSec + 30) * 1000,
	);
	const code = await new Promise<number | null>((done) => child.on("close", done));
	clearTimeout(timer);
	if (!driven.stoppedEarly && driven.error === null && code !== 0) {
		driven.error = `exit ${code}: ${stderr.trim().split("\n").slice(-3).join(" | ")}`;
	}
	return driven;
}

/** Model calls and token usage from the run's session ledger, the same record for both surfaces. */
function ledgerUsage(home: string): Pick<Driven, "modelCalls" | "inputTokens" | "outputTokens" | "cacheReadTokens"> {
	const sessions = join(home, "state", "sessions");
	const usage = { modelCalls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
	if (!existsSync(sessions)) return usage;
	for (const workspace of readdirSync(sessions)) {
		for (const session of readdirSync(join(sessions, workspace))) {
			const ledger = join(sessions, workspace, session, "current.jsonl");
			if (!existsSync(ledger)) continue;
			for (const line of readFileSync(ledger, "utf8").split("\n")) {
				if (line.trim().length === 0) continue;
				let entry: Record<string, unknown>;
				try {
					entry = JSON.parse(line) as Record<string, unknown>;
				} catch {
					// A run stopped early can leave a torn last line; the complete entries still count.
					continue;
				}
				if (entry.kind !== "message" || entry.role !== "assistant") continue;
				const u = asRecord(asRecord(entry.payload).usage);
				usage.modelCalls += 1;
				usage.inputTokens += Number(u.input ?? 0);
				usage.outputTokens += Number(u.output ?? 0);
				usage.cacheReadTokens += Number(u.cacheRead ?? 0);
			}
		}
	}
	return usage;
}

async function driveAcp(opts: Options, evalCase: EvalCase, cwd: string, env: NodeJS.ProcessEnv): Promise<Driven> {
	const child = spawn(process.execPath, [opts.clio, "acp"], {
		cwd,
		env,
		stdio: ["pipe", "pipe", "pipe"],
		detached: true,
	});
	const driven: Driven = {
		tools: [],
		finalText: "",
		modelCalls: null,
		inputTokens: null,
		outputTokens: null,
		cacheReadTokens: null,
		stoppedEarly: false,
		error: null,
		raw: [],
	};
	let stderr = "";
	child.stderr?.on("data", (chunk: Buffer) => {
		stderr += chunk.toString();
	});
	let nextId = 1;
	const pending = new Map<number, (msg: Record<string, unknown>) => void>();
	const send = (msg: Record<string, unknown>): void => {
		child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`);
	};
	const request = (method: string, params: unknown): Promise<Record<string, unknown>> =>
		new Promise((done) => {
			const id = nextId++;
			pending.set(id, done);
			send({ id, method, params });
		});
	let sessionId = "";
	let segment = "";
	const seenCalls = new Set<string>();
	const lines = createInterface({ input: child.stdout as NodeJS.ReadableStream });
	lines.on("line", (line) => {
		let msg: Record<string, unknown>;
		try {
			msg = JSON.parse(line) as Record<string, unknown>;
		} catch {
			return;
		}
		if (typeof msg.id === "number" && msg.method === undefined) {
			pending.get(msg.id)?.(msg);
			pending.delete(msg.id);
			return;
		}
		if (msg.method === "session/request_permission" && msg.id !== undefined) {
			// No operator answers in the eval, matching a headless run's denial.
			driven.raw.push({ permission: asRecord(msg.params).toolCall });
			send({ id: msg.id, result: { outcome: { outcome: "selected", optionId: "reject-once" } } });
			return;
		}
		if (msg.id !== undefined && msg.method !== undefined) {
			send({ id: msg.id, error: { code: -32601, message: "not supported by the eval client" } });
			return;
		}
		if (msg.method !== "session/update") return;
		const update = asRecord(asRecord(msg.params).update);
		const kind = update.sessionUpdate;
		if (kind === "agent_message_chunk") {
			segment += textOf([update.content]);
			return;
		}
		if (kind === "tool_call") {
			driven.raw.push({ tool_call: { name: update.name, title: update.title, rawInput: update.rawInput } });
			const id = String(update.toolCallId);
			if (seenCalls.has(id)) return;
			seenCalls.add(id);
			if (segment.trim().length > 0) driven.finalText = segment;
			segment = "";
			const tool = normalizeTool(String(update.name ?? update.title), asRecord(update.rawInput));
			tool.id = id;
			driven.tools.push(tool);
			if (evalCase.stopOn?.(tool) === true && !driven.stoppedEarly) {
				driven.stoppedEarly = true;
				send({ method: "session/cancel", params: { sessionId } });
			}
			return;
		}
		if (kind === "tool_call_update" && (update.status === "completed" || update.status === "failed")) {
			const output = asRecord(update.rawOutput);
			driven.raw.push({ tool_call_update: { toolCallId: update.toolCallId, status: update.status, rawOutput: output } });
			const tool = settle(
				driven.tools,
				update.toolCallId,
				output.isError === true || update.status === "failed",
				output.result,
			);
			if (tool !== undefined && evalCase.stopAfter?.(tool) === true && !driven.stoppedEarly) {
				driven.stoppedEarly = true;
				send({ method: "session/cancel", params: { sessionId } });
			}
			return;
		}
		if (kind === "usage_update" || kind === "tool_call_update") return;
		driven.raw.push({ update: kind });
	});
	const timer = setTimeout(
		() => {
			driven.error = "timeout";
			killTree(child);
		},
		(opts.timeoutSec + 30) * 1000,
	);
	const closed = new Promise<void>((done) => child.on("close", () => done()));
	try {
		const init = await Promise.race([
			request("initialize", {
				protocolVersion: 1,
				clientCapabilities: {},
				clientInfo: { name: "clio-eval", version: "1" },
			}),
			closed.then(
				(): Record<string, unknown> => ({
					error: { message: `acp exited: ${stderr.trim().split("\n").slice(-3).join(" | ")}` },
				}),
			),
		]);
		if (init.error !== undefined) throw new Error(JSON.stringify(init.error));
		const created = await request("session/new", { cwd, mcpServers: [] });
		if (created.error !== undefined) throw new Error(JSON.stringify(created.error));
		sessionId = String(asRecord(created.result).sessionId);
		const response = await Promise.race([
			request("session/prompt", { sessionId, prompt: [{ type: "text", text: evalCase.prompt }] }),
			closed.then((): Record<string, unknown> => ({ error: { message: "acp exited mid-prompt" } })),
		]);
		if (segment.trim().length > 0) driven.finalText = segment;
		if (response.error !== undefined && !driven.stoppedEarly) throw new Error(JSON.stringify(response.error));
		driven.raw.push({ promptResponse: asRecord(response.result).stopReason });
	} catch (err) {
		if (driven.error === null) driven.error = err instanceof Error ? err.message : String(err);
	} finally {
		clearTimeout(timer);
		child.stdin?.end();
		killTree(child);
		await closed;
	}
	return driven;
}

function mean(xs: number[]): number {
	return xs.length === 0 ? Number.NaN : xs.reduce((a, b) => a + b, 0) / xs.length;
}

function sd(xs: number[]): number {
	if (xs.length < 2) return 0;
	const m = mean(xs);
	return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
}

function cell(xs: Array<number | null>, digits = 0): string {
	const known = xs.filter((x): x is number => x !== null && Number.isFinite(x));
	if (known.length === 0) return "n/a";
	return `${mean(known).toFixed(digits)} ± ${sd(known).toFixed(digits)}`;
}

function summarize(opts: Options, records: RunRecord[]): string {
	const out = [
		`# Onboarding eval: ${opts.label}`,
		"",
		`model ${opts.target ?? "(home)"}/${opts.model ?? "(home)"}, ${opts.repeat} runs per case and surface; cells are mean ± sd.`,
		"",
	];
	for (const surface of opts.surfaces) {
		out.push(
			`## ${surface}`,
			"",
			"| case | kind | pass | checks | tools | model calls | prompt tok | output tok | latency s |",
			"| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
		);
		let passed = 0;
		let total = 0;
		for (const c of opts.cases) {
			const rs = records.filter((r) => r.caseId === c.id && r.surface === surface);
			const p = rs.filter((r) => r.pass).length;
			passed += p;
			total += rs.length;
			const checkNames = Object.keys(rs[0]?.checks ?? {});
			const checks = checkNames.map((n) => `${n} ${rs.filter((r) => r.checks[n]).length}/${rs.length}`).join(", ");
			out.push(
				`| ${c.id} | ${c.kind} | ${p}/${rs.length} | ${checks} | ${cell(
					rs.map((r) => r.tools.length),
					1,
				)} | ${cell(
					rs.map((r) => r.modelCalls),
					1,
				)} | ${cell(rs.map((r) => (r.inputTokens ?? 0) + (r.cacheReadTokens ?? 0)))} | ${cell(rs.map((r) => r.outputTokens))} | ${cell(
					rs.map((r) => r.latencyMs / 1000),
					1,
				)} |`,
			);
		}
		out.push("", `${surface} pass rate: ${passed}/${total}`, "");
	}
	return out.join("\n");
}

/** Re-applies the current scoring to recorded runs, so a scoring fix needs no new model calls. */
function rescore(dir: string): void {
	const runsDir = join(dir, "runs");
	const records: RunRecord[] = readdirSync(runsDir)
		.filter((name) => existsSync(join(runsDir, name, "record.json")))
		.map((name) => JSON.parse(readFileSync(join(runsDir, name, "record.json"), "utf8")) as RunRecord);
	for (const record of records) {
		const evalCase = CASES.find((c) => c.id === record.caseId);
		if (evalCase === undefined) continue;
		record.checks = evalCase.score({ tools: record.tools, finalText: record.finalText });
		record.pass = record.error === null && Object.values(record.checks).every(Boolean);
		writeFileSync(
			join(runsDir, `${record.caseId}-${record.surface}-${record.rep}`, "record.json"),
			`${JSON.stringify(record, null, 1)}\n`,
		);
	}
	records.sort((a, b) => a.rep - b.rep);
	const prior = existsSync(join(dir, "results.json"))
		? (JSON.parse(readFileSync(join(dir, "results.json"), "utf8")) as {
				label?: string;
				target?: string | null;
				model?: string | null;
			})
		: {};
	const seen = new Set(records.map((r) => r.caseId));
	const opts: Options = {
		homeTemplate: "",
		surfaces: (["run", "acp"] as const).filter((s) => records.some((r) => r.surface === s)),
		repeat: Math.max(0, ...records.map((r) => r.rep)),
		cases: CASES.filter((c) => seen.has(c.id)),
		target: prior.target ?? null,
		model: prior.model ?? null,
		out: dir,
		clio: "",
		timeoutSec: 0,
		label: prior.label ?? "eval",
	};
	writeFileSync(
		join(dir, "results.json"),
		`${JSON.stringify({ label: opts.label, target: opts.target, model: opts.model, records }, null, 1)}\n`,
	);
	const summary = summarize(opts, records);
	writeFileSync(join(dir, "summary.md"), `${summary}\n`);
	process.stdout.write(`${summary}\n`);
}

async function main(): Promise<void> {
	const rescoreIndex = process.argv.indexOf("--rescore");
	if (rescoreIndex >= 0) {
		const dir = process.argv[rescoreIndex + 1];
		if (dir === undefined) throw new Error("--rescore needs a results directory");
		rescore(resolve(dir));
		return;
	}
	const opts = parseArgs(process.argv.slice(2));
	if (!existsSync(opts.clio)) throw new Error(`no CLI entry at ${opts.clio}; run pnpm run build first`);
	mkdirSync(opts.out, { recursive: true });
	const records: RunRecord[] = [];
	for (let rep = 1; rep <= opts.repeat; rep++) {
		for (const evalCase of opts.cases) {
			for (const surface of opts.surfaces) {
				const tag = `${evalCase.id}-${surface}-${rep}`;
				const runDir = join(opts.out, "runs", tag);
				const project = join(runDir, "project");
				mkdirSync(project, { recursive: true });
				writeFixture(project);
				const env = prepareHome(opts, join(runDir, "home"));
				const started = performance.now();
				const driven =
					surface === "run" ? await driveRun(opts, evalCase, project, env) : await driveAcp(opts, evalCase, project, env);
				const latencyMs = performance.now() - started;
				Object.assign(driven, ledgerUsage(join(runDir, "home")));
				const checks = evalCase.score({ tools: driven.tools, finalText: driven.finalText });
				const pass = driven.error === null && Object.values(checks).every(Boolean);
				const record: RunRecord = {
					caseId: evalCase.id,
					surface,
					rep,
					pass,
					checks,
					tools: driven.tools,
					modelCalls: driven.modelCalls,
					inputTokens: driven.inputTokens,
					outputTokens: driven.outputTokens,
					cacheReadTokens: driven.cacheReadTokens,
					latencyMs,
					stoppedEarly: driven.stoppedEarly,
					finalText: driven.finalText,
					error: driven.error,
				};
				records.push(record);
				writeFileSync(join(runDir, "events.json"), `${JSON.stringify(driven.raw, null, 1)}\n`);
				writeFileSync(join(runDir, "record.json"), `${JSON.stringify(record, null, 1)}\n`);
				process.stderr.write(
					`${pass ? "PASS" : "FAIL"} ${tag} ${(latencyMs / 1000).toFixed(1)}s tools=[${driven.tools.map((t) => t.name).join(",")}]${driven.error !== null ? ` error=${driven.error}` : ""}\n`,
				);
				writeFileSync(
					join(opts.out, "results.json"),
					`${JSON.stringify({ label: opts.label, target: opts.target, model: opts.model, records }, null, 1)}\n`,
				);
			}
		}
	}
	const summary = summarize(opts, records);
	writeFileSync(join(opts.out, "summary.md"), `${summary}\n`);
	process.stdout.write(`${summary}\n`);
}

main().catch((err: unknown) => {
	process.stderr.write(`eval-onboarding: ${err instanceof Error ? err.message : String(err)}\n`);
	process.exit(1);
});

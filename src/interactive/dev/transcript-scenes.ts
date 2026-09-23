/**
 * Transcript scenes for the visual harness and the render bench.
 *
 * Each scene drives a real chat panel through the same event sequence the
 * chat loop emits, so what the gallery prints is what an operator would see
 * for that kind of work. The scenes cover every tool class, every agent kind,
 * skills, reasoning, failures, receipts and in-flight states. Nothing here
 * reads disk, the clock, or the network: a scene clock supplies durations,
 * and every id is fixed, so two runs produce byte-identical frames.
 */

import type { CanonicalTrustStatus } from "../../domains/evidence/trust-status.js";
import type { ChatLoopEvent } from "../chat-loop.js";
import type { ChatPanel } from "../chat-panel.js";
import type { WorkerEntryState } from "../worker-stream.js";

export interface SceneClock {
	now(): number;
	advance(ms: number): void;
}

export function createSceneClock(start = 1_700_000_000_000): SceneClock {
	let current = start;
	return {
		now: () => current,
		advance: (ms) => {
			current += ms;
		},
	};
}

export interface TranscriptScene {
	id: string;
	title: string;
	play(panel: ChatPanel, clock: SceneClock): void;
}

interface ToolOptions {
	isError?: boolean;
	durationMs?: number;
	outcome?: "blocked";
	blockReason?: string;
	/** Leave the call running: no end event. */
	open?: boolean;
	partial?: unknown;
}

interface MessageOptions {
	thinking?: string;
	text?: string;
	stopReason?: "stop" | "toolUse" | "error" | "aborted" | "length";
	errorMessage?: string;
	input?: number;
	output?: number;
	cacheRead?: number;
	reasoning?: number;
	/** Stream the text without settling the message. */
	open?: boolean;
}

type AssistantRecord = Record<string, unknown> & { role: "assistant" };

/** Scripted chat-loop events for one panel. */
class SceneDriver {
	private callSeq = 0;
	private messages: AssistantRecord[] = [];

	constructor(
		readonly panel: ChatPanel,
		readonly clock: SceneClock,
	) {}

	emit(event: Record<string, unknown>): void {
		this.panel.applyEvent(event as unknown as ChatLoopEvent);
	}

	prompt(text: string): void {
		this.panel.appendUser(text);
		this.emit({ type: "agent_start" });
		this.messages = [];
	}

	message(options: MessageOptions): void {
		this.emit({ type: "message_start", message: { role: "assistant" } });
		const content: Array<Record<string, unknown>> = [];
		if (options.thinking !== undefined) {
			for (const piece of chunk(options.thinking, 48)) {
				this.emit({ type: "thinking_delta", contentIndex: 0, delta: piece });
				this.clock.advance(30);
			}
			content.push({ type: "thinking", thinking: options.thinking });
		}
		if (options.text !== undefined) {
			for (const piece of chunk(options.text, 24)) {
				this.emit({ type: "text_delta", contentIndex: content.length, delta: piece });
				this.clock.advance(12);
			}
			content.push({ type: "text", text: options.text });
		}
		if (options.open === true) return;
		const message: AssistantRecord = {
			role: "assistant",
			content,
			stopReason: options.stopReason ?? "stop",
			usage: {
				input: options.input ?? 8_400,
				output: options.output ?? 220,
				cacheRead: options.cacheRead ?? 6_100,
				cacheWrite: 0,
				...(options.reasoning !== undefined ? { reasoning: options.reasoning } : {}),
			},
			...(options.errorMessage !== undefined ? { errorMessage: options.errorMessage } : {}),
		};
		this.emit({ type: "message_end", message });
		this.messages.push(message);
	}

	tool(name: string, args: unknown, result: unknown, options: ToolOptions = {}): string {
		const id = `call-${String(++this.callSeq).padStart(3, "0")}`;
		this.emit({ type: "tool_execution_start", toolCallId: id, toolName: name, args });
		if (options.partial !== undefined) {
			this.emit({ type: "tool_execution_update", toolCallId: id, partialResult: options.partial });
		}
		const durationMs = options.durationMs ?? 42;
		this.clock.advance(durationMs);
		if (options.open === true) return id;
		this.emit({
			type: "tool_execution_end",
			toolCallId: id,
			toolName: name,
			result,
			isError: options.isError === true || options.outcome !== undefined,
			durationMs,
			...(options.outcome !== undefined ? { outcome: options.outcome, blockReason: options.blockReason } : {}),
		});
		return id;
	}

	finishTool(id: string, name: string, result: unknown, durationMs = 42, isError = false): void {
		this.clock.advance(durationMs);
		this.emit({ type: "tool_execution_end", toolCallId: id, toolName: name, result, isError, durationMs });
	}

	notice(text: string): void {
		this.emit({ type: "notice", level: "info", surface: "transcript", text });
	}

	worker(state: WorkerEntryState): void {
		this.panel.applyWorkerState(state);
	}

	end(): void {
		this.clock.advance(400);
		this.emit({ type: "agent_end", messages: this.messages });
	}
}

function chunk(text: string, size: number): string[] {
	const out: string[] = [];
	for (let at = 0; at < text.length; at += size) out.push(text.slice(at, at + size));
	return out;
}

function text(body: string, details?: Record<string, unknown>): Record<string, unknown> {
	return { content: [{ type: "text", text: body }], ...(details ? { details } : {}) };
}

function observed(body: string, observation: Record<string, unknown>, extra: Record<string, unknown> = {}) {
	return text(body, { observation: { truncated: false, ...observation }, ...extra });
}

const FILE_BODY = Array.from({ length: 40 }, (_, i) => `${i + 1}\texport const retryDelay${i} = ${i * 25};`).join("\n");

const RETRY_DIFF = [
	" 11 export async function retry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {",
	"-12   const jitter = Math.random() * 50;",
	"+12   const jitter = options.random() * options.maxJitterMs;",
	" 13   for (let attempt = 0; attempt < attempts; attempt += 1) {",
	"-14     await sleep(backoff(attempt) + jitter);",
	'+14     await options.sleep(backoff(attempt) + jitter, { signal: options.signal, reason: "retry " + (attempt + 1) });',
	"+15     options.onAttempt?.(attempt);",
].join("\n");

/**
 * A verified, validated receipt trust status. The worker card reads the
 * integrity and validation states; every other axis is carried for shape.
 */
function trust(validation = "validated"): CanonicalTrustStatus {
	const axis = (state: string) => ({ state, sources: [] });
	return {
		version: 1,
		artifactIntegrity: axis("verified"),
		validationGrounding: axis(validation),
		independentReview: axis("none"),
		contextProvenance: axis("recorded"),
		autonomyEnforcement: axis("enforced"),
		completionEvidence: axis("absent"),
	} as unknown as CanonicalTrustStatus;
}

function workerState(overrides: Partial<WorkerEntryState> & Pick<WorkerEntryState, "assignmentId" | "agentId">) {
	const base: WorkerEntryState = {
		runId: `${overrides.assignmentId}-r1`,
		origin: "user",
		runtime: { kind: "clio", targetId: "dynamo", wireModelId: "qwen3.8-27b" },
		text: "",
		droppedLines: 0,
		tools: [],
		attempts: [{ runId: `${overrides.assignmentId}-r1`, targetLabel: "dynamo/qwen3.8-27b" }],
		pending: false,
		...overrides,
	};
	return base;
}

function settledReceipt(durationMs: number, tokenCount: number, toolCalls: number, validation = "validated") {
	return {
		outcome: "succeeded",
		durationMs,
		tokenCount,
		toolCalls,
		contract: "pass" as const,
		trust: trust(validation),
	};
}

const skillDetails = (name: string, activation: string, extra: Record<string, unknown> = {}) => ({
	observation: { shownCount: 1, totalCount: 1, unit: "sections", truncated: false },
	name,
	description:
		name === "tdd"
			? "Write the failing test first, then the smallest change that passes it."
			: "Profile before optimizing; report measured numbers, not guesses.",
	activation,
	...extra,
});

const SCENES: TranscriptScene[] = [
	{
		id: "observe",
		title: "Observation and search",
		play(panel, clock) {
			const d = new SceneDriver(panel, clock);
			d.prompt("The retry test is flaky on CI. Find out why.");
			d.message({ text: "I'll read the retry module and its test first." });
			d.tool(
				"read",
				{ path: "src/net/retry.ts", offset: 1, limit: 40 },
				observed(FILE_BODY, { shownCount: 40, totalCount: 120, unit: "lines", shownBytes: 1_480, totalBytes: 4_410 }),
			);
			d.tool(
				"read",
				{ path: "tests/net/retry.test.ts" },
				observed(FILE_BODY, { shownCount: 64, totalCount: 64, unit: "lines", shownBytes: 2_210, totalBytes: 2_210 }),
			);
			d.tool(
				"read",
				{ path: "docs/guide/testing.md" },
				observed("# Testing", { shownCount: 30, totalCount: 30, unit: "lines", shownBytes: 900, totalBytes: 900 }),
			);
			d.tool(
				"grep",
				{ pattern: "Math.random", path: "src", context: 2, glob: "*.ts" },
				observed("src/net/retry.ts:12:  const jitter = Math.random() * 50;", {
					shownCount: 1,
					totalCount: 1,
					unit: "matches",
				}),
			);
			d.tool(
				"ls",
				{ path: "src/net" },
				observed("retry.ts\nsleep.ts\nindex.ts", { shownCount: 3, totalCount: 3, unit: "entries" }),
			);
			d.tool(
				"find",
				{ pattern: "**/*.test.ts", path: "tests/net" },
				observed("tests/net/retry.test.ts", { shownCount: 1, totalCount: 1, unit: "files" }),
			);
			d.tool(
				"code_nav",
				{ mode: "references", query: "retry" },
				observed("src/net/index.ts:4\nsrc/cli/fetch.ts:88", { shownCount: 2, totalCount: 2, unit: "references" }),
			);
			d.message({
				text: "The test races the jitter: `Math.random()` is called inside `retry`, so the delay is not injectable.",
			});
			d.end();
		},
	},
	{
		id: "mutate",
		title: "File changes",
		play(panel, clock) {
			const d = new SceneDriver(panel, clock);
			d.prompt("Make the jitter injectable and fix the test.");
			d.message({ text: "Editing the retry module to take its random source and sleep from options." });
			d.tool(
				"edit",
				{ path: "src/net/retry.ts", edits: [{ oldText: "Math.random()", newText: "options.random()" }] },
				text("Edited src/net/retry.ts", { diff: RETRY_DIFF }),
			);
			d.tool(
				"write",
				{ path: "tests/net/fake-clock.ts", content: "export function fakeClock() {\n  return { now: () => 0 };\n}\n" },
				text("Wrote tests/net/fake-clock.ts", {
					diff: "+1 export function fakeClock() {\n+2   return { now: () => 0 };\n+3 }",
				}),
			);
			d.tool(
				"edit",
				{
					path: "tests/net/retry.test.ts",
					edits: [{ oldText: "await retry(flaky)", newText: "await retry(flaky, 3, options)" }],
				},
				text("edit: oldText not found in tests/net/retry.test.ts. The file contains `await retry(flaky, 3)` on line 18."),
				{ isError: true },
			);
			d.message({ text: "The test call site differs from what I expected; I'll read it again before editing." });
			d.end();
		},
	},
	{
		id: "execute",
		title: "Commands and checks",
		play(panel, clock) {
			const d = new SceneDriver(panel, clock);
			d.prompt("Run the test suite and commit if it passes.");
			d.tool(
				"bash",
				{ command: "pnpm test -- tests/net/retry.test.ts" },
				text("▶ retry\n  ✔ retries three times (12ms)\n  ✔ injects jitter (3ms)\n✔ retry (16ms)\nℹ tests 2\nℹ pass 2", {
					exitCode: 0,
					resultSize: { bytes: 118, shownBytes: 118 },
				}),
				{ durationMs: 2_300 },
			);
			d.tool(
				"bash",
				{ command: "pnpm run lint" },
				text(
					"src/net/retry.ts:14:5 lint/style/useTemplate  Template literals are preferred over string concatenation.\n\nCommand exited with code 1",
					{
						exitCode: 1,
					},
				),
				{ isError: true, durationMs: 4_100 },
			);
			d.tool(
				"run_script",
				{ script: "scripts/check-flaky.ts", args: ["--runs", "50"] },
				text("50/50 runs passed", { exitCode: 0 }),
				{
					durationMs: 11_800,
				},
			);
			d.tool("verify", { check: "typecheck" }, text("tsc: no errors", { exitCode: 0, status: "passed" }), {
				durationMs: 6_200,
			});
			d.tool("git", { op: "status" }, text(" M src/net/retry.ts\n M tests/net/retry.test.ts", { exitCode: 0 }));
			d.tool(
				"git",
				{ op: "commit", message: "fix(net): make retry jitter injectable" },
				text("[v054 3f9a1c2] fix(net): make retry jitter injectable\n 2 files changed, 9 insertions(+), 3 deletions(-)", {
					exitCode: 0,
				}),
			);
			d.message({
				text: "Tests pass 50 of 50 runs. Lint flagged one template literal; I left the commit to your review.",
			});
			d.end();
		},
	},
	{
		id: "network",
		title: "Network reads",
		play(panel, clock) {
			const d = new SceneDriver(panel, clock);
			d.prompt("Check what the Node docs say about AbortSignal.timeout.");
			d.tool(
				"web_fetch",
				{ url: "https://nodejs.org/api/globals.html#abortsignaltimeoutdelay", format: "markdown" },
				text("## AbortSignal.timeout(delay) ...", { status: 200, format: "markdown", bytesRead: 12_431, truncated: false }),
				{ durationMs: 820 },
			);
			d.tool(
				"web_read",
				{ url: "https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal/timeout_static" },
				text("AbortSignal.timeout() ...", { status: 200, format: "text", bytesRead: 48_900, truncated: true }),
				{ durationMs: 1_140 },
			);
			d.tool(
				"web_fetch",
				{ url: "https://nodejs.org/api/timers-v2.html" },
				text("web_fetch: HTTP 404 Not Found from nodejs.org", { status: 404, bytesRead: 0 }),
				{ isError: true, durationMs: 310 },
			);
			d.message({
				text: "`AbortSignal.timeout(ms)` aborts with a `TimeoutError` DOMException; it is available since Node 17.3.",
			});
			d.end();
		},
	},
	{
		id: "delegate",
		title: "Delegation from the model",
		play(panel, clock) {
			const d = new SceneDriver(panel, clock);
			d.prompt("Have a scout map every caller of retry() before we change its signature.");
			d.message({ text: "I'll send a scout to map the callers while I read the module." });
			const dispatchArgs = { agent: "scout", task: "List every call site of retry() and the options each one passes." };
			const id = d.tool("dispatch", dispatchArgs, undefined, { open: true, durationMs: 0 });
			d.worker(
				workerState({
					assignmentId: "as-scout",
					runId: "k2m9x4",
					agentId: "scout",
					origin: "agent",
					parentToolCallId: id,
					task: dispatchArgs.task,
					text:
						"Found 4 call sites.\n- src/net/index.ts:4 passes no options\n- src/cli/fetch.ts:88 passes attempts=5\n- src/fleet/probe.ts:31 passes attempts=2\n- tests/net/retry.test.ts:18 passes attempts=3",
					tools: ["grep", "read"],
					receipt: settledReceipt(38_400, 18_200, 7),
				}),
			);
			d.finishTool(
				id,
				"dispatch",
				text("scout k2m9x4 succeeded: Found 4 call sites.", {
					receiptCount: 1,
					failedCount: 0,
					runs: [{ trust: { axes: { validationGrounding: "validated" } } }],
				}),
				38_400,
			);
			d.tool("monitor", { run_id: "k2m9x4" }, text("k2m9x4 · completed · 7 tool calls"));
			d.tool(
				"steer",
				{ run_id: "p7q1c3", message: "Skip the vendored copies under third_party/." },
				text("delivered to p7q1c3"),
			);
			d.message({ text: "Four callers; only `fetch.ts` relies on the default jitter." });
			d.end();
		},
	},
	{
		id: "knowledge",
		title: "Context and knowledge",
		play(panel, clock) {
			const d = new SceneDriver(panel, clock);
			d.prompt("How do Clio workers get their tool surface?");
			d.tool(
				"context",
				{ scope: "docs", query: "worker tool surface" },
				observed("## Worker tools ...", { shownCount: 3, totalCount: 3, unit: "sections" }),
			);
			d.tool(
				"clio_docs",
				{ query: "dispatch admission" },
				observed("## Admission ...", { shownCount: 2, totalCount: 5, unit: "sections" }),
			);
			d.tool(
				"clio_library",
				{ query: "research agents" },
				observed("- scout\n- researcher", { shownCount: 2, totalCount: 2, unit: "packages" }),
			);
			d.tool(
				"evidence",
				{ op: "list", limit: 5 },
				observed("ev-1\nev-2", { shownCount: 2, totalCount: 9, unit: "bundles" }),
			);
			d.tool(
				"context",
				{ scope: "recall", ref: "call-017" },
				observed("(recalled body)", { shownCount: 1, totalCount: 1, unit: "results" }),
			);
			d.message({ text: "Workers receive the admitted capability list; gateway-placed tools arrive through `gateway`." });
			d.end();
		},
	},
	{
		id: "interaction",
		title: "Operator questions",
		play(panel, clock) {
			const d = new SceneDriver(panel, clock);
			d.prompt("Clean up the old retry helpers.");
			d.tool(
				"ask_user",
				{ question: "Delete src/net/legacy-retry.ts or keep it deprecated?", options: ["Delete", "Keep deprecated"] },
				text("Operator chose: Keep deprecated", { answer: "Keep deprecated" }),
				{ durationMs: 9_400 },
			);
			d.message({ text: "Keeping it, marked `@deprecated` with a pointer to the new module." });
			d.end();
		},
	},
	{
		id: "external",
		title: "Gateway, MCP and extension tools",
		play(panel, clock) {
			const d = new SceneDriver(panel, clock);
			d.prompt("Is there an open issue about the flaky retry test?");
			d.tool("gateway", { op: "find", query: "github issues" }, text("mcp_github__search_issues ..."));
			d.tool(
				"gateway",
				{ op: "call", capability: "mcp_github__search_issues", args: { query: "flaky retry test", state: "open" } },
				text("#412 retry test flakes on CI (open)", { capability: "mcp_github__search_issues" }),
				{ durationMs: 1_900 },
			);
			d.tool(
				"gateway",
				{ op: "call", capability: "web_fetch", args: { url: "https://github.com/iowarp/clio-coder/issues/412" } },
				text("# retry test flakes on CI", { capability: "web_fetch", status: 200, format: "markdown", bytesRead: 5_210 }),
				{ durationMs: 640 },
			);
			d.tool("extension_hpc__queue_status", { partition: "gpu" }, text("gpu: 3 pending, 12 running"), { durationMs: 380 });
			d.message({ text: "Issue #412 tracks it; I'll reference it in the commit." });
			d.end();
		},
	},
	{
		id: "agents",
		title: "Agent invocations",
		play(panel, clock) {
			const d = new SceneDriver(panel, clock);
			// Operator-started run: `/run` or `/delegate`.
			panel.appendUser("/run reviewer check the retry change for missed call sites");
			d.worker(
				workerState({
					assignmentId: "as-review",
					runId: "r4v8n2",
					agentId: "reviewer",
					origin: "user",
					task: "check the retry change for missed call sites",
					text: "No missed call sites. One suggestion: make `maxJitterMs` default to 50 to keep behavior.",
					tools: ["read", "grep"],
					receipt: settledReceipt(51_200, 22_900, 9),
				}),
			);
			// Council members, each with a roster color.
			panel.appendUser("/council should retry() own its clock?");
			for (const [index, [label, color, answer]] of [
				["Architect", "#7fb2e5", "Yes. Inject a clock; tests and fleet probes both need it."],
				["Skeptic", "#e59f7f", "No. Pass a sleep function; a clock object is more surface than it needs."],
				["Operator", "#9fd39a", "Either works; prefer the smaller API."],
			].entries()) {
				d.worker(
					workerState({
						assignmentId: `as-council-${index}`,
						runId: `c0unc${index}`,
						agentId: String(label).toLowerCase(),
						origin: "user",
						text: String(answer),
						council: { group: "g1", label: String(label), color: String(color), round: 1 },
						receipt: settledReceipt(12_000 + index * 1_500, 4_100, 0),
					}),
				);
			}
			// Model-started subagent that failed over to a second route.
			d.prompt("Profile the fleet probe with a benchmarker agent.");
			const id = d.tool(
				"dispatch",
				{ agent: "benchmarker", task: "Profile fleet/probe.ts under 200 concurrent probes." },
				undefined,
				{
					open: true,
					durationMs: 0,
				},
			);
			d.worker(
				workerState({
					assignmentId: "as-bench",
					runId: "b3n7h9",
					agentId: "benchmarker",
					origin: "agent",
					parentToolCallId: id,
					task: "Profile fleet/probe.ts under 200 concurrent probes.",
					text: "p50 41ms, p99 380ms. The p99 comes from DNS lookups that are not cached.",
					tools: ["bash", "read"],
					attempts: [
						{ runId: "b3n7h8", targetLabel: "mini/qwen3.8-27b", outcome: "failed" },
						{ runId: "b3n7h9", targetLabel: "dynamo/qwen3.8-27b" },
					],
					receipt: settledReceipt(96_000, 31_000, 14, "unknown"),
				}),
			);
			d.finishTool(
				id,
				"dispatch",
				text("benchmarker b3n7h9 succeeded", { receiptCount: 1, failedCount: 0, runs: [{}] }),
				96_000,
			);
			// Internal helper work under the same turn.
			d.worker(
				workerState({
					assignmentId: "as-helper",
					runId: "h1lp3r",
					agentId: "context-scout",
					origin: "agent",
					helper: true,
					task: "Summarize prior probe benchmarks from the evidence store.",
					receipt: settledReceipt(7_300, 2_100, 3),
				}),
			);
			d.message({
				text: "DNS caching is the fix; the benchmarker's numbers are measured, not validated by a second run.",
			});
			d.end();
		},
	},
	{
		id: "skills",
		title: "Skills",
		play(panel, clock) {
			const d = new SceneDriver(panel, clock);
			d.prompt("/skill tdd fix the flaky retry test");
			d.tool(
				"context",
				{ scope: "skills", name: "tdd" },
				observed(
					"(skill body)",
					{ shownCount: 1, totalCount: 1, unit: "sections" },
					skillDetails("tdd", "operator", { allowedTools: ["read", "edit", "bash"] }),
				),
			);
			d.message({ text: "Starting with the failing test." });
			d.end();
			d.notice(
				"[Clio Coder] Skill activated: tdd (read, edit, bash). Its tool surface stays armed across your next turns until another skill replaces it or you run /skill off.",
			);
			d.prompt("Now profile it.");
			d.tool(
				"context",
				{ scope: "skills", name: "perf" },
				observed(
					"(skill body)",
					{ shownCount: 1, totalCount: 1, unit: "sections" },
					skillDetails("perf", "model", { drift: "mismatch" }),
				),
			);
			d.tool(
				"context",
				{ scope: "skills", name: "release" },
				text(
					'context: skill "release" requires explicit operator activation with /skill release; it disables model invocation. Do not retry this load.',
				),
				{ isError: true },
			);
			d.tool(
				"context",
				{ scope: "skills", name: "hpc-slurm" },
				text(
					'context: skill "hpc-slurm" is imported but untrusted. Review it in /library, then enable integrations.projectResources.trustProjectImports to use it. Do not retry this load.',
				),
				{ isError: true },
			);
			d.tool(
				"context",
				{ scope: "skills", name: "flamegraph" },
				text(
					'context: skill "flamegraph" is not installed; it is available in the marketplace. If installation has not been declined, offer /skill flamegraph to install it.',
				),
				{ isError: true },
			);
			d.tool(
				"read",
				{ path: "library/skills/perf/SKILL.md" },
				observed("---\nname: perf", { shownCount: 12, totalCount: 12, unit: "lines" }),
			);
			d.message({
				text: "Suggested skill: /skill flamegraph\nProfiling with the perf skill; flamegraph would need your install.",
			});
			d.end();
		},
	},
	{
		id: "reasoning",
		title: "Reasoning in stream order",
		play(panel, clock) {
			const d = new SceneDriver(panel, clock);
			d.prompt("Why does the probe time out only on the mini node?");
			d.message({
				thinking:
					"The mini node runs the older resolver. Timeouts that appear only there usually mean DNS, not the probe itself. I should check resolv.conf and the probe's timeout budget before guessing.",
				text: "Checking the resolver configuration on mini first.",
				reasoning: 180,
			});
			d.tool(
				"bash",
				{ command: "ssh mini cat /etc/resolv.conf" },
				text("nameserver 192.168.86.1\noptions timeout:5 attempts:3", { exitCode: 0 }),
				{ durationMs: 610 },
			);
			d.message({
				thinking: "Five seconds times three attempts is fifteen seconds, which exceeds the probe's ten second budget.",
				text:
					"The resolver retries for up to 15s, beyond the probe's 10s budget. Lowering `attempts` or caching lookups fixes it.",
				reasoning: 64,
			});
			d.end();
		},
	},
	{
		id: "failures",
		title: "Refusals, cancellations and failures",
		play(panel, clock) {
			const d = new SceneDriver(panel, clock);
			d.prompt("Delete the build cache and rebuild.");
			d.tool(
				"bash",
				{ command: "rm -rf ~/.cache/clio-coder" },
				text("blocked: rm -rf outside the workspace requires approval"),
				{
					outcome: "blocked",
					blockReason: "safety-net rail fs.rm-outside-workspace refused the call",
				},
			);
			d.message({ text: "The safety net blocked deleting outside the workspace. I stopped there.", stopReason: "stop" });
			d.end();
			d.prompt("Refactor the whole net module.");
			d.message({ text: "Starting with the retry module", open: true });
			d.emit({
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "Starting with the retry module" }],
					stopReason: "aborted",
					errorMessage: "run aborted by operator",
				},
			});
			d.emit({
				type: "agent_end",
				messages: [{ role: "assistant", content: [], stopReason: "aborted", usage: { input: 3000, output: 12 } }],
			});
			d.prompt("Summarize the design doc.");
			d.message({
				text: "",
				stopReason: "error",
				errorMessage: "429 Too Many Requests: rate limit exceeded for model qwen3.8-27b on target dynamo. Retry after 20s.",
			});
			d.end();
		},
	},
	{
		id: "notices",
		title: "Notices and retries",
		play(panel, clock) {
			const d = new SceneDriver(panel, clock);
			d.prompt("Continue with the fix.");
			d.notice("[context engine] prompt_recompiled may affect cache reuse; actual reuse is reported with the response.");
			d.emit({
				type: "retry_status",
				status: { attempt: 1, maxAttempts: 5, delayMs: 2_000, phase: "waiting", errorMessage: "503 Service Unavailable" },
			});
			d.message({ text: "Applying the fix to the remaining call sites." });
			d.emit({ type: "queued_user_turn", text: "also update the changelog", kind: "steer" });
			d.message({ text: "Changelog updated under 0.5.4." });
			d.end();
		},
	},
	{
		id: "live",
		title: "In flight",
		play(panel, clock) {
			const d = new SceneDriver(panel, clock);
			d.prompt("Build and deploy the docs site.");
			d.message({ thinking: "Build first, then deploy only if the build is clean.", text: "Building the site." });
			d.tool("bash", { command: "pnpm run docs:build" }, undefined, {
				open: true,
				durationMs: 3_400,
				partial: text("vite v6.2 building for production...\ntransforming (812) src/pages/index.md"),
			});
			const approval = d.tool("bash", { command: "rsync -a dist/ docs@web:/srv/docs" }, undefined, {
				open: true,
				durationMs: 0,
			});
			d.emit({
				type: "tool_approval_state",
				toolCallId: approval,
				state: "awaiting-approval",
				view: {
					requestId: "req-1",
					tool: "bash",
					actionClass: "execute",
					axis: { kind: "autonomy", level: "suggest" },
					origin: { kind: "main" },
					reason: "outward network write",
					target: "rsync -a dist/ docs@web:/srv/docs",
				},
			});
			d.worker(
				workerState({
					assignmentId: "as-link",
					runId: "l1nk5c",
					agentId: "link-checker",
					origin: "agent",
					pending: true,
					startedAtMs: clock.now() - 12_000,
					task: "Check every internal link in dist/.",
					text: "Checked 214 of 580 links; 2 broken so far.",
					tools: ["bash"],
					progress: {
						revision: 3,
						phase: "tool",
						tailText: "Checked 214 of 580 links; 2 broken so far.",
						droppedLines: 0,
						droppedBytes: 0,
						processedTokens: 6_200,
						toolCalls: 4,
						currentAction: { tool: "bash", descriptor: { verb: "running", object: "lychee dist/**/*.html" } },
						recentActions: [{ tool: "read", descriptor: { verb: "read", object: "dist/index.html" } }],
						toolNames: ["bash", "read"],
						settled: false,
					} as unknown as NonNullable<WorkerEntryState["progress"]>,
				}),
			);
			d.message({ text: "While that runs, the deploy step is waiting on your approval for the rsync", open: true });
		},
	},
];

export function transcriptScenes(): readonly TranscriptScene[] {
	return SCENES;
}

/** Deterministic PRNG for the synthetic bench transcript. */
function mulberry32(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
	};
}

const PROSE = [
	"The retry loop now takes its random source and its sleep from options, so the test drives both deterministically.",
	"I checked every caller: only `fetch.ts` depends on the default jitter, and it keeps the same behavior.",
	"## What changed\n\n- `retry()` accepts `options.random` and `options.sleep`\n- the test uses a fake clock\n- lint is clean",
	"```ts\nconst result = await retry(fetchPage, 3, { random: () => 0, sleep: fakeSleep });\n```",
	"The p99 comes from uncached DNS lookups on the mini node; the resolver retries for up to **15s** against a 10s budget.",
];

/**
 * Append a synthetic but realistic session of `entries` transcript entries:
 * operator prompts, reasoning, markdown prose, and a mix of every tool class,
 * all settled. Each turn adds two entries (prompt and assistant turn).
 */
export function playSyntheticTranscript(panel: ChatPanel, clock: SceneClock, entries: number, seed = 7): void {
	const random = mulberry32(seed);
	const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
	const d = new SceneDriver(panel, clock);
	for (let turn = 0; turn * 2 < entries; turn += 1) {
		d.prompt(`Turn ${turn}: ${pick(["fix the flaky test", "profile the probe", "update the docs", "review the diff"])}`);
		if (random() < 0.4)
			d.message({ thinking: "Check the module before editing; the test depends on timing.", text: pick(PROSE) });
		else d.message({ text: pick(PROSE) });
		const tools = 1 + Math.floor(random() * 5);
		for (let call = 0; call < tools; call += 1) {
			const kind = Math.floor(random() * 6);
			if (kind === 0)
				d.tool(
					"read",
					{ path: `src/net/module-${call}.ts` },
					observed(FILE_BODY, { shownCount: 40, totalCount: 120, unit: "lines", shownBytes: 1_480, totalBytes: 4_410 }),
				);
			else if (kind === 1)
				d.tool(
					"grep",
					{ pattern: `symbol${call}`, path: "src" },
					observed("src/a.ts:1:x", { shownCount: 3, totalCount: 3, unit: "matches" }),
				);
			else if (kind === 2) d.tool("edit", { path: `src/net/module-${call}.ts` }, text("Edited", { diff: RETRY_DIFF }));
			else if (kind === 3)
				d.tool("bash", { command: "pnpm test" }, text("ℹ tests 42\nℹ pass 42", { exitCode: 0 }), { durationMs: 2_100 });
			else if (kind === 4)
				d.tool(
					"web_fetch",
					{ url: "https://nodejs.org/api/globals.html" },
					text("## globals", { status: 200, format: "markdown", bytesRead: 9_000 }),
				);
			else d.tool("git", { op: "status" }, text(" M src/net/retry.ts", { exitCode: 0 }));
		}
		d.message({ text: `${pick(PROSE)}\n\n${pick(PROSE)}` });
		d.end();
	}
}

/**
 * Open a streaming turn for the bench: the prompt and a message whose text
 * the caller feeds one delta at a time through `streamDelta`.
 */
export function openStreamingTurn(panel: ChatPanel): void {
	panel.appendUser("Explain the retry design in detail.");
	panel.applyEvent({ type: "agent_start" } as unknown as ChatLoopEvent);
	panel.applyEvent({ type: "message_start", message: { role: "assistant" } } as unknown as ChatLoopEvent);
}

export function streamDelta(panel: ChatPanel, delta: string): void {
	panel.applyEvent({ type: "text_delta", contentIndex: 0, delta } as unknown as ChatLoopEvent);
}

export function settleStreamingTurn(panel: ChatPanel, fullText: string): void {
	const message = {
		role: "assistant",
		content: [{ type: "text", text: fullText }],
		stopReason: "stop",
		usage: { input: 9_000, output: 800, cacheRead: 7_000, cacheWrite: 0 },
	};
	panel.applyEvent({ type: "message_end", message } as unknown as ChatLoopEvent);
	panel.applyEvent({ type: "agent_end", messages: [message] } as unknown as ChatLoopEvent);
}

/** A long markdown answer of roughly `chars` characters, delivered as provider-sized deltas. */
export function streamingAnswer(chars: number): string {
	const blocks = [
		"## Retry design\n\nThe retry loop owns three decisions: **how many** attempts, **how long** to wait, and **when** to stop early.",
		"- attempts are bounded by the caller\n- backoff doubles from 25ms\n- jitter is injected, never ambient",
		"```ts\nexport async function retry<T>(fn: () => Promise<T>, attempts = 3, options = defaults): Promise<T> {\n  for (let attempt = 0; attempt < attempts; attempt += 1) {\n    try { return await fn(); } catch (error) { await options.sleep(backoff(attempt)); }\n  }\n}\n```",
		"Tests drive the clock directly, so a run of 50 iterations finishes in milliseconds and never races a real timer.",
	];
	let out = "";
	let index = 0;
	while (out.length < chars) {
		out += `${out.length === 0 ? "" : "\n\n"}${blocks[index % blocks.length]}`;
		index += 1;
	}
	return out;
}

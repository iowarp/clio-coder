/** Deterministic, provider-free render workloads. Timings exclude terminal emulator painting. */
import { parseArgs } from "node:util";
import {
	InstrumentedTuiAltScreen,
	InstrumentedTuiMainScreen,
	type Terminal,
	Text,
	type TuiMode,
	type TuiRenderObserver,
} from "../src/engine/tui.js";
import { type ChatPanel, createChatPanel } from "../src/interactive/chat-panel.js";
import { buildLayout } from "../src/interactive/layout.js";
import type { WorkerEntryState } from "../src/session-control/worker-stream.js";

const { values } = parseArgs({
	options: {
		turns: { type: "string", default: "400" },
		frames: { type: "string", default: "120" },
		repeats: { type: "string", default: "3" },
		columns: { type: "string", default: "120" },
		rows: { type: "string", default: "40" },
		mode: { type: "string" },
		workload: { type: "string" },
	},
});
function positive(value: string): number {
	const number = Number(value);
	if (!Number.isSafeInteger(number) || number < 1) throw new Error(`Expected a positive integer, got ${value}`);
	return number;
}
const turns = positive(values.turns);
const frames = positive(values.frames);
const repeats = positive(values.repeats);

class CountingTerminal implements Terminal {
	columns = positive(values.columns);
	rows = positive(values.rows);
	kittyProtocolActive = false;
	bytes = 0;
	start(): void {}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(data: string): void {
		this.bytes += Buffer.byteLength(data);
	}
	moveBy(): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(): void {}
	setProgress(): void {}
	setProgramStatus(): void {}
}

function settle(panel: ChatPanel, text: string): void {
	const message = { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" };
	panel.applyEvent({ type: "message_end", message } as never);
	panel.applyEvent({ type: "agent_end", messages: [message] } as never);
}

const answer = [
	"The render loop keeps **settled output** stable while the live tail grows.",
	"",
	"- Preserve input responsiveness.",
	"- Keep tool events ordered.",
	"",
	"```ts",
	"const result = await runTool(input);",
	"return result;",
	"```",
].join("\n");
const diagram = "```mermaid\nflowchart TD\nA[Prompt] --> B[Model]\nB --> C[Tool]\nC --> B\nB --> D[Answer]\n```\n\n";
const workloads = [
	"composer",
	"text",
	"long-text",
	"tool",
	"tool-burst",
	"diagram",
	"workers",
	"workers-long",
	"telemetry",
	"turn",
	"skill",
] as const;
const modes = ["regular", "fullscreen"] as const;
if (values.mode && !modes.some((mode) => mode === values.mode)) throw new Error("Unknown mode");
if (values.workload && !workloads.some((workload) => workload === values.workload)) throw new Error("Unknown workload");
type Workload = (typeof workloads)[number];

/** The renderers the application ships, with frame observation off. */
const unobserved: TuiRenderObserver = {
	isEnabled: () => false,
	beginFrame: () => undefined,
	endFrame: () => {},
	beginPhase: () => undefined,
	endPhase: () => {},
};

function workerState(index: number, pending: boolean): WorkerEntryState {
	return {
		assignmentId: `assignment-${index}`,
		runId: `run-${index}`,
		origin: "agent",
		agentId: `worker-${index}`,
		runtime: { kind: "clio", targetId: "test", wireModelId: "test" },
		text: "Starting investigation",
		droppedLines: 0,
		tools: [],
		attempts: [],
		pending,
		startedAtMs: 0,
	};
}

/** A read-model view holding only what the transcript reads; each published batch is a new object. */
function telemetryView(elapsed: (runId: string) => string): never {
	return {
		seeding: false,
		runs: () => [],
		run: (runId: string) => ({
			row: { tokens: { display: "1.2k" } },
			activity: { elapsed: { display: elapsed(runId) }, toolCalls: { display: "3" }, contextTokens: null },
		}),
	} as never;
}

function sample(mode: TuiMode, workload: Workload): { milliseconds: number[]; bytes: number } {
	const terminal = new CountingTerminal();
	let view: never | null = null;
	const panel = createChatPanel({ now: () => 1_000, getTerminalRows: () => terminal.rows, getTelemetry: () => view });
	for (let index = 0; index < turns; index++) {
		panel.appendUser(`Question ${index}`);
		// Workloads that scan history need the history they scan: tool rows, and settled worker cards.
		if (workload === "tool-burst") {
			const toolCallId = `history-${index}`;
			panel.applyEvent({ type: "tool_execution_start", toolCallId, toolName: "bash", args: { command: "ls" } } as never);
			panel.applyEvent({
				type: "tool_execution_end",
				toolCallId,
				result: { content: [{ type: "text", text: "ok" }] },
				isError: false,
			} as never);
		}
		settle(panel, answer);
		if (workload === "telemetry" && index % 10 === 0) panel.applyWorkerState(workerState(1_000 + index, false));
	}
	const editor = new Text("draft", 0, 0);
	const tui =
		mode === "regular"
			? new InstrumentedTuiMainScreen(terminal, unobserved)
			: new InstrumentedTuiAltScreen(terminal, unobserved);
	const root = buildLayout(
		{ banner: new Text("Clio", 0, 0), chat: panel, editor, footer: new Text("ready", 0, 0) },
		{ mode },
	);
	if (tui instanceof InstrumentedTuiAltScreen) tui.setLayoutRoot(root);
	else tui.addChild(root);
	tui.start();
	try {
		const workers = Array.from({ length: 8 }, (_, index) => workerState(index, true));
		if (workload !== "composer") {
			panel.appendUser("Continue");
			panel.applyEvent({ type: "agent_start" } as never);
		}
		if (workload === "long-text") panel.applyEvent({ type: "text_delta", delta: `${answer}\n\n`.repeat(80) } as never);
		if (workload === "diagram") panel.applyEvent({ type: "text_delta", delta: diagram } as never);
		if (workload === "workers-long") for (const worker of workers) worker.text = `${answer}\n\n`.repeat(150);
		if (workload === "workers" || workload === "workers-long" || workload === "telemetry")
			for (const worker of workers) panel.applyWorkerState(worker);
		if (workload === "telemetry") view = telemetryView(() => "1.0s");
		if (workload === "tool")
			panel.applyEvent({
				type: "tool_execution_start",
				toolCallId: "bench",
				toolName: "bash",
				args: { command: "build" },
			} as never);
		tui.renderNow();
		let output = "";
		const mutate = (index: number): void => {
			if (workload === "composer") editor.setText(`draft ${index % 10}`);
			else if (workload === "tool") {
				output += `Build step ${index} complete\n`;
				panel.applyEvent({
					type: "tool_execution_update",
					toolCallId: "bench",
					partialResult: { content: [{ type: "text", text: output }] },
				} as never);
			} else if (workload === "workers" || workload === "workers-long") {
				const worker = workers[index % workers.length];
				if (worker) {
					worker.text += ` finding${index}`;
					panel.applyWorkerState(worker);
				}
			} else if (workload === "telemetry") {
				// One batch moved one running worker's clock; every other card reads the same as before.
				const moved = `run-${index % workers.length}`;
				view = telemetryView((runId) => (runId === moved ? `${index}.0s` : "1.0s"));
			} else if (workload === "tool-burst") {
				const toolCallId = `burst-${index}`;
				panel.applyEvent({ type: "tool_execution_start", toolCallId, toolName: "bash", args: { command: "ls" } } as never);
				panel.applyEvent({
					type: "tool_execution_update",
					toolCallId,
					partialResult: { content: [{ type: "text", text: "line" }] },
				} as never);
				panel.applyEvent({
					type: "tool_execution_end",
					toolCallId,
					result: { content: [{ type: "text", text: "ok" }] },
					isError: false,
				} as never);
			} else if (workload === "turn") {
				panel.appendUser(`Prompt ${index}`);
				panel.applyEvent({ type: "agent_start" } as never);
				settle(panel, `Answer ${index}`);
			} else if (workload === "skill") {
				panel.applyEvent({
					type: "notice",
					level: "info",
					surface: "transcript",
					text: "Skill armed",
					skillSurface: {
						version: 1,
						state: "armed",
						names: [`skill-${index}`],
						previous: [],
						allowedTools: ["read", "edit"],
						disallowedTools: [],
					},
				} as never);
			} else panel.applyEvent({ type: "text_delta", delta: ` word${index}` } as never);
		};
		// Warm the same growing workload before sampling; setup and history rendering are excluded.
		for (let index = 0; index < 20; index++) {
			mutate(index);
			tui.renderNow();
		}
		terminal.bytes = 0;
		const milliseconds: number[] = [];
		for (let index = 0; index < frames; index++) {
			const start = performance.now();
			mutate(index + 20);
			tui.renderNow();
			milliseconds.push(performance.now() - start);
		}
		return { milliseconds, bytes: terminal.bytes };
	} finally {
		tui.stop();
	}
}

const results = [];
for (const mode of modes) {
	if (values.mode && values.mode !== mode) continue;
	for (const workload of workloads) {
		if (values.workload && values.workload !== workload) continue;
		const samples = Array.from({ length: repeats }, () => sample(mode, workload));
		const times = samples.flatMap((entry) => entry.milliseconds).sort((a, b) => a - b);
		const percentile = (p: number): number => Number((times[Math.ceil(times.length * p) - 1] ?? 0).toFixed(3));
		results.push({
			mode,
			workload,
			p50Ms: percentile(0.5),
			p95Ms: percentile(0.95),
			p99Ms: percentile(0.99),
			maxMs: percentile(1),
			bytesPerFrame: Math.round(samples.reduce((sum, entry) => sum + entry.bytes, 0) / times.length),
		});
	}
}
console.log(
	JSON.stringify(
		{
			node: process.version,
			platform: process.platform,
			columns: positive(values.columns),
			rows: positive(values.rows),
			turns,
			frames,
			repeats,
			results,
		},
		null,
		2,
	),
);

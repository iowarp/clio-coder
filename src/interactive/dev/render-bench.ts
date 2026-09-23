/**
 * In-process render bench for the transcript.
 *
 * The real chat panel renders inside the real layout and Clio's instrumented
 * pi-tui renderers, against a virtual terminal that counts every byte written.
 * Each frame is driven synchronously with `renderNow`, so a sample is the
 * whole frame transaction: component render, line normalization, diffing,
 * ANSI construction and terminal enqueue. It stops at the terminal boundary
 * and makes no claim about a PTY, an emulator or a display.
 */

import { performance } from "node:perf_hooks";
import type { OutputStyle } from "../../core/defaults.js";
import {
	type Component,
	InstrumentedTuiAltScreen,
	InstrumentedTuiMainScreen,
	type Terminal,
	type TuiRenderObserver,
	type TuiRenderPhase,
} from "../../engine/tui.js";
import { type ChatPanel, type ChatPanelRenderMetrics, createChatPanel } from "../chat-panel.js";
import { buildLayout } from "../layout.js";
import {
	createSceneClock,
	openStreamingTurn,
	playSyntheticTranscript,
	settleStreamingTurn,
	streamDelta,
	streamingAnswer,
} from "./transcript-scenes.js";

class VirtualTerminal implements Terminal {
	kittyProtocolActive = false;
	bytes = 0;
	writes = 0;
	constructor(
		public columns: number,
		public rows: number,
	) {}
	start(): void {}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(data: string): void {
		this.bytes += Buffer.byteLength(data, "utf8");
		this.writes += 1;
	}
	moveBy(): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(): void {}
	setProgress(): void {}
}

/** A composer stand-in: a fixed four-row block whose text the bench can change like a keystroke. */
class ComposerStub implements Component {
	draft = "";
	render(width: number): string[] {
		const rule = "─".repeat(Math.max(1, width));
		return [rule, `> ${this.draft}`.slice(0, width), "", rule];
	}
	invalidate(): void {}
}

class StaticRows implements Component {
	constructor(private readonly rows: string[]) {}
	render(width: number): string[] {
		return this.rows.map((row) => row.slice(0, width));
	}
	invalidate(): void {}
}

interface PhaseTotals {
	normalization: number;
}

class PhaseObserver implements TuiRenderObserver {
	current: PhaseTotals = { normalization: 0 };
	private starts = new Map<TuiRenderPhase, number>();
	beginFrame(): unknown {
		this.current = { normalization: 0 };
		return this.current;
	}
	endFrame(): void {}
	beginPhase(_frame: unknown, phase: TuiRenderPhase): unknown {
		this.starts.set(phase, performance.now());
		return phase;
	}
	endPhase(_frame: unknown, phase: TuiRenderPhase): void {
		const started = this.starts.get(phase);
		if (started !== undefined && phase === "normalization") this.current.normalization += performance.now() - started;
	}
}

export interface FrameSample {
	frameMs: number;
	panelMs: number;
	normalizationMs: number;
	bytes: number;
	fullRedraw: boolean;
}

interface BenchHarness {
	panel: ChatPanel;
	composer: ComposerStub;
	frame(): FrameSample;
	setStyle(style: OutputStyle): void;
	lineCount(): number;
	stop(): void;
}

function createHarness(options: {
	mode: "regular" | "fullscreen";
	columns: number;
	rows: number;
	style: OutputStyle;
}): BenchHarness {
	let style = options.style;
	const clock = createSceneClock();
	let lastPanel: ChatPanelRenderMetrics | null = null;
	const panel = createChatPanel({
		now: clock.now,
		getTerminalRows: () => options.rows,
		getOutputStyle: () => style,
		onRenderMetrics: (metrics) => {
			lastPanel = metrics;
		},
	});
	const composer = new ComposerStub();
	const root = buildLayout(
		{
			banner: new StaticRows([">C_ Clio Coder v0.5.4 · bench · qwen3.8-27b · ~/bench · main"]),
			chat: panel,
			editor: composer,
			footer: new StaticRows(["Ready · dynamo · qwen3.8-27b · medium", "~/bench · main"]),
		},
		{ mode: options.mode },
	);
	const terminal = new VirtualTerminal(options.columns, options.rows);
	const observer = new PhaseObserver();
	const tui =
		options.mode === "fullscreen"
			? new InstrumentedTuiAltScreen(terminal, observer, false, undefined, { mouse: false })
			: new InstrumentedTuiMainScreen(terminal, observer, false);
	tui.addChild(root);
	tui.start();
	return {
		panel,
		composer,
		frame(): FrameSample {
			const redrawsBefore = tui.fullRedraws;
			const bytesBefore = terminal.bytes;
			lastPanel = null;
			const started = performance.now();
			tui.renderNow();
			const frameMs = performance.now() - started;
			const panelMetrics = lastPanel as ChatPanelRenderMetrics | null;
			return {
				frameMs,
				panelMs: panelMetrics?.durationMs ?? 0,
				normalizationMs: observer.current.normalization,
				bytes: terminal.bytes - bytesBefore,
				fullRedraw: tui.fullRedraws > redrawsBefore,
			};
		},
		setStyle(next) {
			style = next;
		},
		lineCount: () => panel.render(options.columns).length,
		stop: () => tui.stop(),
	};
}

export interface Distribution {
	n: number;
	p50: number;
	p99: number;
	max: number;
	mean: number;
}

function distribution(values: readonly number[]): Distribution {
	if (values.length === 0) return { n: 0, p50: 0, p99: 0, max: 0, mean: 0 };
	const sorted = [...values].sort((a, b) => a - b);
	const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)))] ?? 0;
	return {
		n: sorted.length,
		p50: at(0.5),
		p99: at(0.99),
		max: sorted[sorted.length - 1] ?? 0,
		mean: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
	};
}

export interface ScaleResult {
	entries: number;
	lines: number;
	mode: "regular" | "fullscreen";
	columns: number;
	rows: number;
	/** Every frame after a streamed delta. */
	streaming: {
		frame: Distribution;
		panel: Distribution;
		normalization: Distribution;
		bytesPerDelta: Distribution;
		fullRedraws: number;
	};
	/** Frames where only the composer changed, with the transcript settled. */
	keystrokeSettled: { frame: Distribution; panel: Distribution };
	/** Composer-only frames interleaved with streaming. */
	keystrokeStreaming: { frame: Distribution };
	/** The frame that finalizes the streamed answer through Markdown. */
	finalize: FrameSample;
	/** Alt+O cycling through all three styles once. */
	styleSwitch: FrameSample[];
	/** A second Alt+O cycle, into styles the transcript has already been shown in. */
	styleSwitchWarm: FrameSample[];
}

const STYLE_CYCLE: readonly OutputStyle[] = ["detailed", "compact", "standard"];

export function benchScale(options: {
	entries: number;
	mode: "regular" | "fullscreen";
	columns: number;
	rows: number;
	deltas: number;
	keystrokes: number;
}): ScaleResult {
	const harness = createHarness({ mode: options.mode, columns: options.columns, rows: options.rows, style: "standard" });
	try {
		playSyntheticTranscript(harness.panel, createSceneClock(), options.entries);
		harness.frame();
		const keystrokeFrames: FrameSample[] = [];
		for (let i = 0; i < options.keystrokes; i += 1) {
			harness.composer.draft += "x";
			keystrokeFrames.push(harness.frame());
		}
		harness.composer.draft = "";
		harness.frame();
		const lines = harness.lineCount();

		const answer = streamingAnswer(options.deltas * 4);
		openStreamingTurn(harness.panel);
		harness.frame();
		const streamFrames: FrameSample[] = [];
		const streamingKeys: FrameSample[] = [];
		const step = Math.max(1, Math.ceil(answer.length / options.deltas));
		for (let at = 0; at < answer.length; at += step) {
			streamDelta(harness.panel, answer.slice(at, at + step));
			streamFrames.push(harness.frame());
			if (streamingKeys.length < options.keystrokes) {
				harness.composer.draft += "y";
				streamingKeys.push(harness.frame());
			}
		}
		settleStreamingTurn(harness.panel, answer);
		const finalize = harness.frame();

		const styleSwitch: FrameSample[] = [];
		for (const style of STYLE_CYCLE) {
			harness.setStyle(style);
			styleSwitch.push(harness.frame());
		}
		const styleSwitchWarm: FrameSample[] = [];
		for (const style of STYLE_CYCLE) {
			harness.setStyle(style);
			styleSwitchWarm.push(harness.frame());
		}
		return {
			entries: options.entries,
			lines,
			mode: options.mode,
			columns: options.columns,
			rows: options.rows,
			streaming: {
				frame: distribution(streamFrames.map((f) => f.frameMs)),
				panel: distribution(streamFrames.map((f) => f.panelMs)),
				normalization: distribution(streamFrames.map((f) => f.normalizationMs)),
				bytesPerDelta: distribution(streamFrames.map((f) => f.bytes)),
				fullRedraws: streamFrames.filter((f) => f.fullRedraw).length,
			},
			keystrokeSettled: {
				frame: distribution(keystrokeFrames.map((f) => f.frameMs)),
				panel: distribution(keystrokeFrames.map((f) => f.panelMs)),
			},
			keystrokeStreaming: { frame: distribution(streamingKeys.map((f) => f.frameMs)) },
			finalize,
			styleSwitch,
			styleSwitchWarm,
		};
	} finally {
		harness.stop();
	}
}

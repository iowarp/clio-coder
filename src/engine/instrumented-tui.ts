/**
 * Render-transaction hooks around pi-tui's two concrete renderers.
 *
 * pi-tui deliberately exposes `doRender`, overlay composition, and line
 * normalization as protected seams. Clio uses those seams instead of
 * inferring frames from terminal writes: one `doRender()` is one frame, while
 * any number of terminal writes (including the regular renderer's IME cursor
 * write) can belong to that frame.
 */

import type { Terminal, TuiAltScreenOptions } from "@earendil-works/pi-tui";
import { ApplicationInputTuiAltScreen, ApplicationInputTuiMainScreen } from "./application-input-tui.js";
import { hasCopyMark, type SelectedRow, selectedRowsText, stripCopyMarks } from "./selection-text.js";

export type TuiRenderPhase = "overlay" | "normalization" | "cursor";

export interface TuiRenderObserver {
	/** Optional fast-path used after a one-shot observer has delivered its frame. */
	isEnabled?(): boolean;
	beginFrame(fields: { mode: "regular" | "fullscreen"; columns: number; rows: number }): unknown;
	endFrame(frame: unknown): void;
	beginPhase(frame: unknown, phase: TuiRenderPhase): unknown;
	endPhase(frame: unknown, phase: TuiRenderPhase, phaseToken: unknown): void;
}

export interface TuiRenderAdmission {
	readonly blocked: boolean;
	onWritable(listener: () => void): () => void;
}

class DeferredRenderAdmission {
	private pending = false;
	private force = false;
	private release: (() => void) | null = null;

	constructor(
		private readonly admission: TuiRenderAdmission | undefined,
		private readonly render: (force: boolean) => void,
	) {}

	request(force: boolean): boolean {
		if (!this.admission?.blocked) return false;
		this.pending = true;
		this.force ||= force;
		this.release ??= this.admission.onWritable(() => {
			this.release?.();
			this.release = null;
			if (!this.pending) return;
			const pendingForce = this.force;
			this.pending = false;
			this.force = false;
			this.render(pendingForce);
		});
		return true;
	}

	/** A direct/final render supersedes any older request held behind the gate. */
	settled(): void {
		this.pending = false;
		this.force = false;
		this.release?.();
		this.release = null;
	}
}

/**
 * The one array each regular-screen frame owns, without one allocation per frame.
 *
 * pi-tui's fake-cursor pass maps every row and searches it for a marker, and the render memo then keeps the mapped
 * array as the next frame's baseline. At 24,000 rows that pass was 60% of a keystroke frame, and those arrays, one
 * per frame and each past V8's large-object threshold, were what brought the 5 to 10 ms scavenges that made the p99.
 * A row resolves to the same text until its raw string changes, so only changed rows are searched, and frames reuse
 * a small pool of arrays.
 */
class RegularFrameRows {
	private readonly raw: string[] = [];
	private readonly resolved: string[] = [];
	private showHardwareCursor: boolean | undefined;
	/**
	 * Three because a frame must not write into either array the renderer reads while rendering it: the diff baseline
	 * and the memo's last output. They differ after a frame that changed nothing, which keeps the older baseline.
	 */
	private readonly pool: string[][] = [[], [], []];
	/** The last array the reset memo kept. */
	memoOutput: readonly string[] | undefined;

	next(
		lines: readonly string[],
		showHardwareCursor: boolean,
		baseline: readonly string[] | undefined,
		resolve: (line: string) => string,
		kept: number,
	): string[] {
		if (showHardwareCursor !== this.showHardwareCursor) {
			this.showHardwareCursor = showHardwareCursor;
			this.raw.length = 0;
		}
		const raw = this.raw;
		const resolved = this.resolved;
		// Without a baseline to steer around, a fresh array is the only safe one.
		const rows = (baseline && this.pool.find((rows) => rows !== baseline && rows !== this.memoOutput)) ?? [];
		// Kept rows are the strings `raw` holds, so they resolve as they did.
		const from = Math.min(kept, raw.length);
		for (let index = 0; index < from; index++) rows[index] = resolved[index] as string;
		for (let index = from; index < lines.length; index++) {
			const line = lines[index] as string;
			if (line !== raw[index]) {
				raw[index] = line;
				resolved[index] = resolve(line);
			}
			rows[index] = resolved[index] as string;
		}
		rows.length = lines.length;
		raw.length = lines.length;
		resolved.length = lines.length;
		return rows;
	}
}

export class InstrumentedTuiMainScreen extends ApplicationInputTuiMainScreen {
	constructor(
		terminal: Terminal,
		private readonly renderObserver: TuiRenderObserver,
		showHardwareCursor?: boolean,
		logDirectory?: string,
		renderAdmission?: TuiRenderAdmission,
	) {
		super(terminal, showHardwareCursor, logDirectory);
		this.deferredAdmission = new DeferredRenderAdmission(renderAdmission, (force) => super.requestRender(force));
	}

	override requestRender(force = false): void {
		if (!this.deferredAdmission.request(force)) super.requestRender(force);
	}

	/** A lone root needs no stacking, and `resolveFakeCursors` below already copies what the renderer will rewrite. */
	override render(width: number): string[] {
		const only = this.children.length === 1 ? this.children[0] : undefined;
		return only === undefined ? super.render(width) : only.render(width);
	}

	protected override resolveFakeCursors(lines: string[]): string[] {
		// The same pass runs over each overlay's rows later in the frame; those are neither this frame's rows nor cached.
		if (!this.awaitingFrameRows) return super.resolveFakeCursors(lines);
		this.awaitingFrameRows = false;
		// pi-tui keeps the baseline private; the fallback in `next` stays safe if a Pi upgrade renames it.
		const baseline = (this as unknown as { previousLines?: readonly string[] }).previousLines;
		return this.frameRows.next(
			lines,
			this.getShowHardwareCursor(),
			baseline,
			(line) => super.resolveFakeCursors([line])[0] ?? line,
			this.keptLeadingRows,
		);
	}

	/**
	 * A root that counts its renders and the leading rows each one left unchanged vouches for this frame's rows,
	 * when its last render before this frame's was the previous frame's (#428).
	 */
	protected override keptRenderedRows(_lines: string[]): number {
		const only = this.children.length === 1 ? (this.children[0] as Partial<KeptRowsRoot>) : undefined;
		const renders = only?.renderCount;
		const kept =
			typeof renders === "number" &&
			only === this.keptRoot &&
			renders === this.keptRootRenders + 1 &&
			this.awaitingFrameRows
				? (only?.keptRowCount ?? 0)
				: 0;
		this.keptRoot = only;
		this.keptRootRenders = renders ?? -1;
		return kept;
	}

	protected override doRender(): void {
		this.deferredAdmission.settled();
		this.awaitingFrameRows = true;
		if (this.renderObserver.isEnabled?.() === false) {
			super.doRender();
			return;
		}
		const frame = this.renderObserver.beginFrame({
			mode: this.mode,
			columns: this.terminal.columns,
			rows: this.terminal.rows,
		});
		this.currentFrame = frame;
		try {
			super.doRender();
		} finally {
			this.currentFrame = undefined;
			this.renderObserver.endFrame(frame);
		}
	}

	protected override compositeOverlays(lines: string[], termWidth: number, termHeight: number): string[] {
		return this.measure("overlay", () => super.compositeOverlays(lines, termWidth, termHeight));
	}

	protected override applyLineResets(lines: string[]): string[] {
		const output = this.measure("normalization", () => super.applyLineResets(lines));
		this.frameRows.memoOutput = output;
		return output;
	}

	protected override extractCursorPosition(lines: string[], height: number): { row: number; col: number } | null {
		return this.measure("cursor", () => super.extractCursorPosition(lines, height));
	}

	private measure<T>(phase: TuiRenderPhase, operation: () => T): T {
		if (this.renderObserver.isEnabled?.() === false) return operation();
		const frame = this.currentFrame;
		if (frame === undefined) return operation();
		const phaseToken = this.renderObserver.beginPhase(frame, phase);
		try {
			return operation();
		} finally {
			this.renderObserver.endPhase(frame, phase, phaseToken);
		}
	}

	private currentFrame: unknown | undefined;
	private readonly deferredAdmission: DeferredRenderAdmission;
	private readonly frameRows = new RegularFrameRows();
	private awaitingFrameRows = false;
	private keptRoot: unknown;
	private keptRootRenders = -1;
}

/** A root component that knows how many leading rows of each render are the very strings of the render before. */
interface KeptRowsRoot {
	readonly renderCount: number;
	readonly keptRowCount: number;
}

export class InstrumentedTuiAltScreen extends ApplicationInputTuiAltScreen {
	private terminalSelectionUsers = 0;
	private readonly capturesMouse: boolean;

	/** pi-tui selects transcript text, but capturing overlays consume its mouse path.
	 * Let the terminal select the stable interview screen until it closes.
	 * Untracked on the alternate screen, alternate-scroll mode (DECSET 1007) sends
	 * the wheel as arrow keys that would move the interview's choice, and those
	 * arrive identical to real arrows, so the lease turns it off too. */
	useTerminalSelection(): () => void {
		if (!this.capturesMouse) return () => {};
		if (this.terminalSelectionUsers++ === 0)
			this.terminal.write("\x1b[?1007l\x1b[?1006l\x1b[?1003l\x1b[?1002l\x1b[?1000l");
		let released = false;
		return () => {
			if (released) return;
			released = true;
			if (--this.terminalSelectionUsers !== 0) return;
			// Match pi-tui's negotiated tracking mode; focus reporting was never disabled.
			const term = process.env.TERM?.toLowerCase() ?? "";
			const multiplexed =
				process.env.TMUX !== undefined ||
				process.env.ZELLIJ !== undefined ||
				process.env.STY !== undefined ||
				term.startsWith("tmux") ||
				term.startsWith("screen");
			// 1007 comes back on because it is the common terminal default and tracking
			// supersedes it until Clio leaves the alternate screen.
			this.terminal.write(`\x1b[?1000h\x1b[?1002h${multiplexed ? "" : "\x1b[?1003h"}\x1b[?1006h\x1b[?1007h`);
		};
	}
	private currentFrame: unknown | undefined;

	constructor(
		terminal: Terminal,
		private readonly renderObserver: TuiRenderObserver,
		showHardwareCursor?: boolean,
		logDirectory?: string,
		options?: TuiAltScreenOptions,
		renderAdmission?: TuiRenderAdmission,
	) {
		super(terminal, showHardwareCursor, logDirectory, options);
		this.capturesMouse = options?.mouse ?? true;
		this.deferredAdmission = new DeferredRenderAdmission(renderAdmission, (force) => super.requestRender(force));
	}

	override requestRender(force = false): void {
		if (!this.deferredAdmission.request(force)) super.requestRender(force);
	}

	protected override doRender(): void {
		this.deferredAdmission.settled();
		if (this.renderObserver.isEnabled?.() === false) {
			super.doRender();
			return;
		}
		const frame = this.renderObserver.beginFrame({
			mode: this.mode,
			columns: this.terminal.columns,
			rows: this.terminal.rows,
		});
		this.currentFrame = frame;
		try {
			super.doRender();
		} finally {
			this.currentFrame = undefined;
			this.renderObserver.endFrame(frame);
		}
	}

	protected override compositeOverlays(lines: string[], termWidth: number, termHeight: number): string[] {
		return this.measure("overlay", () => super.compositeOverlays(lines, termWidth, termHeight));
	}

	/** Copy marks (#453) are for selection only; the painted rows and the screen pi diffs against never hold them. */
	protected override applyLineResets(lines: string[]): string[] {
		return this.measure("normalization", () => {
			for (let row = 0; row < lines.length; row++) {
				const line = lines[row];
				if (line !== undefined && hasCopyMark(line)) lines[row] = stripCopyMarks(line);
			}
			return super.applyLineResets(lines);
		});
	}

	/** Fullscreen copy of a wrapped paragraph is one line without the glyph or gutter (#453). */
	protected override selectionText(rows: readonly SelectedRow[]): string {
		return selectedRowsText(rows);
	}

	protected override extractCursorPosition(lines: string[], height: number): { row: number; col: number } | null {
		return this.measure("cursor", () => super.extractCursorPosition(lines, height));
	}

	private measure<T>(phase: TuiRenderPhase, operation: () => T): T {
		if (this.renderObserver.isEnabled?.() === false) return operation();
		const frame = this.currentFrame;
		if (frame === undefined) return operation();
		const phaseToken = this.renderObserver.beginPhase(frame, phase);
		try {
			return operation();
		} finally {
			this.renderObserver.endPhase(frame, phase, phaseToken);
		}
	}

	private readonly deferredAdmission: DeferredRenderAdmission;
}

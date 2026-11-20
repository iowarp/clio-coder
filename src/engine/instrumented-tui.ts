/**
 * Render-transaction hooks around pi-tui's two concrete renderers.
 *
 * pi-tui deliberately exposes `doRender`, overlay composition, and line
 * normalization as protected seams. Clio uses those seams instead of
 * inferring frames from terminal writes: one `doRender()` is one frame, while
 * any number of terminal writes (including the regular renderer's IME cursor
 * write) can belong to that frame.
 */

import type { Terminal, TuiAltScreenOptions, TuiStopOptions } from "@earendil-works/pi-tui";
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

/** A width change within this long of the one before belongs to the same window-edge drag. */
const WIDTH_SETTLE_MS = 100;

/**
 * Coalesces a run of width changes into one re-wrap when it pauses.
 *
 * pi-tui asks for a frame on every resize event at its 16 ms throttle, and a frame at a new width re-wraps the whole
 * transcript, about 150 ms at 19,000 rows, so dragging a window edge stuttered. The first width change after a quiet
 * spell still renders at once. A change within `WIDTH_SETTLE_MS` of the one before starts or restarts one trailing
 * render, and until it fires no frame paints at a width the last frame did not have. A height-only change, a forced
 * request and a direct `renderNow` frame always paint.
 */
class WidthChangeCoalescer {
	private paintedColumns: number | undefined;
	private seenColumns: number | undefined;
	private lastChangeAt = Number.NEGATIVE_INFINITY;
	private trailing: ReturnType<typeof setTimeout> | undefined;
	/** Set by a forced request or a direct frame, which must paint whatever the width did. */
	bypass = false;

	constructor(private readonly render: () => void) {}

	/** Whether a frame at `columns` waits for the drag to pause. */
	defer(columns: number): boolean {
		if (this.paintedColumns === undefined || this.bypass) return false;
		if (columns !== this.seenColumns) {
			const now = Date.now();
			const midDrag = now - this.lastChangeAt < WIDTH_SETTLE_MS;
			this.seenColumns = columns;
			this.lastChangeAt = now;
			if (midDrag) {
				this.cancel();
				this.trailing = setTimeout(() => {
					this.trailing = undefined;
					this.render();
				}, WIDTH_SETTLE_MS);
				this.trailing.unref?.();
			}
		}
		return this.trailing !== undefined && columns !== this.paintedColumns;
	}

	painted(columns: number): void {
		this.paintedColumns = columns;
		this.seenColumns ??= columns;
		this.bypass = false;
	}

	cancel(): void {
		if (this.trailing === undefined) return;
		clearTimeout(this.trailing);
		this.trailing = undefined;
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
	private readonly pool = Array.from({ length: 3 }, () => ({ rows: [] as string[], validPrefix: 0 }));
	/** The last array the reset memo kept. */
	memoOutput: readonly string[] | undefined;

	invalidate(): void {
		for (const slot of this.pool) slot.validPrefix = 0;
	}

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
		const slot = baseline && this.pool.find(({ rows }) => rows !== baseline && rows !== this.memoOutput);
		const rows = slot?.rows ?? [];
		const from = Math.min(kept, raw.length);
		// Only this offscreen region is safe to leave normalized: nothing reads it before pi-tui copies the reset
		// memo's prefix over it. The renderer reports zero kept rows on resize or while any overlay is mounted.
		for (const slot of this.pool) slot.validPrefix = Math.min(slot.validPrefix, from);
		for (let index = slot?.validPrefix ?? 0; index < from; index++) rows[index] = resolved[index] as string;
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
		if (slot !== undefined) slot.validPrefix = from;
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
		this.widthChanges = new WidthChangeCoalescer(() => this.requestRender());
	}

	override requestRender(force = false): void {
		if (force) this.widthChanges.bypass = true;
		if (!this.deferredAdmission.request(force)) super.requestRender(force);
	}

	override renderNow(force = false): void {
		this.widthChanges.bypass = true;
		super.renderNow(force);
	}

	override stop(options?: TuiStopOptions): void {
		this.widthChanges.cancel();
		this.invalidateFrameRows();
		super.stop(options);
	}

	protected override resetRenderState(): void {
		super.resetRenderState();
		this.frameRows.memoOutput = undefined;
		this.invalidateFrameRows();
	}

	private invalidateFrameRows(): void {
		this.frameRows.invalidate();
		this.keptRoot = undefined;
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
		const columns = this.terminal.columns;
		if (this.widthChanges.defer(columns)) return;
		this.widthChanges.painted(columns);
		const showHardwareCursor = this.getShowHardwareCursor();
		if (showHardwareCursor !== this.paintedHardwareCursor) this.invalidateFrameRows();
		this.paintedHardwareCursor = showHardwareCursor;
		this.awaitingFrameRows = true;
		const redraws = this.fullRedraws;
		const observed = this.renderObserver.isEnabled?.() !== false;
		const frame = observed
			? this.renderObserver.beginFrame({ mode: this.mode, columns, rows: this.terminal.rows })
			: undefined;
		this.currentFrame = frame;
		try {
			super.doRender();
		} catch (error) {
			this.invalidateFrameRows();
			throw error;
		} finally {
			if (redraws !== this.fullRedraws) this.invalidateFrameRows();
			this.currentFrame = undefined;
			if (observed) this.renderObserver.endFrame(frame);
		}
	}

	protected override compositeOverlays(lines: string[], termWidth: number, termHeight: number): string[] {
		return this.measure("overlay", () => super.compositeOverlays(lines, termWidth, termHeight));
	}

	protected override applyLineResets(lines: string[]): string[] {
		return this.measure("normalization", () => {
			const output = super.applyLineResets(lines);
			this.frameRows.memoOutput = output;
			return output;
		});
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
	private readonly widthChanges: WidthChangeCoalescer;
	private readonly frameRows = new RegularFrameRows();
	private awaitingFrameRows = false;
	private paintedHardwareCursor: boolean | undefined;
	private keptRoot: unknown;
	private keptRootRenders = -1;
}

/**
 * Multiplexers can lag when every pointer movement is forwarded, so inside one the
 * fullscreen TUI keeps button-motion tracking: clicks, wheel, drags and selections.
 * pi-tui's own check, plus Herdr, which sets none of the variables it reads.
 */
function multiplexed(): boolean {
	const env = process.env;
	const term = env.TERM?.toLowerCase() ?? "";
	return (
		env.TMUX !== undefined ||
		env.ZELLIJ !== undefined ||
		env.STY !== undefined ||
		env.HERDR_ENV !== undefined ||
		term.startsWith("tmux") ||
		term.startsWith("screen")
	);
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
			// Match the start's tracking mode; focus reporting was never disabled.
			// 1007 comes back on because it is the common terminal default and tracking
			// supersedes it until Clio leaves the alternate screen.
			this.terminal.write(`\x1b[?1000h\x1b[?1002h${multiplexed() ? "" : "\x1b[?1003h"}\x1b[?1006h\x1b[?1007h`);
		};
	}
	private currentFrame: unknown | undefined;
	private paintedColumns: number | undefined;

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
		this.widthChanges = new WidthChangeCoalescer(() => this.requestRender());
	}

	override requestRender(force = false): void {
		if (force) this.widthChanges.bypass = true;
		if (!this.deferredAdmission.request(force)) super.requestRender(force);
	}

	override renderNow(force = false): void {
		this.widthChanges.bypass = true;
		super.renderNow(force);
	}

	override stop(options?: TuiStopOptions): void {
		this.widthChanges.cancel();
		super.stop(options);
	}

	protected override beforeTerminalStart(): void {
		super.beforeTerminalStart();
		// pi-tui asks for every pointer movement unless it recognises the multiplexer; Herdr it does not.
		// Resetting any tracking mode turns mouse reporting off entirely, so button motion is asked for again.
		if (this.capturesMouse && multiplexed()) this.terminal.write("\x1b[?1003l\x1b[?1002h");
	}

	protected override doRender(): void {
		this.deferredAdmission.settled();
		// pi-tui keeps a selection as content row and column, and a new width re-wraps
		// every row, so the old selection would highlight text the operator never chose.
		// A height-only change moves no content row and keeps it.
		const columns = this.terminal.columns;
		if (this.widthChanges.defer(columns)) return;
		this.widthChanges.painted(columns);
		if (this.paintedColumns !== undefined && columns !== this.paintedColumns) this.resetTextSelection();
		this.paintedColumns = columns;
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
	private readonly widthChanges: WidthChangeCoalescer;
}

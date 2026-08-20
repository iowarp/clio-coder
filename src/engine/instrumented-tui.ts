/**
 * Render-transaction hooks around pi-tui's two concrete renderers.
 *
 * pi-tui deliberately exposes `doRender`, overlay composition, and line
 * normalization as protected seams. Clio uses those seams instead of
 * inferring frames from terminal writes: one `doRender()` is one frame, while
 * any number of terminal writes (including the regular renderer's IME cursor
 * write) can belong to that frame.
 */

import { type Terminal, TuiAltScreen, type TuiAltScreenOptions, TuiMainScreen } from "@earendil-works/pi-tui";

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

export class InstrumentedTuiMainScreen extends TuiMainScreen {
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

	protected override applyLineResets(lines: string[]): string[] {
		return this.measure("normalization", () => super.applyLineResets(lines));
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
}

export class InstrumentedTuiAltScreen extends TuiAltScreen {
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

	protected override applyLineResets(lines: string[]): string[] {
		return this.measure("normalization", () => super.applyLineResets(lines));
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

import type { ConfigureWizardHost, HostedTargetOptions } from "../cli/configure-host.js";
import type { SelectOptions, SelectResult, TextPromptOptions, TextResult } from "../cli/select.js";
import type { Component, OverlayHandle, TUI } from "../engine/tui.js";
import { Input, isKeyRelease, matchesKey, stripTerminalSequences, wrapTextWithAnsi } from "../engine/tui.js";
import { backOutOneLayer, type EscapeLayers, escapeHintEntry } from "./escape-layers.js";
import { maybeOpenExternalUrl } from "./open-external-url.js";
import type { RowBudgetedBody } from "./overlay-frame.js";
import {
	buildResponsiveHint,
	centeredWindow,
	FILTER_HINT,
	fitRows,
	selectionLabel,
	selectionMark,
	showClioOverlayFrame,
} from "./overlay-frame.js";
import { clioTheme } from "./theme/index.js";

interface PendingChoice {
	kind: "select";
	options: SelectOptions<unknown>;
	selected: number;
	finish: (result: SelectResult<unknown>) => void;
}
interface PendingText {
	kind: "text";
	options: TextPromptOptions;
	finish: (result: TextResult) => void;
}

/** A text step's identity across visits: what it asks, which is the same each time the wizard walks onto it. */
function textStepKey(options: TextPromptOptions): string {
	const heading = options.heading;
	return JSON.stringify([typeof heading === "string" ? [heading] : [...(heading ?? [])], options.hint ?? ""]);
}

/** #385: prompts are dock components; the shared CLI wizard retains every step and write. */
export class TargetWizardSurface implements Component, RowBudgetedBody, ConfigureWizardHost {
	private readonly abort = new AbortController();
	readonly signal = this.abort.signal;
	private pending: PendingChoice | PendingText | null = null;
	private readonly input = new Input();
	private messages: string[] = [];
	/** Where the reports since the last answer start: the prompt on screen shows every one, because they say why it is there. */
	private freshFrom = 0;
	private bodyRows = 16;
	private complete = false;
	private problem = "";
	private waitLabel: string | null = null;
	/** Stops the wait on screen without leaving the wizard (a browser sign-in); null when nothing can be stopped. */
	private stopWait: (() => void) | null = null;
	/** Esc walks back one step, and the rail promises Ctrl+C leaves the wizard. */
	readonly ownsCtrlC = true;
	/** Answers the wizard has taken and not gone back over: none means Esc leaves the wizard rather than a step. */
	private answered = 0;
	/** Text typed into a step and left with Esc, by step, so walking forward again finds it. Masked steps keep nothing. */
	private readonly keptText = new Map<string, string>();

	constructor(
		private readonly requestRender: () => void,
		private readonly close: () => void,
	) {}

	get keyboardScope(): "edit" | "review" {
		return this.pending?.kind === "text" || (this.pending?.kind === "select" && this.pending.options.searchable)
			? "edit"
			: "review";
	}

	undoInput(): boolean {
		if (this.keyboardScope !== "edit") return false;
		this.input.applyEdit("undo");
		return true;
	}

	setBodyRows(rows: number): void {
		this.bodyRows = Math.max(1, rows);
	}
	cancelled(): boolean {
		return this.signal.aborted;
	}
	clearMessages(): void {
		this.messages = [];
		this.freshFrom = 0;
	}
	report(line: string): void {
		this.messages.push(stripTerminalSequences(line));
		this.requestRender();
	}
	waiting(label: string | null): void {
		this.waitLabel = label;
		this.requestRender();
	}
	openUrl(url: string): void {
		maybeOpenExternalUrl(url);
	}
	stoppableWait(stop: (() => void) | null): void {
		this.stopWait = stop;
		this.requestRender();
	}
	dismissPrompt(): void {
		const pending = this.pending;
		this.pending = null;
		pending?.finish({ kind: "quit" });
		this.requestRender();
	}
	cancel(): void {
		this.abort.abort();
		this.dismissPrompt();
	}

	select<T>(options: SelectOptions<T>): Promise<SelectResult<T>> {
		if (this.cancelled()) return Promise.resolve({ kind: "quit" });
		this.input.setValue("");
		this.waitLabel = null;
		return new Promise((resolve) => {
			this.pending = {
				kind: "select",
				options: options as SelectOptions<unknown>,
				selected: options.initialIndex ?? 0,
				finish: (result) => resolve(result as SelectResult<T>),
			};
			this.problem = "";
			this.requestRender();
		});
	}

	text(options: TextPromptOptions): Promise<TextResult> {
		if (this.cancelled()) return Promise.resolve({ kind: "quit" });
		const kept = options.mask ? undefined : this.keptText.get(textStepKey(options));
		this.input.setValue(kept ?? options.initial ?? "");
		this.input.handleInput("\x1b[F");
		this.waitLabel = null;
		return new Promise((resolve) => {
			this.pending = { kind: "text", options, finish: resolve };
			this.problem = "";
			this.requestRender();
		});
	}

	async start(options: HostedTargetOptions): Promise<number> {
		try {
			const { runHostedTargetWizard } = await import("../cli/configure-host.js");
			const code = await runHostedTargetWizard(this, options);
			this.complete = true;
			this.requestRender();
			return code;
		} catch (error) {
			this.report(error instanceof Error ? error.message : String(error));
			this.complete = true;
			return 1;
		}
	}

	private choices(pending: PendingChoice): number[] {
		const query = this.input.getValue().toLowerCase();
		return pending.options.choices.flatMap((choice, index) =>
			!pending.options.searchable || `${choice.label} ${choice.hint ?? ""}`.toLowerCase().includes(query) ? [index] : [],
		);
	}

	handleInput(data: string): void {
		if (isKeyRelease(data)) return;
		if (matchesKey(data, "ctrl+c")) {
			this.cancel();
			this.close();
			return;
		}
		if (matchesKey(data, "escape")) {
			backOutOneLayer(this.escapeLayers());
			return;
		}
		const pending = this.pending;
		if (!pending) {
			if (this.complete && matchesKey(data, "enter")) this.close();
			return;
		}
		if (matchesKey(data, "enter")) {
			if (pending.kind === "text") {
				const value = this.input.getValue();
				this.problem = pending.options.validate?.(value) ?? "";
				if (this.problem) {
					this.requestRender();
					return;
				}
				this.pending = null;
				this.answered += 1;
				this.freshFrom = this.messages.length;
				this.keptText.delete(textStepKey(pending.options));
				pending.finish({ kind: "value", value });
			} else {
				const choice = pending.options.choices[pending.selected];
				if (choice && this.choices(pending).includes(pending.selected)) {
					this.pending = null;
					this.answered += 1;
					this.freshFrom = this.messages.length;
					pending.finish({ kind: "selected", value: choice.value });
				}
			}
			return;
		}
		if (pending.kind === "select" && (matchesKey(data, "up") || matchesKey(data, "down"))) {
			const choices = this.choices(pending);
			const delta = matchesKey(data, "up") ? -1 : 1;
			const at = Math.max(0, choices.indexOf(pending.selected));
			pending.selected = choices[(at + delta + choices.length) % choices.length] ?? 0;
		} else if (this.keyboardScope === "edit") {
			this.input.handleInput(data);
			if (pending.kind === "select" && !this.choices(pending).includes(pending.selected))
				pending.selected = this.choices(pending)[0] ?? 0;
		}
		this.requestRender();
	}

	render(width: number): string[] {
		const theme = clioTheme();
		const pending = this.pending;
		const rows: string[] = [];
		if (!pending) {
			// Newest rows win: a wrapped sign-in link would otherwise push what the wizard is waiting on out of the body.
			const log = this.messages.flatMap((line) => wrapTextWithAnsi(line, width));
			rows.push(...log.slice(-Math.max(1, this.bodyRows - 1)));
			rows.push(
				theme.fg("annotation", this.complete ? "Enter returns to Settings" : (this.waitLabel ?? "Reading target details…")),
			);
			return fitRows(rows, width, this.bodyRows);
		}
		// A prompt that follows a failure is there because of it, so everything reported since the last answer stays up.
		const fresh = this.messages.slice(this.freshFrom);
		for (const line of fresh.length > 0 ? fresh : this.messages.slice(-1))
			rows.push(...wrapTextWithAnsi(theme.fg("body", line), width));
		const heading = pending.options.heading;
		const headings = (typeof heading === "string" ? [heading] : [...(heading ?? [])]).filter((line) => line.trim());
		for (const line of headings) rows.push(...wrapTextWithAnsi(stripTerminalSequences(line), width));
		if (pending.kind === "text" && pending.options.hint) rows.push(...wrapTextWithAnsi(pending.options.hint, width));
		if (this.problem) rows.push(theme.fg("error", this.problem));
		// Prompt controls keep their rows even when review instructions wrap at 40 columns.
		const room = Math.max(1, this.bodyRows - Math.min(rows.length, this.bodyRows - 2));
		rows.length = Math.min(rows.length, Math.max(0, this.bodyRows - room));
		if (pending.kind === "text") {
			rows.push(
				...(pending.options.mask
					? [theme.fg("inputText", "•".repeat(this.input.getValue().length))]
					: this.input.render(width).map((line) => theme.base("inputText", line))),
			);
		} else {
			const choices = this.choices(pending);
			if (pending.options.searchable) rows.push(theme.fg("searchQuery", `Filter: ${this.input.getValue()}`));
			const height = Math.max(1, this.bodyRows - rows.length);
			const [start, end] = centeredWindow(choices.length, choices.indexOf(pending.selected), height);
			if (!choices.length) rows.push(theme.fg("emptyState", "No matching choices"));
			for (const index of choices.slice(start, end)) {
				const choice = pending.options.choices[index];
				if (!choice) continue;
				const selected = index === pending.selected;
				rows.push(
					`${selectionMark(selected)} ${selectionLabel(selected, stripTerminalSequences(choice.label))}${choice.hint ? theme.fg("annotation", ` · ${stripTerminalSequences(choice.hint)}`) : ""}`,
				);
			}
		}
		return fitRows(rows, width, this.bodyRows);
	}

	invalidate(): void {}

	/**
	 * Esc by the shared rule: a step with an answer behind it goes back to that
	 * answer, keeping typed text; the first step has nothing behind it, so Esc
	 * leaves the wizard and returns to Settings at once, with nothing saved. It
	 * used to send the first step a `back` the flow read as a cancel, which
	 * printed a cancelled page that took a second Esc to leave.
	 */
	private escapeLayers(): EscapeLayers {
		const pending = this.pending;
		const leave = (): void => {
			this.cancel();
			this.close();
		};
		const stopWait = this.stopWait;
		return [
			pending === null &&
				stopWait !== null && {
					verb: "stop waiting, back a step",
					short: "stop waiting",
					back: () => {
						this.stopWait = null;
						stopWait();
					},
				},
			pending !== null &&
				this.answered > 0 && {
					verb: pending.kind === "text" && !pending.options.mask ? "back, keeps draft" : "back a step",
					short: "back",
					back: () => this.stepBack(pending),
				},
			this.complete && { verb: "back to Settings", back: () => this.close() },
			{ verb: "cancel, nothing saved", short: "cancel", back: leave },
		];
	}

	private stepBack(pending: PendingChoice | PendingText): void {
		if (pending.kind === "text" && !pending.options.mask) {
			const typed = this.input.getValue();
			const key = textStepKey(pending.options);
			if (typed !== (pending.options.initial ?? "") && typed.trim().length > 0) this.keptText.set(key, typed);
			else this.keptText.delete(key);
		}
		this.pending = null;
		this.answered = Math.max(0, this.answered - 1);
		this.freshFrom = this.messages.length;
		pending.finish({ kind: "back" });
	}

	/** The rail for the step on screen: a finished wizard offers only the way out, and Enter and Esc both take it. */
	railHint(innerWidth: number): string {
		const pending = this.pending;
		const esc = escapeHintEntry(this.escapeLayers());
		if (!pending) {
			return this.complete
				? buildResponsiveHint([], { key: "Enter/Esc", verb: "back to Settings" })(innerWidth)
				: buildResponsiveHint(
						this.stopWait === null ? [] : [{ key: "Ctrl+C", verb: "cancel, nothing saved", short: "cancel" }],
						esc,
					)(innerWidth);
		}
		return buildResponsiveHint(
			[
				...(pending.kind === "select"
					? [{ key: "↑↓", verb: "choose" }, ...(pending.options.searchable ? [FILTER_HINT] : [])]
					: []),
				{ key: "Enter", verb: "continue" },
				...(this.answered > 0 ? [{ key: "Ctrl+C", verb: "cancel, nothing saved", short: "cancel" }] : []),
			],
			esc,
		)(innerWidth);
	}
}

export function openTargetWizard(tui: TUI, options: HostedTargetOptions, onClose: () => void): OverlayHandle {
	let handle: OverlayHandle | undefined;
	const close = (): void => {
		handle?.hide();
		onClose();
		tui.requestRender();
	};
	const body = new TargetWizardSurface(() => tui.requestRender(), close);
	handle = showClioOverlayFrame(tui, body, {
		title: options.mode === "edit" ? `Edit target: ${options.target.id}` : "Add target",
		markerId: "target-wizard",
		footerHint: (innerWidth) => body.railHint(innerWidth),
	});
	void body.start(options);
	return {
		...handle,
		hide() {
			body.cancel();
			handle?.hide();
		},
	};
}

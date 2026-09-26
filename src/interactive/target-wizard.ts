import type { ConfigureWizardHost, HostedTargetOptions } from "../cli/configure-host.js";
import type { SelectOptions, SelectResult, TextPromptOptions, TextResult } from "../cli/select.js";
import type { Component, OverlayHandle, TUI } from "../engine/tui.js";
import { Input, isKeyRelease, matchesKey, stripTerminalSequences, wrapTextWithAnsi } from "../engine/tui.js";
import type { RowBudgetedBody } from "./overlay-frame.js";
import {
	buildResponsiveHint,
	centeredWindow,
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

/** #385: prompts are dock components; the shared CLI wizard retains every step and write. */
export class TargetWizardSurface implements Component, RowBudgetedBody, ConfigureWizardHost {
	private readonly abort = new AbortController();
	readonly signal = this.abort.signal;
	private pending: PendingChoice | PendingText | null = null;
	private readonly input = new Input();
	private messages: string[] = [];
	private bodyRows = 16;
	private complete = false;
	private problem = "";

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
	}
	report(line: string): void {
		this.messages.push(stripTerminalSequences(line));
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
		this.input.setValue(options.initial ?? "");
		this.input.handleInput("\x1b[F");
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
		const pending = this.pending;
		if (!pending) {
			if (matchesKey(data, "escape")) {
				this.cancel();
				this.close();
			} else if (this.complete && matchesKey(data, "enter")) this.close();
			return;
		}
		if (matchesKey(data, "escape")) {
			this.pending = null;
			pending.finish({ kind: "back" });
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
				pending.finish({ kind: "value", value });
			} else {
				const choice = pending.options.choices[pending.selected];
				if (choice && this.choices(pending).includes(pending.selected)) {
					this.pending = null;
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
			rows.push(...this.messages.slice(-Math.max(1, this.bodyRows - 1)).flatMap((line) => wrapTextWithAnsi(line, width)));
			rows.push(theme.fg("annotation", this.complete ? "Enter returns to Settings" : "Reading target details…"));
			return fitRows(rows, width, this.bodyRows);
		}
		if (this.messages.length) rows.push(theme.fg("body", this.messages.at(-1) ?? ""));
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
		footerHint: buildResponsiveHint(
			[
				{ key: "↑↓", verb: "choose" },
				{ key: "Enter", verb: "continue" },
				{ key: "Ctrl+C", verb: "cancel" },
			],
			"back",
		),
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

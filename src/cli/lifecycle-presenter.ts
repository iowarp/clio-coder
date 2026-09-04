import { type Dirent, lstatSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { stdin as defaultInput, stdout as defaultOutput } from "node:process";
import { createInterface } from "node:readline/promises";
import chalk from "chalk";

import { terminalColumns, wrapPlain } from "./text-layout.js";

export interface LifecyclePresenterOptions {
	json?: boolean;
	plain?: boolean;
	stream?: NodeJS.WritableStream;
	inputStream?: NodeJS.ReadableStream;
	/** Terminal width used to wrap prose. Defaults to the stream's columns, else 80. */
	columns?: number;
}

export type LifecycleItemStatus = "remove" | "keep" | "absent" | "skip" | "clean";

// `| undefined` on every optional field is required, not decorative: the repo
// compiles with exactOptionalPropertyTypes, and every inventory in reset and
// uninstall builds these rows from a conditional that can produce undefined.
export interface LifecycleItem {
	label: string;
	path: string;
	bytes?: number | null | undefined;
	status?: LifecycleItemStatus | undefined;
	detail?: string | undefined;
}

export interface LifecycleReport {
	command: string;
	title: string;
	method?: string;
	status: "success" | "skipped" | "dry-run" | "error";
	items: LifecycleItem[];
	steps: Array<{ type: string; message: string }>;
	warnings: string[];
	errors: string[];
	advice: Array<{ lead: string; command: string }>;
	summary?: string;
}

/**
 * One decimal above the byte range, which is the precision a size on a lifecycle
 * listing is read at: the operator wants to know whether a root is megabytes or
 * gigabytes before agreeing to delete it, not its third significant figure.
 *
 * Not `formatSize` from pi-agent-core, which this otherwise matches. That one
 * stops at megabytes, so a data root holding evidence and vendored tools reads
 * as `4300.8MB` where the question being asked is whether it is gigabytes; and
 * it writes no space before the unit, which is fine inside a tool observation
 * and wrong in a column of paths a person is scanning.
 */
export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	const units = ["KB", "MB", "GB", "TB"];
	let value = bytes / 1024;
	let unitIndex = 0;
	while (value >= 1024 && unitIndex < units.length - 1) {
		value /= 1024;
		unitIndex += 1;
	}
	return `${value.toFixed(1)} ${units[unitIndex]}`;
}

export function measurePath(targetPath: string): {
	bytes: number;
	exists: boolean;
	isDirectory: boolean;
	isSymbolicLink: boolean;
} {
	let stats: ReturnType<typeof lstatSync>;
	try {
		stats = lstatSync(targetPath);
	} catch {
		return { bytes: 0, exists: false, isDirectory: false, isSymbolicLink: false };
	}
	if (stats.isSymbolicLink()) {
		return { bytes: stats.size, exists: true, isDirectory: false, isSymbolicLink: true };
	}
	if (!stats.isDirectory()) {
		return { bytes: stats.size, exists: true, isDirectory: false, isSymbolicLink: false };
	}

	let total = 0;
	// A symlinked subdirectory is counted as the link it is and never descended
	// into, so a root that links out to a shared tree reports its own footprint
	// and the walk cannot loop.
	function walk(dir: string): void {
		let entries: Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const full = join(dir, entry.name);
			try {
				if (entry.isDirectory()) walk(full);
				else total += lstatSync(full).size;
			} catch {
				// An entry that vanished or cannot be read contributes nothing.
			}
		}
	}
	walk(targetPath);
	return { bytes: total, exists: true, isDirectory: true, isSymbolicLink: false };
}

export function shortenPath(targetPath: string, home = homedir()): string {
	if (!targetPath) return targetPath;
	if (targetPath === home) return "~";
	if (targetPath.startsWith(`${home}/`) || targetPath.startsWith(`${home}\\`)) {
		return `~/${targetPath.slice(home.length + 1)}`;
	}
	return targetPath;
}

/**
 * The kinds of block the rail knows how to space. One blank rail separates two
 * adjacent blocks of different kinds; consecutive blocks of the same kind (a run
 * of detected facts, a run of completed steps) stay together, which is what
 * makes the transcript read as groups rather than as one padded line per call.
 * Spacing lives here rather than in each emitter so no caller can produce a
 * transcript with a doubled or a missing separator.
 */
type Block = "header" | "step" | "list" | "warn" | "note" | "advice" | "completed" | "message" | "confirm";

export class LifecyclePresenter {
	private readonly json: boolean;
	private readonly plain: boolean;
	private readonly out: NodeJS.WritableStream;
	private readonly in: NodeJS.ReadableStream;
	private readonly columns: number;
	private readonly report: LifecycleReport;
	private lastBlock: Block | null = null;
	private emitted = false;

	constructor(options: LifecyclePresenterOptions = {}) {
		this.json = Boolean(options.json);
		const stream = options.stream ?? defaultOutput;
		const isTty = Boolean((stream as { isTTY?: boolean }).isTTY);
		this.plain = options.plain ?? (!isTty || Boolean(process.env.NO_COLOR));
		this.out = stream;
		this.in = options.inputStream ?? defaultInput;
		// terminalColumns also reads $COLUMNS, so a piped or captured run can be
		// told how wide it is instead of being pinned to 80.
		this.columns = options.columns ?? terminalColumns(stream as { columns?: number | undefined });
		this.report = {
			command: "",
			title: "",
			status: "success",
			items: [],
			steps: [],
			warnings: [],
			errors: [],
			advice: [],
		};
	}

	isJson(): boolean {
		return this.json;
	}

	isPlain(): boolean {
		return this.plain;
	}

	getReport(): LifecycleReport {
		return this.report;
	}

	setMethod(method: string): void {
		this.report.method = method;
	}

	/** Open a block, writing the one separator that belongs before it. */
	private open(block: Block): void {
		if (this.lastBlock !== null && this.lastBlock !== block) this.separator();
		this.lastBlock = block;
	}

	private separator(): void {
		this.out.write(this.plain ? "\n" : `${chalk.cyan("│")}\n`);
	}

	/**
	 * Close the current block, for a caller that is about to draw its own lines
	 * on the rail. `configure` hands the rail to the arrow-key selector after
	 * rendering a screen's values, and the selector cannot know what came before
	 * it.
	 */
	blank(): void {
		if (this.json) return;
		this.separator();
		this.lastBlock = null;
	}

	/** Rail-level prose, wrapped to the terminal so the rail survives a narrow window. */
	private prose(text: string): void {
		const prefix = this.plain ? "  " : `${chalk.cyan("│")}  `;
		for (const line of wrapPlain(text, this.columns - 3)) this.out.write(`${prefix}${line}\n`);
	}

	header(title: string, command = ""): void {
		this.report.title = title;
		this.report.command = command;
		if (this.json) return;
		if (this.plain) {
			this.out.write(`\n${title}\n`);
		} else {
			this.out.write(`\n${chalk.cyan("┌")}  ${chalk.bold(title)}\n`);
		}
		this.lastBlock = "header";
	}

	/** One detected fact. Consecutive facts group into a single block. */
	step(text: string): void {
		this.report.steps.push({ type: "step", message: text });
		if (this.json) return;
		this.open("step");
		if (this.plain) this.out.write(`  ${text}\n`);
		else this.out.write(`${chalk.blue("●")}  ${text}\n`);
	}

	/** A line of prose on the rail, not a detected fact. */
	note(text: string): void {
		this.report.steps.push({ type: "note", message: text });
		if (this.json) return;
		this.open("note");
		this.prose(text);
	}

	/**
	 * Aligned label/value rows for a settings screen. Not `note()`, because
	 * these must not reflow: the column is what makes eight values scannable,
	 * and a wrap would put the value under the wrong label.
	 */
	fields(rows: ReadonlyArray<readonly [string, string]>): void {
		for (const [label, value] of rows) this.report.steps.push({ type: "field", message: `${label}: ${value}` });
		if (this.json || rows.length === 0) return;
		this.open("step");
		const width = Math.max(...rows.map(([label]) => label.length));
		for (const [label, value] of rows) {
			const padded = `${label}${" ".repeat(width - label.length)}`;
			if (this.plain) this.out.write(`  ${padded}  ${value}\n`);
			else this.out.write(`${chalk.blue("●")}  ${chalk.dim(padded)}  ${value}\n`);
		}
	}

	substep(text: string, glyph = "✓"): void {
		this.report.steps.push({ type: "substep", message: text });
		if (this.json) return;
		this.open("list");
		if (this.plain) {
			this.out.write(`    ${glyph} ${text}\n`);
			return;
		}
		const coloredGlyph = glyph === "✓" ? chalk.green(glyph) : chalk.dim(glyph);
		this.out.write(`${chalk.blue("●")}    ${coloredGlyph} ${text}\n`);
	}

	listItems(header: string, items: ReadonlyArray<LifecycleItem>): void {
		for (const item of items) {
			this.report.items.push(item);
		}
		if (this.json) return;

		this.open("note");
		this.prose(`${header}:`);
		this.open("list");

		for (const item of items) {
			const sizeStr =
				item.status !== "absent" && item.bytes !== undefined && item.bytes !== null ? ` (${formatBytes(item.bytes)})` : "";
			const removes = item.status === undefined || item.status === "remove";
			let suffix = "";
			if (item.status === "keep") suffix = item.detail ? ` (${item.detail})` : " (kept)";
			else if (item.status === "absent") suffix = item.detail ? ` (${item.detail})` : " (absent)";
			else if (item.status === "skip") suffix = item.detail ? ` (${item.detail})` : " (skipped)";
			else if (item.status === "clean") suffix = item.detail ? ` (${item.detail})` : " (nothing to remove)";
			else if (item.detail) suffix = ` (${item.detail})`;

			const body = `${item.label}: ${shortenPath(item.path)}${sizeStr}`;
			if (this.plain) {
				this.out.write(`    ${removes ? "✓" : "–"} ${body}${suffix}\n`);
				continue;
			}
			const glyph = removes ? chalk.green("✓") : item.status === "skip" ? chalk.yellow("–") : chalk.dim("–");
			const tail = suffix.length === 0 ? "" : item.status === "skip" ? chalk.yellow(suffix) : chalk.dim(suffix);
			this.out.write(
				`${chalk.blue("●")}    ${glyph} ${chalk.bold(item.label)}: ${shortenPath(item.path)}${sizeStr}${tail}\n`,
			);
		}
	}

	/** One action that has already happened. Consecutive results group together. */
	completedStep(text: string): void {
		this.report.steps.push({ type: "completed", message: text });
		if (this.json) return;
		this.open("completed");
		if (this.plain) this.out.write(`  ✓ ${text}\n`);
		else this.out.write(`${chalk.green("◇")}  ${text}\n`);
	}

	warn(text: string): void {
		this.report.warnings.push(text);
		if (this.json) return;
		this.open("warn");
		if (this.plain) {
			for (const line of wrapPlain(text, this.columns - 3)) this.out.write(`  ${line}\n`);
			return;
		}
		const prefix = `${chalk.yellow("▲")}  `;
		const continuation = `${chalk.cyan("│")}  `;
		wrapPlain(text, this.columns - 3).forEach((line, index) => {
			this.out.write(`${index === 0 ? prefix : continuation}${chalk.yellow(line)}\n`);
		});
	}

	/**
	 * Record a failure and say it once on stderr. The JSON report is not written
	 * here: a command that fails still has advice to add, and emitting mid-flight
	 * either dropped it or put a second document on stdout. Callers end on
	 * `finish()`.
	 */
	fail(message: string, detail?: string): void {
		this.report.status = "error";
		this.report.errors.push(detail ? `${message}: ${detail}` : message);
		if (this.json) return;
		if (this.plain) {
			process.stderr.write(`error: ${message}\n`);
			if (detail) process.stderr.write(`  ${detail}\n`);
			return;
		}
		process.stderr.write(`${chalk.red("✖")}  ${chalk.red(message)}\n`);
		if (detail) process.stderr.write(`${chalk.cyan("│")}  ${chalk.dim(detail)}\n`);
	}

	commandAdvice(lead: string, command: string): void {
		this.report.advice.push({ lead, command });
		if (this.json) return;
		this.open("advice");
		this.prose(lead);
		for (const line of command.split("\n")) {
			if (this.plain) this.out.write(`    ${line}\n`);
			else this.out.write(`${chalk.blue("●")}    ${chalk.cyan(line)}\n`);
		}
	}

	message(text: string): void {
		this.report.steps.push({ type: "message", message: text });
		if (this.json) return;
		this.open("message");
		if (this.plain) this.out.write(`  ${text}\n`);
		else this.out.write(`${chalk.cyan("◆")}  ${chalk.bold(text)}\n`);
	}

	/**
	 * Ask once, and treat a closed input as a refusal.
	 *
	 * `rl.question()` from readline/promises settles on an answer and on an abort
	 * signal, but not on the input ending: at EOF the interface emits `close` and
	 * the promise is simply never resolved. Every caller here guards a delete, so
	 * the failure mode was a `clio-coder uninstall` that printed its prompt and
	 * then hung forever on Ctrl-D. Racing the `close` event settles that case as
	 * "no", which is the only safe reading of an input that stopped talking.
	 */
	async confirm(question: string, defaultYes = false): Promise<boolean> {
		if (this.json) return false;
		const hint = defaultYes ? "Y/n" : "y/N";
		this.open("confirm");
		const rl = createInterface({ input: this.in, output: this.out });
		try {
			const promptStr = this.plain
				? `  ${question} [${hint}]: `
				: `${chalk.cyan("◇")}  ${chalk.bold(question)} [${hint}]\n${chalk.cyan("│")}  `;
			const answer = await new Promise<string | null>((resolve) => {
				let settled = false;
				const settle = (value: string | null): void => {
					if (settled) return;
					settled = true;
					resolve(value);
				};
				rl.once("close", () => settle(null));
				rl.question(promptStr).then(
					(value) => settle(value),
					() => settle(null),
				);
			});
			if (answer === null) return false;
			const normalized = answer.trim().toLowerCase();
			const confirmed = normalized.length === 0 ? defaultYes : normalized === "y" || normalized === "yes";
			this.out.write(this.plain ? `  ${confirmed ? "Yes" : "No"}\n` : `${chalk.cyan("│")}  ${confirmed ? "Yes" : "No"}\n`);
			return confirmed;
		} finally {
			rl.close();
		}
	}

	/**
	 * Close the transcript. Every command ends here, on success and on failure,
	 * so `--json` emits exactly one document containing everything that was
	 * recorded, including advice added after a failure.
	 */
	done(summary = "Done"): void {
		this.report.summary = summary;
		if (this.json) {
			this.emit();
			return;
		}
		if (this.plain) {
			this.out.write(`\n${summary}\n`);
			return;
		}
		this.separator();
		this.out.write(`${chalk.cyan("└")}  ${chalk.bold(summary)}\n\n`);
	}

	/** Emit the JSON report without a closing line, for paths that ended in an error. */
	finish(): void {
		if (this.json) this.emit();
	}

	private emit(): void {
		if (this.emitted) return;
		this.emitted = true;
		this.out.write(`${JSON.stringify(this.report, null, 2)}\n`);
	}
}

export function createLifecyclePresenter(options: LifecyclePresenterOptions = {}): LifecyclePresenter {
	return new LifecyclePresenter(options);
}

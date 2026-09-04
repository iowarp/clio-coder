import { type Dirent, lstatSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { stdin as defaultInput, stdout as defaultOutput } from "node:process";
import { createInterface } from "node:readline/promises";
import chalk from "chalk";

export interface LifecyclePresenterOptions {
	json?: boolean;
	plain?: boolean;
	stream?: NodeJS.WritableStream;
	inputStream?: NodeJS.ReadableStream;
}

export type LifecycleItemStatus = "remove" | "keep" | "absent" | "skip" | "clean";

export interface LifecycleItem {
	label: string;
	path: string;
	bytes?: number | null;
	status?: LifecycleItemStatus;
	detail?: string;
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

export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	const units = ["KB", "MB", "GB", "TB"];
	let value = bytes / 1024;
	let unitIndex = 0;
	while (value >= 1024 && unitIndex < units.length - 1) {
		value /= 1024;
		unitIndex += 1;
	}
	return `${value.toFixed(value >= 10 ? 1 : 2)} ${units[unitIndex]}`;
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
				const st = lstatSync(full);
				if (st.isDirectory() && !st.isSymbolicLink()) {
					walk(full);
				} else {
					total += st.size;
				}
			} catch {
				// Ignore unreadable entries
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

export class LifecyclePresenter {
	private readonly json: boolean;
	private readonly plain: boolean;
	private readonly out: NodeJS.WritableStream;
	private readonly in: NodeJS.ReadableStream;
	private readonly report: LifecycleReport;

	constructor(options: LifecyclePresenterOptions = {}) {
		this.json = Boolean(options.json);
		const isTty = Boolean(
			(options.stream as { isTTY?: boolean } | undefined)?.isTTY ?? (defaultOutput as { isTTY?: boolean }).isTTY,
		);
		this.plain = options.plain ?? (!isTty || Boolean(process.env.NO_COLOR));
		this.out = options.stream ?? defaultOutput;
		this.in = options.inputStream ?? defaultInput;
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

	header(title: string, command = ""): void {
		this.report.title = title;
		this.report.command = command;
		if (this.json) return;
		if (this.plain) {
			this.out.write(`=== ${title} ===\n\n`);
			return;
		}
		this.out.write(`\n${chalk.cyan("┌")}  ${chalk.bold(title)}\n${chalk.cyan("│")}\n`);
	}

	rail(text = ""): void {
		if (this.json) return;
		if (this.plain) {
			if (text.length > 0) this.out.write(`  ${text}\n`);
			else this.out.write("\n");
			return;
		}
		if (text.length > 0) {
			this.out.write(`${chalk.cyan("│")}  ${text}\n`);
		} else {
			this.out.write(`${chalk.cyan("│")}\n`);
		}
	}

	step(text: string): void {
		this.report.steps.push({ type: "step", message: text });
		if (this.json) return;
		if (this.plain) {
			this.out.write(`* ${text}\n`);
			return;
		}
		this.out.write(`${chalk.blue("●")}  ${text}\n${chalk.cyan("│")}\n`);
	}

	substep(text: string, glyph = "✓"): void {
		this.report.steps.push({ type: "substep", message: text });
		if (this.json) return;
		if (this.plain) {
			this.out.write(`    ${glyph} ${text}\n`);
			return;
		}
		const coloredGlyph = glyph === "✓" ? chalk.green(glyph) : glyph;
		this.out.write(`${chalk.blue("●")}    ${coloredGlyph} ${text}\n`);
	}

	listItems(header: string, items: ReadonlyArray<LifecycleItem>): void {
		for (const item of items) {
			this.report.items.push(item);
		}
		if (this.json) return;

		if (this.plain) {
			this.out.write(`  ${header}:\n\n`);
			for (const item of items) {
				const sizeStr =
					item.status !== "absent" && item.bytes !== undefined && item.bytes !== null ? ` (${formatBytes(item.bytes)})` : "";
				let suffix = "";
				if (item.status === "keep") {
					suffix = item.detail ? ` (${item.detail})` : " (kept)";
				} else if (item.status === "absent") {
					suffix = " (absent)";
				} else if (item.status === "skip") {
					suffix = item.detail ? ` (${item.detail})` : " (skipped)";
				} else if (item.detail) {
					suffix = ` (${item.detail})`;
				}
				const glyph = item.status === "keep" || item.status === "absent" || item.status === "skip" ? "–" : "✓";
				this.out.write(`    ${glyph} ${item.label}: ${shortenPath(item.path)}${sizeStr}${suffix}\n`);
			}
			this.out.write("\n");
			return;
		}

		this.out.write(`${chalk.cyan("│")}  ${header}:\n${chalk.cyan("│")}\n`);
		for (const item of items) {
			const sizeStr =
				item.status !== "absent" && item.bytes !== undefined && item.bytes !== null ? ` (${formatBytes(item.bytes)})` : "";
			let glyph = chalk.green("✓");
			let suffix = "";
			if (item.status === "keep") {
				glyph = chalk.dim("–");
				suffix = item.detail ? ` ${chalk.dim(`(${item.detail})`)}` : ` ${chalk.dim("(kept)")}`;
			} else if (item.status === "absent") {
				glyph = chalk.dim("–");
				suffix = ` ${chalk.dim("(absent)")}`;
			} else if (item.status === "skip") {
				glyph = chalk.yellow("–");
				suffix = item.detail ? ` ${chalk.yellow(`(${item.detail})`)}` : ` ${chalk.yellow("(skipped)")}`;
			} else if (item.detail) {
				suffix = ` ${chalk.dim(`(${item.detail})`)}`;
			}
			this.out.write(
				`${chalk.blue("●")}    ${glyph} ${chalk.bold(item.label)}: ${shortenPath(item.path)}${sizeStr}${suffix}\n`,
			);
		}
		this.out.write(`${chalk.cyan("│")}\n`);
	}

	completedStep(text: string): void {
		this.report.steps.push({ type: "completed", message: text });
		if (this.json) return;
		if (this.plain) {
			this.out.write(`✓ ${text}\n`);
			return;
		}
		this.out.write(`${chalk.green("◇")}  ${text}\n`);
	}

	warn(text: string): void {
		this.report.warnings.push(text);
		if (this.json) return;
		if (this.plain) {
			this.out.write(`! Warning: ${text}\n`);
			return;
		}
		this.out.write(`${chalk.yellow("▲")}  ${chalk.yellow(text)}\n${chalk.cyan("│")}\n`);
	}

	fail(message: string, detail?: string): void {
		this.report.status = "error";
		this.report.errors.push(detail ? `${message}: ${detail}` : message);
		if (this.json) {
			this.out.write(`${JSON.stringify(this.report, null, 2)}\n`);
			return;
		}
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
		const lines = command.split("\n");
		if (this.plain) {
			this.out.write(`  ${lead}\n`);
			for (const line of lines) {
				this.out.write(`    ${line}\n`);
			}
			return;
		}
		this.out.write(`${chalk.cyan("│")}  ${lead}\n`);
		for (const line of lines) {
			this.out.write(`${chalk.blue("●")}    ${chalk.cyan(line)}\n`);
		}
	}

	message(text: string): void {
		this.report.steps.push({ type: "message", message: text });
		if (this.json) return;
		if (this.plain) {
			this.out.write(`  ${text}\n`);
			return;
		}
		this.out.write(`${chalk.cyan("◆")}  ${chalk.bold(text)}\n`);
	}

	async confirm(question: string, defaultYes = false): Promise<boolean> {
		if (this.json) return false;
		const hint = defaultYes ? "Y/n" : "y/N";
		const rl = createInterface({ input: this.in, output: this.out });
		try {
			const promptStr = this.plain
				? `${question} [${hint}]: `
				: `${chalk.cyan("◇")}  ${chalk.bold(question)} [${hint}]\n${chalk.cyan("│")}  `;
			const answer = (await rl.question(promptStr)).trim().toLowerCase();
			let confirmed: boolean;
			if (answer.length === 0) {
				confirmed = defaultYes;
			} else {
				confirmed = answer === "y" || answer === "yes";
			}
			if (!this.plain) {
				this.out.write(`${chalk.cyan("│")}  ${confirmed ? "Yes" : "No"}\n`);
			} else {
				this.out.write(`  ${confirmed ? "Yes" : "No"}\n`);
			}
			return confirmed;
		} catch {
			return false;
		} finally {
			rl.close();
		}
	}

	done(summary = "Done"): void {
		this.report.summary = summary;
		if (this.json) {
			this.out.write(`${JSON.stringify(this.report, null, 2)}\n`);
			return;
		}
		if (this.plain) {
			this.out.write(`=== ${summary} ===\n`);
			return;
		}
		this.out.write(`${chalk.cyan("└")}  ${chalk.bold(summary)}\n\n`);
	}
}

export function createLifecyclePresenter(options: LifecyclePresenterOptions = {}): LifecyclePresenter {
	return new LifecyclePresenter(options);
}

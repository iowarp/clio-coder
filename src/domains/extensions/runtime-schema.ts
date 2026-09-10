import { stripVTControlCharacters } from "node:util";
import type { ExtensionOutput, ExtensionPanel, ExtensionStatus } from "./public-api.js";
import type { ExtensionRuntimeDeclaration } from "./types.js";

export const RUNTIME_LIMITS = {
	processes: 4,
	messageBytes: 96 * 1024,
	outputBytes: 64 * 1024,
	argumentBytes: 16 * 1024,
	startupMs: 5000,
	commandMs: 30000,
	observationMs: 2000,
	disposeMs: 250,
	diagnosticsBytes: 64 * 1024,
} as const;

function record(value: unknown): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("expected an object");
	return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[]): void {
	for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`unknown runtime field '${key}'`);
}
function string(value: unknown, max: number): string {
	if (typeof value !== "string" || value.length === 0 || value.length > max)
		throw new Error(`expected text of 1-${max} characters`);
	return value;
}
function array(value: unknown, max: number): unknown[] {
	if (!Array.isArray(value) || value.length > max) throw new Error(`expected an array of at most ${max} entries`);
	return value;
}
function choices<T extends string>(value: unknown, allowed: readonly T[]): T[] {
	const entries = array(value ?? [], allowed.length).map((item) => {
		if (!allowed.includes(item as T)) throw new Error(`unsupported runtime capability '${String(item)}'`);
		return item as T;
	});
	if (new Set(entries).size !== entries.length) throw new Error("duplicate runtime capability");
	return entries;
}
export function parseExtensionRuntime(value: unknown): ExtensionRuntimeDeclaration {
	const raw = record(value);
	keys(raw, ["api", "entrypoint", "commands", "events", "ui"]);
	if (raw.api !== 1) throw new Error("runtime.api must be 1");
	const entrypoint = string(raw.entrypoint, 240);
	if (!entrypoint.endsWith(".mjs")) throw new Error("runtime.entrypoint must be a shipped .mjs file");
	const names = new Set<string>();
	const commands = array(raw.commands ?? [], 32).map((value) => {
		const command = record(value);
		keys(command, ["name", "description", "timeoutMs"]);
		const name = string(command.name, 40);
		if (!/^[a-z][a-z0-9_]*$/.test(name) || names.has(name))
			throw new Error(`invalid or duplicate runtime command '${name}'`);
		names.add(name);
		const description = string(command.description, 240);
		const timeoutMs = command.timeoutMs ?? RUNTIME_LIMITS.commandMs;
		if (!Number.isInteger(timeoutMs) || Number(timeoutMs) < 100 || Number(timeoutMs) > 300000)
			throw new Error("runtime command timeoutMs must be 100-300000");
		return { name, description, timeoutMs: Number(timeoutMs) };
	});
	return {
		api: 1,
		entrypoint,
		commands,
		events: choices(raw.events, ["session_open", "turn_end"]),
		ui: choices(raw.ui, ["status", "panel"]),
	};
}

/** Terminal control sequences and C0/C1 controls never reach a host renderer. */
export function extensionPlainText(value: string): string {
	return stripVTControlCharacters(value).replace(/[\p{Cc}\p{Cf}]/gu, (char) =>
		char === "\n" || char === "\t" ? char : "",
	);
}
function text(value: unknown, max: number): string {
	if (value === "") return "";
	return extensionPlainText(string(value, max));
}
export function parseExtensionOutput(value: unknown, declaration: ExtensionRuntimeDeclaration): ExtensionOutput {
	if (Buffer.byteLength(JSON.stringify(value) ?? "") > RUNTIME_LIMITS.outputBytes)
		throw new Error("runtime output exceeds 64 KiB");
	const raw = record(value);
	keys(raw, ["text", "status", "panel"]);
	const output: ExtensionOutput = { text: text(raw.text, 32768) };
	if (raw.status !== undefined) {
		if (!declaration.ui.includes("status")) throw new Error("runtime did not declare status UI");
		if (raw.status === null) output.status = null;
		else {
			const status = record(raw.status);
			keys(status, ["text", "tone"]);
			const parsed: ExtensionStatus = { text: text(status.text, 160).replaceAll("\n", " ").replaceAll("\t", " ") };
			if (status.tone !== undefined) {
				const [tone] = choices([status.tone], ["neutral", "positive", "warning", "error"]);
				if (tone) parsed.tone = tone;
			}
			output.status = parsed;
		}
	}
	if (raw.panel !== undefined) {
		if (!declaration.ui.includes("panel")) throw new Error("runtime did not declare panel UI");
		const panel = record(raw.panel);
		keys(panel, ["title", "sections"]);
		const parsed: ExtensionPanel = { title: text(panel.title, 120), sections: [] };
		for (const value of array(panel.sections, 16)) {
			const section = record(value);
			if (section.kind === "text") {
				keys(section, ["kind", "text"]);
				parsed.sections.push({ kind: "text", text: text(section.text, 8192) });
			} else if (section.kind === "metrics") {
				keys(section, ["kind", "items"]);
				parsed.sections.push({
					kind: "metrics",
					items: array(section.items, 32).map((value) => {
						const item = record(value);
						keys(item, ["label", "value"]);
						return { label: text(item.label, 120), value: text(item.value, 240) };
					}),
				});
			} else if (section.kind === "table") {
				keys(section, ["kind", "columns", "rows"]);
				const columns = array(section.columns, 8).map((value) => text(value, 80));
				if (columns.length === 0) throw new Error("table needs columns");
				const rows = array(section.rows, 100).map((row) => {
					const cells = array(row, columns.length);
					if (cells.length !== columns.length) throw new Error("table row width differs from columns");
					return cells.map((value) => text(value, 240));
				});
				parsed.sections.push({ kind: "table", columns, rows });
			} else throw new Error("unsupported panel section");
		}
		output.panel = parsed;
	}
	return output;
}

export function extensionPanelText(panel: ExtensionPanel): string {
	return [
		panel.title,
		...panel.sections.flatMap((section) => {
			if (section.kind === "text") return [section.text];
			if (section.kind === "metrics") return section.items.map((item) => `${item.label}: ${item.value}`);
			return [section.columns.join(" | "), ...section.rows.map((row) => row.join(" | "))];
		}),
	].join("\n\n");
}

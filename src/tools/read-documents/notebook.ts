import type { FileHandle } from "node:fs/promises";
import { formatSize } from "../truncate.js";
import { truncateUtf8 } from "../truncate-utf8.js";
import type { Rendered } from "./shared.js";

/**
 * Jupyter notebooks as text: each cell's source under a numbered heading,
 * then its stream, result and error outputs. Image and other binary outputs
 * become a one-line placeholder naming their MIME type and size, so a plot
 * never spends the read budget on base64.
 */

const NOTEBOOK_MAX_BYTES = 64 * 1024 * 1024;
const NOTEBOOK_OUTPUT_CAP_BYTES = 8 * 1024;

// ANSI CSI sequences in notebook tracebacks; the escape is spelled as a code
// point so no raw SGR sequence appears in source.
const ANSI_CSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[ -/]*[@-~]`, "gu");

function joinSource(value: unknown): string {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) return value.filter((part) => typeof part === "string").join("");
	return "";
}

function capOutput(text: string): string {
	const clean = text.replace(ANSI_CSI, "").replace(/\n+$/u, "");
	if (Buffer.byteLength(clean) <= NOTEBOOK_OUTPUT_CAP_BYTES) return clean;
	return truncateUtf8(
		clean,
		NOTEBOOK_OUTPUT_CAP_BYTES,
		`\n[output cut at ${formatSize(NOTEBOOK_OUTPUT_CAP_BYTES)} of ${formatSize(Buffer.byteLength(clean))}]`,
	);
}

const TEXT_MIME_ORDER = ["text/plain", "text/markdown", "text/latex"];

function renderRichOutput(kind: string, data: Record<string, unknown>): string[] {
	const out: string[] = [];
	const mime = TEXT_MIME_ORDER.find((candidate) => candidate in data);
	if (mime !== undefined) out.push(`### ${kind} (${mime})`, capOutput(joinSource(data[mime])));
	const omitted = Object.keys(data)
		.filter((key) => key !== mime && !(mime !== undefined && key === "text/html"))
		.map((key) => `${key} ${formatSize(Buffer.byteLength(joinSource(data[key]) || JSON.stringify(data[key])))}`);
	if (omitted.length > 0) out.push(`### ${kind}: [${omitted.join(", ")} omitted]`);
	return out;
}

export async function renderNotebook(handle: FileHandle, size: number): Promise<Rendered> {
	if (size > NOTEBOOK_MAX_BYTES) {
		return {
			error: `notebook is ${formatSize(size)}, above the ${formatSize(NOTEBOOK_MAX_BYTES)} parse limit; use run_script with nbformat`,
		};
	}
	let notebook: { nbformat?: unknown; nbformat_minor?: unknown; cells?: unknown; metadata?: Record<string, unknown> };
	try {
		notebook = JSON.parse((await handle.readFile()).toString("utf8")) as typeof notebook;
	} catch (err) {
		return { error: `not a valid notebook: ${err instanceof Error ? err.message : String(err)}` };
	}
	if (notebook.nbformat !== 4 || !Array.isArray(notebook.cells)) {
		return {
			error: `only nbformat 4 notebooks are rendered (got ${String(notebook.nbformat)}); use run_script with nbformat`,
		};
	}
	const kernel = (notebook.metadata?.kernelspec as { name?: unknown } | undefined)?.name;
	const language = (notebook.metadata?.language_info as { name?: unknown } | undefined)?.name;
	const lines: string[] = [
		`# Notebook (nbformat 4.${String(notebook.nbformat_minor ?? 0)}, ${notebook.cells.length} cells${
			typeof kernel === "string" ? `, kernel ${kernel}` : ""
		}${typeof language === "string" ? `, ${language}` : ""}); image and binary outputs are omitted`,
	];
	notebook.cells.forEach((raw, index) => {
		const cell = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
		const type = typeof cell.cell_type === "string" ? cell.cell_type : "unknown";
		const count = typeof cell.execution_count === "number" ? ` [exec ${cell.execution_count}]` : "";
		lines.push("", `## [${index + 1}] ${type}${count}`, joinSource(cell.source));
		if (!Array.isArray(cell.outputs)) return;
		for (const rawOutput of cell.outputs) {
			const output = (typeof rawOutput === "object" && rawOutput !== null ? rawOutput : {}) as Record<string, unknown>;
			const outputType = String(output.output_type ?? "output");
			if (outputType === "stream") {
				lines.push(`### ${String(output.name ?? "stream")}`, capOutput(joinSource(output.text)));
			} else if (outputType === "error") {
				const traceback = Array.isArray(output.traceback) ? output.traceback.map(String).join("\n") : "";
				lines.push(`### error: ${String(output.ename ?? "Error")}: ${String(output.evalue ?? "")}`, capOutput(traceback));
			} else if (typeof output.data === "object" && output.data !== null) {
				lines.push(...renderRichOutput(outputType, output.data as Record<string, unknown>));
			}
		}
	});
	return { text: lines.join("\n") };
}

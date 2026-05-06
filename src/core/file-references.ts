import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { expandConfigPath } from "./resolve-config-value.js";

export interface FileReferenceDiagnostic {
	type: "warning" | "error";
	message: string;
	path?: string;
}

export interface FileReferenceResult {
	text: string;
	diagnostics: FileReferenceDiagnostic[];
}

export interface FileReferenceOptions {
	cwd?: string;
	missing?: "error" | "leave";
}

const FILE_REF = /(^|\s)@(\S+)/g;

export function splitFileArgs(args: ReadonlyArray<string>): { fileArgs: string[]; messages: string[] } {
	const fileArgs: string[] = [];
	const messages: string[] = [];
	for (const arg of args) {
		if (arg.startsWith("@") && arg.length > 1) {
			fileArgs.push(arg.slice(1));
		} else {
			messages.push(arg);
		}
	}
	return { fileArgs, messages };
}

function renderTextFile(filePath: string, content: string): string {
	return `<file name="${filePath}">\n${content}\n</file>\n`;
}

function readTextFile(fileArg: string, options: FileReferenceOptions): FileReferenceResult {
	const filePath = expandConfigPath(fileArg, options.cwd === undefined ? undefined : { cwd: options.cwd });
	if (!existsSync(filePath)) {
		if (options.missing === "leave") return { text: `@${fileArg}`, diagnostics: [] };
		return { text: "", diagnostics: [{ type: "error", message: `file not found: ${filePath}`, path: filePath }] };
	}
	let stat: ReturnType<typeof statSync>;
	try {
		stat = statSync(filePath);
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		return {
			text: "",
			diagnostics: [{ type: "error", message: `file could not be stat'ed: ${reason}`, path: filePath }],
		};
	}
	if (!stat.isFile()) {
		return { text: "", diagnostics: [{ type: "error", message: `not a file: ${filePath}`, path: filePath }] };
	}
	if (stat.size === 0) return { text: "", diagnostics: [] };
	try {
		return { text: renderTextFile(filePath, readFileSync(filePath, "utf8")), diagnostics: [] };
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		return { text: "", diagnostics: [{ type: "error", message: `file could not be read: ${reason}`, path: filePath }] };
	}
}

export function readFileArgs(fileArgs: ReadonlyArray<string>, options: FileReferenceOptions = {}): FileReferenceResult {
	const diagnostics: FileReferenceDiagnostic[] = [];
	let text = "";
	for (const fileArg of fileArgs) {
		const result = readTextFile(fileArg, { ...options, missing: options.missing ?? "error" });
		text += result.text;
		diagnostics.push(...result.diagnostics);
	}
	return { text, diagnostics };
}

function splitTrailingPunctuation(token: string): { fileArg: string; suffix: string } {
	const match = token.match(/^(.+?)([),.;:!?]+)$/);
	if (!match?.[1] || !match[2]) return { fileArg: token, suffix: "" };
	const candidate = match[1];
	const suffix = match[2];
	const ext = path.extname(candidate);
	if (ext.length === 0 && suffix.startsWith(".")) return { fileArg: token, suffix: "" };
	return { fileArg: candidate, suffix };
}

export function expandInlineFileReferences(input: string, options: FileReferenceOptions = {}): FileReferenceResult {
	const diagnostics: FileReferenceDiagnostic[] = [];
	const text = input.replace(FILE_REF, (match: string, prefix: string, token: string) => {
		const direct = readTextFile(token, { ...options, missing: "leave" });
		if (direct.text !== `@${token}`) {
			diagnostics.push(...direct.diagnostics);
			return `${prefix}${direct.text}`;
		}

		const { fileArg, suffix } = splitTrailingPunctuation(token);
		if (fileArg === token) return match;
		const stripped = readTextFile(fileArg, { ...options, missing: "leave" });
		if (stripped.text === `@${fileArg}`) return match;
		diagnostics.push(...stripped.diagnostics);
		return `${prefix}${stripped.text}${suffix}`;
	});
	return { text, diagnostics };
}

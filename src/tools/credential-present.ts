import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { Type } from "typebox";
import { ToolNames } from "../core/tool-names.js";
import { resolveReadPath } from "./path-utils.js";
import type { ToolResult, ToolSpec } from "./registry.js";
import { stringEnum } from "./string-enum.js";

type CredentialPresenceSource = "auto" | "environment" | "file";
type CredentialPresenceResultSource = "environment" | "file" | "both" | "none";

const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

interface CredentialPresenceSummary {
	name: string;
	present: boolean;
	source: CredentialPresenceResultSource;
	checked: Array<"environment" | "file">;
	file?: string;
}

function trimString(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function normalizeSource(value: unknown): { source: CredentialPresenceSource; error?: string } {
	if (value === undefined) return { source: "auto" };
	if (value === "auto") return { source: "auto" };
	if (value === "environment" || value === "env") return { source: "environment" };
	if (value === "file") return { source: "file" };
	return { source: "auto", error: "credential_present: source must be auto, environment, env, or file" };
}

function hasEnvKey(name: string): boolean {
	return Object.hasOwn(process.env, name);
}

function lineHasKey(line: string, name: string): boolean {
	const trimmed = line.trimStart();
	if (trimmed.length === 0 || trimmed.startsWith("#")) return false;
	const body = trimmed.startsWith("export ") ? trimmed.slice("export ".length).trimStart() : trimmed;
	return body.startsWith(`${name}=`);
}

async function fileHasKey(filePath: string, name: string): Promise<{ present: boolean; missing: boolean }> {
	const stream = createReadStream(filePath, { encoding: "utf8" });
	let missing = false;
	stream.on("error", (error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") missing = true;
	});
	const lines = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
	try {
		for await (const line of lines) {
			if (lineHasKey(line, name)) return { present: true, missing: false };
		}
		return { present: false, missing };
	} catch (error) {
		const err = error as NodeJS.ErrnoException;
		if (err.code === "ENOENT") return { present: false, missing: true };
		throw error;
	}
}

function sourceOf(envPresent: boolean, filePresent: boolean): CredentialPresenceResultSource {
	if (envPresent && filePresent) return "both";
	if (envPresent) return "environment";
	if (filePresent) return "file";
	return "none";
}

function ok(summary: CredentialPresenceSummary): ToolResult {
	return {
		kind: "ok",
		output: `${JSON.stringify(summary)}\n`,
		details: { credentialPresent: summary },
	};
}

export const credentialPresentTool: ToolSpec = {
	name: ToolNames.CredentialPresent,
	description:
		"Check whether a named credential key is present in the process environment or an env-style file. Returns only present/absent metadata, never the credential value.",
	parameters: Type.Object({
		name: Type.String({ description: "Credential key name, e.g. OPENAI_API_KEY." }),
		source: Type.Optional(
			stringEnum(
				["auto", "environment", "env", "file"],
				"auto checks the environment and the file when file is supplied; environment/env checks only the process environment; file checks only the file.",
			),
		),
		file: Type.Optional(Type.String({ description: "Env-style file to check for NAME=, e.g. .env." })),
	}),
	baseActionClass: "read",
	executionMode: "parallel",
	async run(args): Promise<ToolResult> {
		const name = trimString(args.name);
		if (name === null) return { kind: "error", message: "credential_present: name is required" };
		if (!KEY_PATTERN.test(name)) {
			return { kind: "error", message: "credential_present: name must match [A-Za-z_][A-Za-z0-9_]*" };
		}
		const sourceResult = normalizeSource(args.source);
		if (sourceResult.error !== undefined) return { kind: "error", message: sourceResult.error };
		const source = sourceResult.source;
		const file = trimString(args.file);
		if (source === "file" && file === null) return { kind: "error", message: "credential_present: file is required" };

		const checkEnv = source === "auto" || source === "environment";
		const checkFile = source === "file" || (source === "auto" && file !== null);
		const checked: Array<"environment" | "file"> = [];
		let envPresent = false;
		let filePresent = false;

		if (checkEnv) {
			checked.push("environment");
			envPresent = hasEnvKey(name);
		}
		if (checkFile && file !== null) {
			checked.push("file");
			const resolved = resolveReadPath(file);
			try {
				const result = await fileHasKey(resolved, name);
				filePresent = result.present;
			} catch (error) {
				return {
					kind: "error",
					message: `credential_present: could not check file source: ${error instanceof Error ? error.message : String(error)}`,
				};
			}
		}

		const summary: CredentialPresenceSummary = {
			name,
			present: envPresent || filePresent,
			source: sourceOf(envPresent, filePresent),
			checked,
			...(file !== null && checkFile ? { file } : {}),
		};
		return ok(summary);
	},
};

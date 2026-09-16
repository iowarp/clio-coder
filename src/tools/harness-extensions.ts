import path from "node:path";
import type { TSchema } from "typebox";
import { Value } from "typebox/value";
import { parse as parseYaml } from "yaml";
import { runCommandVector } from "../core/safe-exec.js";
import type { DynamicToolName } from "../core/tool-names.js";
import { extensionToolName, resolveExtensionEntrypoint } from "../domains/extensions/command-schema.js";
import { parseExtensionManifest } from "../domains/extensions/discovery.js";
import { extensionContentDigestWithCapture } from "../domains/extensions/integrity.js";
import { listInstalledExtensions } from "../domains/extensions/state.js";
import {
	type ExtensionCommandTool,
	type ExtensionDiagnostic,
	isLoadableExtension,
	type LoadableExtension,
} from "../domains/extensions/types.js";
import type { ToolRegistry, ToolSpec } from "./registry.js";

const MAX_INPUT_BYTES = 64 * 1024;

/** Serialize a fixed argv vector only for the existing shell safety classifier. No shell executes this text. */
function quoted(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function jsonInput(args: Record<string, unknown>): string {
	const input = JSON.stringify(args);
	if (Buffer.byteLength(input) > MAX_INPUT_BYTES) throw new Error(`command tool input exceeds ${MAX_INPUT_BYTES} bytes`);
	return input;
}

function commandVector(extension: LoadableExtension, tool: ExtensionCommandTool): { file: string; args: string[] } {
	const entrypoint = resolveExtensionEntrypoint(extension.rootPath, tool.entrypoint);
	return tool.runtime === "node"
		? { file: process.execPath, args: ["--", entrypoint] }
		: { file: "python3", args: ["-I", entrypoint] };
}

/** Parse declarations from the exact manifest bytes included in the verified tree. */
function verifiedCommands(extension: LoadableExtension): ExtensionCommandTool[] {
	const manifestName = path.basename(extension.manifestPath);
	const verified = extensionContentDigestWithCapture(extension.rootPath, { capture: [manifestName] });
	if (verified.digest !== extension.provenance.contentDigest)
		throw new Error("installed extension changed while loading tools");
	const bytes = verified.captured.get(manifestName);
	if (!bytes) throw new Error("verified extension manifest bytes are absent");
	const parsed = parseExtensionManifest(
		manifestName.endsWith(".json") ? JSON.parse(bytes.toString("utf8")) : parseYaml(bytes.toString("utf8")),
		extension.manifestPath,
	);
	if (!parsed.manifest || parsed.diagnostics.some((entry) => entry.type === "error"))
		throw new Error("verified extension manifest is invalid");
	if (parsed.manifest.id !== extension.id || parsed.manifest.version !== extension.version)
		throw new Error("verified extension identity changed while loading tools");
	return parsed.manifest.capabilities?.tools ?? [];
}

function createCommandTool(extension: LoadableExtension, tool: ExtensionCommandTool, cwd: string): ToolSpec {
	const name = extensionToolName(extension.id, tool.name) as DynamicToolName;
	const vector = commandVector(extension, tool);
	return {
		name,
		description: `${tool.description}\nHarness extension ${extension.id}@${extension.version}; runs an installed command with JSON input and output.`,
		parameters: tool.inputSchema as TSchema,
		baseActionClass: "execute",
		executionMode: "sequential",
		// Reached through gateway find/describe/call; the spec, its execute
		// class, and its bash projection are unchanged by the placement.
		placement: "gateway",
		sourceInfo: { path: extension.manifestPath, scope: "domain", extension: extension.provenance },
		metadata: {
			objective: tool.description,
			uiLabel: `${extension.id}/${tool.name}`,
			retrySafety: "not_retry_safe",
			resultSizePolicy: { kind: "bounded", maxBytes: tool.maxOutputBytes ?? 600000 },
			costLatency: "local_slow",
		},
		safetyCall(args) {
			// The vector stays execution-class even for inputs such as {op:"read"}.
			let input = "[invalid JSON input]";
			try {
				input = jsonInput(args);
			} catch {
				/* The body reports bounded input validation. */
			}
			return { tool: "bash", args: { command: [vector.file, ...vector.args, input].map(quoted).join(" "), cwd } };
		},
		async run(args, options) {
			try {
				const input = jsonInput(args);
				if (!Value.Check(tool.inputSchema as TSchema, args))
					return { kind: "error", message: `${name}: input does not match its declared JSON schema` };
				if (options?.signal?.aborted) return { kind: "error", message: `${name}: aborted before execution` };
				const current = listInstalledExtensions(cwd).find(
					(entry) => entry.id === extension.id && isLoadableExtension(entry),
				);
				if (
					!current ||
					!isLoadableExtension(current) ||
					current.scope !== extension.scope ||
					current.provenance.canonicalRoot !== extension.provenance.canonicalRoot ||
					current.provenance.contentDigest !== extension.provenance.contentDigest
				) {
					return {
						kind: "error",
						message: `${name}: extension disabled, removed, replaced, or changed; restart after reviewing its installation`,
					};
				}
				const activeVector = commandVector(current, tool);
				const result = await runCommandVector(activeVector.file, [...activeVector.args, input], {
					cwd,
					workspaceRoot: cwd,
					timeoutMs: tool.timeoutMs ?? 120000,
					maxOutputBytes: tool.maxOutputBytes ?? 600000,
					...(options?.signal ? { signal: options.signal } : {}),
				});
				const details = {
					extension: extension.provenance,
					argv: [result.file, ...result.args],
					cwd: result.cwd,
					exitCode: result.exitCode,
					durationMs: result.durationMs,
					aborted: result.aborted,
					timedOut: result.timedOut,
					outputCapped: result.outputCapped,
					stderr: result.stderr,
				};
				if (result.aborted || result.timedOut || result.outputCapped || result.exitCode !== 0) {
					const reason = result.aborted
						? "aborted"
						: result.timedOut
							? "timed out"
							: result.outputCapped
								? "output limit exceeded"
								: `exited with code ${result.exitCode}`;
					return { kind: "error", message: `${name}: ${reason}`, details };
				}
				try {
					return { kind: "ok", output: JSON.stringify(JSON.parse(result.stdout)), details };
				} catch {
					return { kind: "error", message: `${name}: command stdout must contain one JSON value`, details };
				}
			} catch (error) {
				return { kind: "error", message: `${name}: ${error instanceof Error ? error.message : String(error)}` };
			}
		},
	};
}

/**
 * Freeze installed harness tool schemas at registry construction, in sessions and native workers.
 * Registration never imports or executes package code. Lifecycle mutations revoke calls immediately;
 * new or updated schemas enter the next session/worker, keeping approved worker surfaces stable.
 */
export function registerHarnessExtensionTools(registry: ToolRegistry, cwd = process.cwd()): ExtensionDiagnostic[] {
	const diagnostics: ExtensionDiagnostic[] = [];
	for (const extension of listInstalledExtensions(cwd)) {
		if (!isLoadableExtension(extension) || !extension.capabilities) continue;
		try {
			const tools = verifiedCommands(extension).map((tool) => createCommandTool(extension, tool, path.resolve(cwd)));
			for (const tool of tools) if (registry.get(tool.name)) throw new Error(`tool collision: ${tool.name}`);
			for (const tool of tools) registry.register(tool);
		} catch (error) {
			diagnostics.push({
				type: "error",
				path: extension.rootPath,
				message: `extension ${extension.id}: ${error instanceof Error ? error.message : String(error)}`,
			});
		}
	}
	return diagnostics;
}

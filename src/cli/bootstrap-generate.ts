import { spawn } from "node:child_process";
import {
	type BootstrapGenerate,
	type BootstrapGenerateInput,
	type BootstrapStructuredOutput,
	heuristicBootstrapOutput,
} from "../domains/context/bootstrap.js";
import { buildBootstrapPrompt, parseBootstrapModelOutput } from "../domains/context/bootstrap-prompt.js";

/**
 * Model-driven CLIO.md generation. Spawns a headless `clio run --json` against
 * the configured orchestrator target with a bootstrap prompt grounded in the
 * codewiki structure, then validates the structured JSON the model returns.
 * Shared by `clio context-init` and the interactive `/context-init` command.
 */

function cliEntryPath(): string {
	const entry = process.argv[1];
	if (!entry) throw new Error("context-init could not resolve the current CLI entry path");
	return entry;
}

function parseHeadlessJsonOutput(stdout: string): string {
	let lastText = "";
	for (const line of stdout.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (trimmed.length === 0) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			continue;
		}
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;
		const event = parsed as { type?: unknown; message?: { role?: unknown; content?: unknown } };
		if (event.type !== "message_end" || event.message?.role !== "assistant") continue;
		const content = event.message.content;
		if (!Array.isArray(content)) continue;
		const text = content
			.map((block) => {
				if (typeof block === "string") return block;
				if (typeof block !== "object" || block === null || Array.isArray(block)) return "";
				const maybeText = (block as { text?: unknown }).text;
				return typeof maybeText === "string" ? maybeText : "";
			})
			.join("")
			.trim();
		if (text.length > 0) lastText = text;
	}
	if (lastText.length === 0) throw new Error("bootstrap model did not return an assistant message");
	return lastText;
}

export async function generateBootstrapWithConfiguredTarget(
	input: BootstrapGenerateInput,
): Promise<BootstrapStructuredOutput> {
	const prompt = buildBootstrapPrompt(input);
	const child = spawn(process.execPath, [cliEntryPath(), "--no-context-files", "run", "--json", prompt], {
		cwd: input.cwd,
		env: { ...process.env, CLIO_BOOTSTRAP_GENERATE_CHILD: "1" },
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (chunk: string) => {
		stdout += chunk;
	});
	child.stderr.on("data", (chunk: string) => {
		stderr += chunk;
	});
	const exit = await new Promise<number | null>((resolve) => child.on("close", (code) => resolve(code)));
	if (exit !== 0) {
		const detail = stderr.trim().slice(0, 1000);
		throw new Error(`bootstrap model generation failed with exit ${exit ?? "signal"}${detail ? `: ${detail}` : ""}`);
	}
	return parseBootstrapModelOutput(parseHeadlessJsonOutput(stdout));
}

/**
 * Wrap model-driven generation so any failure (no configured target, offline
 * endpoint, malformed output) degrades cleanly to the deterministic heuristic
 * generator instead of aborting the whole bootstrap.
 */
export function modelBootstrapGenerate(options: { onFallback?: (err: Error) => void } = {}): BootstrapGenerate {
	return async (input) => {
		try {
			return await generateBootstrapWithConfiguredTarget(input);
		} catch (err) {
			options.onFallback?.(err instanceof Error ? err : new Error(String(err)));
			return heuristicBootstrapOutput(input);
		}
	};
}

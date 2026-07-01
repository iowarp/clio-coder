import { Type } from "typebox";
import { BASH_HARD_CAP_BYTES, buildToolEnv, combineBashOutput, runBashCommand } from "../core/bash-exec.js";
import { ToolNames } from "../core/tool-names.js";
import type { ToolInvokeOptions, ToolResult, ToolResultDetails, ToolSpec } from "./registry.js";
import { writeToolOffload } from "./result-shaping.js";
import { DEFAULT_MAX_LINES, formatSize, truncateTail } from "./truncate.js";

// What the model sees inline. The tail is where the failing assertion, compiler
// error, and exit summary live, so we keep the LAST lines/bytes. The full
// output is spilled to an offload file before truncating, so nothing is lost.
const BASH_DISPLAY_MAX_BYTES = 16 * 1024;
// Slack reserved so the continuation notice appended after truncation still
// fits under the registry's per-tool bash budget without a second (head-first)
// re-truncation cutting the tail we just preserved.
const BASH_TAIL_NOTE_RESERVE = 512;

interface ShapedBashOutput {
	text: string;
	details?: ToolResultDetails;
}

// Tail-truncate the combined output for display, spilling the full output to a
// scratch file first when it overflows the display cap. Setting
// `details.resultSize.offloadPath` tells the registry result-shaper to leave
// this already-shaped (tail-biased) output alone instead of re-truncating it
// head-first.
function shapeBashOutput(
	rawOutput: string,
	context: Pick<ToolInvokeOptions, "sessionId" | "toolCallId"> | undefined,
): ShapedBashOutput {
	const truncation = truncateTail(rawOutput, {
		maxLines: DEFAULT_MAX_LINES,
		maxBytes: BASH_DISPLAY_MAX_BYTES - BASH_TAIL_NOTE_RESERVE,
	});
	if (!truncation.truncated) return { text: rawOutput };

	const totalBytes = Buffer.byteLength(rawOutput, "utf8");
	const offloadPath = writeToolOffload(rawOutput, context, BASH_HARD_CAP_BYTES);
	const startLine = truncation.totalLines - truncation.outputLines + 1;
	const scope = truncation.lastLinePartial
		? `last ${formatSize(truncation.outputBytes)} of line ${truncation.totalLines} (line is large)`
		: `lines ${startLine}-${truncation.totalLines} of ${truncation.totalLines}`;
	const location = offloadPath !== null ? ` Full output saved to ${offloadPath}; read it with offset/limit.` : "";
	const note = `[Output tail-truncated: showing ${scope} (${formatSize(BASH_DISPLAY_MAX_BYTES)} display limit).${location}]`;
	const details: ToolResultDetails = {
		resultSize: {
			bytes: totalBytes,
			shownBytes: truncation.outputBytes,
			maxBytes: BASH_DISPLAY_MAX_BYTES,
			truncated: true,
			policy: "tail",
			followUpHint: "Read the full-output offload file with offset/limit, or re-run a narrower command.",
			...(offloadPath !== null ? { offloadPath } : {}),
		},
	};
	return { text: `${truncation.content}\n\n${note}`, details };
}

function withDetails(base: ToolResult, details: ToolResultDetails | undefined): ToolResult {
	if (details === undefined) return base;
	if (base.kind === "ok") return { ...base, details };
	return { ...base, details };
}

export const bashTool: ToolSpec = {
	name: ToolNames.Bash,
	description: "Execute a bash command via /bin/bash -lc and return stdout and stderr. Default timeout 300000 ms.",
	parameters: Type.Object({
		command: Type.String({ description: "Bash command to execute." }),
		cwd: Type.Optional(Type.String({ description: "Working directory." })),
		timeout_ms: Type.Optional(Type.Number({ description: "Timeout in milliseconds." })),
	}),
	baseActionClass: "execute",
	executionMode: "sequential",
	async run(args, options): Promise<ToolResult> {
		if (typeof args.command !== "string" || args.command.length === 0) {
			return { kind: "error", message: "bash: missing command argument" };
		}
		const cwd = typeof args.cwd === "string" ? args.cwd : undefined;
		const timeout = typeof args.timeout_ms === "number" && args.timeout_ms > 0 ? args.timeout_ms : 300_000;
		try {
			const result = await runBashCommand(args.command, {
				...(cwd === undefined ? {} : { cwd }),
				timeoutMs: timeout,
				...(options?.signal === undefined ? {} : { signal: options.signal }),
			});
			const { error, aborted, timedOut, outputCapped } = result;
			if (aborted) {
				return { kind: "error", message: "bash: command aborted" };
			}
			const shaped = shapeBashOutput(combineBashOutput(result), options);
			const output = shaped.text.trim();
			if (timedOut) {
				const status = `bash: command timed out after ${timeout}ms`;
				return withDetails(
					{ kind: "error", message: output.length > 0 ? `${output}\n\n${status}` : status },
					shaped.details,
				);
			}
			if (outputCapped) {
				const status = `bash: command output exceeded ${BASH_HARD_CAP_BYTES} bytes and was stopped`;
				return withDetails(
					{ kind: "error", message: output.length > 0 ? `${output}\n\n${status}` : status },
					shaped.details,
				);
			}
			if (error) {
				const code = typeof error.code === "number" ? error.code : (error as { code?: string }).code;
				const status = `bash: command failed (exit ${code ?? "?"})`;
				const message = output.length > 0 ? `${output}\n\n${status}` : `${status}: ${error.message}`;
				return withDetails({ kind: "error", message }, shaped.details);
			}
			return withDetails({ kind: "ok", output: shaped.text.length > 0 ? shaped.text : "(no output)" }, shaped.details);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return { kind: "error", message: `bash: ${msg}` };
		}
	},
};

export { buildToolEnv };

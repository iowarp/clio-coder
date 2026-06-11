import type { ToolResult, ToolResultDetails, ToolSpec } from "./registry.js";
import { truncateUtf8 } from "./truncate-utf8.js";

// Backstop for tools without an explicit resultSizePolicy. Sits slightly
// above the 6KB per-observation source cap (src/tools/truncate.ts) so a
// tool's own truncation notice survives shaping instead of being cut again.
export const DEFAULT_TOOL_RESULT_MAX_BYTES = 8 * 1024;
const RESULT_TRUNCATION_MARKER = "\n[tool result truncated]";

function byteLength(text: string): number {
	return Buffer.byteLength(text, "utf8");
}

function mergeDetails(details: ToolResultDetails | undefined, resultSize: Record<string, unknown>): ToolResultDetails {
	return { ...(details ?? {}), resultSize };
}

function maxBytesFor(spec: ToolSpec): number {
	const configured = spec.metadata?.resultSizePolicy?.maxBytes;
	return typeof configured === "number" && Number.isFinite(configured) && configured > 0
		? Math.floor(configured)
		: DEFAULT_TOOL_RESULT_MAX_BYTES;
}

function followUpHint(spec: ToolSpec): string {
	return (
		spec.metadata?.resultSizePolicy?.followUpHint ??
		"Use a narrower query, offset/limit arguments, or a more specific tool call to inspect the omitted content."
	);
}

export function shapeToolResult(spec: ToolSpec, result: ToolResult): ToolResult {
	const maxBytes = maxBytesFor(spec);
	const text = result.kind === "ok" ? result.output : result.message;
	const bytes = byteLength(text);
	if (bytes <= maxBytes) return result;
	const truncated = truncateUtf8(text, maxBytes, RESULT_TRUNCATION_MARKER);
	const resultSize = {
		bytes,
		shownBytes: byteLength(truncated),
		maxBytes,
		truncated: true,
		policy: spec.metadata?.resultSizePolicy?.kind ?? "truncate",
		followUpHint: followUpHint(spec),
	};
	if (result.kind === "ok") {
		return {
			...result,
			output: `${truncated}\n\n[${followUpHint(spec)}]`,
			details: mergeDetails(result.details, resultSize),
		};
	}
	return {
		...result,
		message: `${truncated}\n\n[${followUpHint(spec)}]`,
		details: mergeDetails(result.details, resultSize),
	};
}

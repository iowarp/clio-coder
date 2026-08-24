import { CODE_STEP_EXCERPT_MAX_BYTES } from "./code-step.js";

export function gateBaselineFailure(passed: boolean): "gate_not_discriminating" | null {
	return passed ? "gate_not_discriminating" : null;
}

export function gateFailureLines(output: string): string {
	const lines = output
		.split("\n")
		.filter((line) => line.startsWith("FAIL"))
		.join("\n");
	if (Buffer.byteLength(lines, "utf8") <= CODE_STEP_EXCERPT_MAX_BYTES) return lines;
	return Buffer.from(lines, "utf8").subarray(0, CODE_STEP_EXCERPT_MAX_BYTES).toString("utf8");
}

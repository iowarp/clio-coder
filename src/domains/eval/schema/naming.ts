/** Legacy eval identifiers are normalized only after decoding; writers use canonical schema constants. */
export function normalizeEvalSchemaId(value: unknown): unknown {
	return typeof value === "string" && value.startsWith("clio.eval.")
		? `clio-coder.eval.${value.slice("clio.eval.".length)}`
		: value;
}

export function normalizeEvalRunnerKind(value: unknown): unknown {
	return value === "clio-run" ? "clio-coder-run" : value;
}

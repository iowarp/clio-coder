export interface EvalServingConfigurationV1 {
	targetId: string;
	runtimeId: string | null;
	modelId: string | null;
	serverBuild: string | null;
	total_slots: number | null;
	thinkingLevel: string | null;
	compiledPromptHash: string | null;
}

export function parseEvalServingConfigurationV1(value: unknown, source: string): EvalServingConfigurationV1 {
	const record = asRecord(value, source);
	const targetId = readString(record.targetId, `${source}.targetId`);
	const totalSlots = record.total_slots;
	if (totalSlots !== null && (typeof totalSlots !== "number" || !Number.isInteger(totalSlots) || totalSlots <= 0)) {
		throw new Error(`${source}.total_slots: expected positive integer or null`);
	}
	const compiledPromptHash = readNullableString(record.compiledPromptHash, `${source}.compiledPromptHash`);
	if (compiledPromptHash !== null && !/^[a-f0-9]{64}$/u.test(compiledPromptHash)) {
		throw new Error(`${source}.compiledPromptHash: expected sha256 digest or null`);
	}
	return {
		targetId,
		runtimeId: readNullableString(record.runtimeId, `${source}.runtimeId`),
		modelId: readNullableString(record.modelId, `${source}.modelId`),
		serverBuild: readNullableString(record.serverBuild, `${source}.serverBuild`),
		total_slots: totalSlots as number | null,
		thinkingLevel: readNullableString(record.thinkingLevel, `${source}.thinkingLevel`),
		compiledPromptHash,
	};
}

export function sameEvalServingConfiguration(
	left: EvalServingConfigurationV1,
	right: EvalServingConfigurationV1,
): boolean {
	return (
		left.targetId === right.targetId &&
		left.runtimeId === right.runtimeId &&
		left.modelId === right.modelId &&
		left.serverBuild === right.serverBuild &&
		left.total_slots === right.total_slots &&
		left.thinkingLevel === right.thinkingLevel &&
		left.compiledPromptHash === right.compiledPromptHash
	);
}

export function renderEvalServingConfiguration(config: EvalServingConfigurationV1): string {
	return [
		`target=${config.targetId}`,
		`runtime=${config.runtimeId ?? "unknown"}`,
		`model=${config.modelId ?? "unknown"}`,
		`server_build=${config.serverBuild ?? "unknown"}`,
		`total_slots=${config.total_slots ?? "unknown"}`,
		`thinking=${config.thinkingLevel ?? "unknown"}`,
		`compiled_prompt_hash=${config.compiledPromptHash ?? "unknown"}`,
	].join(" ");
}

function readString(value: unknown, source: string): string {
	if (typeof value !== "string" || value.length === 0) throw new Error(`${source}: expected string`);
	return value;
}

function readNullableString(value: unknown, source: string): string | null {
	if (value === null) return null;
	if (typeof value !== "string" || value.length === 0) throw new Error(`${source}: expected string or null`);
	return value;
}

function asRecord(value: unknown, source: string): Record<string, unknown> {
	if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
	throw new Error(`${source}: expected object`);
}

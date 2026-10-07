import { probeJson } from "../probe/http.js";
import type { EmbedResult } from "../types/inference.js";
import type { ProbeContext } from "../types/runtime-descriptor.js";
import type { TargetDescriptor } from "../types/target-descriptor.js";
import type { EmbeddingInput } from "./types.js";
import { EmbeddingError } from "./types.js";

export function embeddingWireInput(input: EmbeddingInput): unknown {
	if (input.kind === "video") throw new EmbeddingError("unsupported", "Video embedding has not been qualified");
	if (input.kind === "text") return input.text;
	const parts = input.kind === "mixed" ? input.parts : [input];
	return {
		content: parts.map((part) => {
			if (part.kind === "text") return { type: "text", text: part.text };
			if (part.kind === "image")
				return { type: "image_url", image_url: { url: `data:${part.mimeType};base64,${part.data}` } };
			return {
				type: "input_audio",
				input_audio: { data: part.data, format: part.mimeType === "audio/mpeg" ? "mp3" : part.mimeType.slice(6) },
			};
		}),
	};
}

export async function embedOpenAIInputs(
	target: TargetDescriptor,
	inputs: readonly EmbeddingInput[],
	ctx: ProbeContext,
): Promise<EmbedResult> {
	if (!target.url || !target.defaultModel)
		throw new EmbeddingError("invalid-input", "Embedding target requires URL and pinned model");
	const root = target.url.replace(/\/+$/, "").replace(/\/v1$/, "");
	const envName = target.auth?.apiKeyEnvVar;
	const token = ctx.authToken ?? (envName && ctx.credentialsPresent.has(envName) ? process.env[envName] : undefined);
	const response = await probeJson<{
		data?: Array<{ index?: number; embedding?: number[] }>;
		model?: string;
		usage?: { total_tokens?: number; prompt_tokens?: number };
	}>({
		url: `${root}/v1/embeddings`,
		method: "POST",
		timeoutMs: ctx.httpTimeoutMs,
		headers: {
			...target.auth?.headers,
			"content-type": "application/json",
			...(token ? { authorization: `Bearer ${token}` } : {}),
		},
		body: JSON.stringify({ model: target.defaultModel, input: inputs.map(embeddingWireInput), encoding_format: "float" }),
		...(ctx.signal ? { signal: ctx.signal } : {}),
	});
	if (!response.ok)
		throw new EmbeddingError("unavailable", `Embedding request failed: ${response.error ?? "unknown transport failure"}`);
	const data = response.data;
	if (!data || !Array.isArray(data.data) || typeof data.model !== "string")
		throw new EmbeddingError("invalid-response", "Embedding response requires data and explicit model identity");
	const rows = data.data;
	if (
		rows.length !== inputs.length ||
		rows.some((row) => !Number.isInteger(row.index) || (row.index ?? -1) < 0 || (row.index ?? 0) >= rows.length) ||
		new Set(rows.map((row) => row.index)).size !== rows.length
	)
		throw new EmbeddingError("invalid-response", "Embedding response indices/count do not match request");
	const vectors = [...rows].sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).map((row) => row.embedding ?? []);
	const tokens = data.usage?.total_tokens ?? data.usage?.prompt_tokens;
	return {
		vectors,
		model: data.model,
		dimensions: vectors[0]?.length ?? 0,
		...(tokens !== undefined ? { tokensUsed: tokens } : {}),
	};
}

import {
	canonicalEndpointKey,
	foregroundStreamUsage,
	registerBackgroundStream,
	registerForegroundStream,
} from "../endpoint-capacity.js";
import { embeddingProfileIdentity } from "./profile.js";
import { embedOpenAIInputs } from "./transport.js";
import type { EmbeddingInput, EmbeddingRequest, EmbeddingRoute, EmbeddingService } from "./types.js";
import { EmbeddingError } from "./types.js";

export function createEmbeddingService(options: {
	route: EmbeddingRoute;
	maxBatchItems?: number;
	maxInputBytes?: number;
	maxBatchBytes?: number;
	timeoutMs?: number;
}): EmbeddingService {
	let busy = false;
	const route = structuredClone(options.route);
	return {
		async embed(request: EmbeddingRequest) {
			const profile = structuredClone(request.profile);
			if (request.signal?.aborted) throw new EmbeddingError("cancelled", "Embedding cancelled");
			if (
				profile.model !== route.model ||
				!profile.assetIdentity.trim() ||
				!profile.id.trim() ||
				!Number.isInteger(profile.dimensions) ||
				profile.dimensions < 1 ||
				profile.dimensions > 65536 ||
				profile.normalization !== "l2" ||
				/f16|float16/i.test(profile.quantization)
			)
				throw new EmbeddingError(
					"profile-mismatch",
					"Embedding profile requires pinned identity, valid dimensions and non-float16 inference",
				);
			if (request.task !== "query" && request.task !== "document")
				throw new EmbeddingError("invalid-input", "Unknown embedding task");
			if (request.inputs.length < 1 || request.inputs.length > (options.maxBatchItems ?? 32))
				throw new EmbeddingError("invalid-input", "Embedding batch size exceeds bounds");
			const sources = request.inputs.map((input, index) => {
				const bytes = validateInput(input, route);
				if (bytes > (options.maxInputBytes ?? 8 * 1024 * 1024))
					throw new EmbeddingError("invalid-input", "Embedding input exceeds byte limit");
				return { index, kind: input.kind, bytes };
			});
			const inputBytes = sources.reduce((sum, source) => sum + source.bytes, 0);
			if (inputBytes > (options.maxBatchBytes ?? 16 * 1024 * 1024))
				throw new EmbeddingError("invalid-input", "Embedding batch exceeds byte limit");
			const timeoutMs = request.timeoutMs ?? options.timeoutMs ?? 30000;
			if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 300000)
				throw new EmbeddingError("invalid-input", "Embedding timeout must be between 0 and 300000ms");
			const key = route.admissionKey ?? canonicalEndpointKey(route.target);
			if (!key) throw new EmbeddingError("invalid-input", "Embedding route requires a scheduler identity");
			const background = request.priority === "background";
			if (
				busy ||
				(background &&
					[key, ...(route.foregroundKeys ?? [])].some((candidate) => (foregroundStreamUsage()[candidate] ?? 0) > 0))
			)
				throw new EmbeddingError("paused", "Embedding admission paused for active inference");
			const controller = new AbortController();
			let abortCode: "cancelled" | "timeout" | "paused" = "cancelled";
			const abort = () => controller.abort();
			request.signal?.addEventListener("abort", abort, { once: true });
			const timer = setTimeout(() => {
				abortCode = "timeout";
				controller.abort();
			}, timeoutMs);
			busy = true;
			const releases = background
				? [...new Set([key, ...(route.foregroundKeys ?? [])])].map((schedulerKey) =>
						registerBackgroundStream(schedulerKey, {
							limit: 1,
							preempt: () => {
								abortCode = "paused";
								controller.abort();
							},
						}),
					)
				: [registerForegroundStream(key)];
			try {
				const prefix = request.task === "query" ? profile.queryPrefix : profile.documentPrefix;
				const inputs = request.inputs.map(
					(input): EmbeddingInput =>
						input.kind === "text"
							? { ...input, text: prefix + input.text }
							: input.kind === "mixed"
								? {
										...input,
										parts: input.parts.map((part) => (part.kind === "text" ? { ...part, text: prefix + part.text } : part)),
									}
								: input,
				);
				const result = await embedOpenAIInputs({ ...route.target, defaultModel: route.model }, inputs, {
					httpTimeoutMs: timeoutMs,
					credentialsPresent: new Set(route.target.auth?.apiKeyEnvVar ? [route.target.auth.apiKeyEnvVar] : []),
					signal: controller.signal,
					...(route.authToken ? { authToken: route.authToken } : {}),
				});
				if (controller.signal.aborted) throw new EmbeddingError(abortCode, `Embedding ${abortCode}`);
				if (result.model !== route.model)
					throw new EmbeddingError(
						"profile-mismatch",
						`Returned embedding model ${result.model} differs from ${route.model}`,
					);
				if (result.dimensions !== profile.dimensions || result.vectors.length !== inputs.length)
					throw new EmbeddingError("invalid-response", "Embedding count or dimensions mismatch");
				const vectors = result.vectors.map((vector) => {
					if (
						!Array.isArray(vector) ||
						vector.length !== profile.dimensions ||
						vector.some((value) => typeof value !== "number" || !Number.isFinite(value))
					)
						throw new EmbeddingError("invalid-response", "Embedding contains ragged or nonfinite vectors");
					const scale = Math.max(...vector.map(Math.abs));
					if (scale === 0) throw new EmbeddingError("invalid-response", "Embedding contains a zero vector");
					const norm = Math.sqrt(vector.reduce((sum, value) => sum + (value / scale) ** 2, 0));
					return vector.map((value) => value / scale / norm);
				});
				return {
					vectors,
					profile: structuredClone(profile),
					profileIdentity: embeddingProfileIdentity(profile),
					dimensions: profile.dimensions,
					model: result.model,
					sources,
					usage: {
						inputItems: inputs.length,
						inputBytes,
						...(result.tokensUsed !== undefined ? { tokens: result.tokensUsed } : {}),
					},
					warnings:
						profile.canaryFingerprint === null
							? ["Embedding asset identity is operator-pinned; canary fingerprint has not been qualified"]
							: [],
				};
			} catch (error) {
				if (controller.signal.aborted) throw new EmbeddingError(abortCode, `Embedding ${abortCode}`);
				throw error;
			} finally {
				clearTimeout(timer);
				request.signal?.removeEventListener("abort", abort);
				for (const release of releases) release();
				busy = false;
			}
		},
	};
}

function validateInput(input: EmbeddingInput, route: EmbeddingRoute): number {
	if (input.kind === "video" || !route.modalities.includes(input.kind))
		throw new EmbeddingError("unsupported", `Embedding modality ${input.kind} is not qualified on this route`);
	if (input.kind === "mixed") {
		if (input.parts.length < 1 || input.parts.length > 64)
			throw new EmbeddingError("invalid-input", "Mixed input requires 1..64 ordered parts");
		return input.parts.reduce((sum, part) => sum + validateInput(part, route), 0);
	}
	if (input.kind === "text") {
		if (typeof input.text !== "string" || !input.text.trim())
			throw new EmbeddingError("invalid-input", "Embedding text must be nonempty");
		return Buffer.byteLength(input.text);
	}
	const allowed =
		input.kind === "image"
			? ["image/png", "image/jpeg", "image/webp"]
			: ["audio/wav", "audio/mpeg", "audio/flac", "audio/ogg"];
	if (
		!allowed.includes(input.mimeType) ||
		typeof input.data !== "string" ||
		!input.data ||
		input.data.length % 4 !== 0 ||
		!/^[A-Za-z0-9+/]*={0,2}$/.test(input.data) ||
		Buffer.from(input.data, "base64").toString("base64") !== input.data
	)
		throw new EmbeddingError("invalid-input", "Media requires supported MIME type and canonical raw base64");
	return Buffer.byteLength(input.data, "base64");
}

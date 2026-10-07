import type { TargetDescriptor } from "../types/target-descriptor.js";

export type EmbeddingTask = "query" | "document";
export type EmbeddingPart =
	| { kind: "text"; text: string }
	| { kind: "image"; data: string; mimeType: "image/png" | "image/jpeg" | "image/webp" }
	| { kind: "audio"; data: string; mimeType: "audio/wav" | "audio/mpeg" | "audio/flac" | "audio/ogg" };
export type EmbeddingInput =
	| EmbeddingPart
	| { kind: "mixed"; parts: readonly EmbeddingPart[] }
	| { kind: "video"; data: string; mimeType: string };
export interface EmbeddingProfile {
	id: string;
	model: string;
	assetIdentity: string;
	projectorIdentity: string | null;
	quantization: string;
	dimensions: number;
	pooling: "mean" | "last";
	normalization: "l2";
	queryPrefix: string;
	documentPrefix: string;
	preprocessingVersion: string;
	canaryFingerprint: string | null;
}
export interface EmbeddingRequest {
	inputs: readonly EmbeddingInput[];
	task: EmbeddingTask;
	profile: EmbeddingProfile;
	signal?: AbortSignal;
	priority?: "foreground" | "background";
	timeoutMs?: number;
}
export interface EmbeddingResponse {
	vectors: number[][];
	profile: EmbeddingProfile;
	profileIdentity: string;
	dimensions: number;
	model: string;
	sources: Array<{ index: number; kind: EmbeddingInput["kind"]; bytes: number }>;
	usage: { inputItems: number; inputBytes: number; tokens?: number };
	warnings: string[];
}
export interface EmbeddingRoute {
	target: TargetDescriptor;
	model: string;
	/** Explicit qualified modalities; text is required. Video is intentionally unsupported. */
	modalities: readonly ("text" | "image" | "audio" | "mixed")[];
	authToken?: string;
}
export interface EmbeddingService {
	embed(request: EmbeddingRequest): Promise<EmbeddingResponse>;
}
export type EmbeddingErrorCode =
	| "invalid-input"
	| "unsupported"
	| "profile-mismatch"
	| "invalid-response"
	| "unavailable"
	| "paused"
	| "cancelled"
	| "timeout";
export class EmbeddingError extends Error {
	constructor(
		public readonly code: EmbeddingErrorCode,
		message: string,
	) {
		super(message);
		this.name = "EmbeddingError";
	}
}

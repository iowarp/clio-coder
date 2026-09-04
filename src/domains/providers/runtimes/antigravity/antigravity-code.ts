import { spawn } from "node:child_process";

import type { Api, Model } from "../../../../engine/types.js";

import { synthesizeCatalogBackedModel } from "../../catalog.js";
import type { CapabilityFlags } from "../../types/capability-flags.js";
import type { KnowledgeBaseHit } from "../../types/knowledge-base.js";
import type { ProbeContext, RuntimeDescriptor } from "../../types/runtime-descriptor.js";
import type { TargetDescriptor } from "../../types/target-descriptor.js";

/**
 * Antigravity CLI (`agy`) external delegation runtime.
 *
 * This is deliberately a dispatch-only subprocess, not a Gemini inference
 * provider. The installed official CLI owns authentication, its agent loop,
 * tools, and model access. Clio supplies a bounded work order and translates
 * the CLI's structured print-mode result into a worker result.
 */

export const ANTIGRAVITY_AUTH_NOTICE =
	"Experimental local delegation through your installed Antigravity (`agy`) CLI. Clio neither signs in nor stores " +
	"Antigravity credentials. Use it only on your own machine with an account you logged into directly in `agy`.";

// A small bootstrap list keeps first-time configuration useful while the live
// `agy models` probe is still cold. These are CLI slugs, not Gemini API ids;
// every successful probe replaces this fallback with the account's own list.
export const ANTIGRAVITY_MODELS: ReadonlyArray<string> = [
	"gemini-3.8-flash-high",
	"gemini-3.8-flash-medium",
	"gemini-3.8-flash-low",
	"gemini-3.1-pro-high",
	"gemini-3.1-pro-low",
];

export const antigravityCapabilities: CapabilityFlags = {
	chat: true,
	tools: true,
	toolCallFormat: "openai",
	reasoning: true,
	vision: false,
	audio: false,
	embeddings: false,
	rerank: false,
	fim: false,
	contextWindow: 1_000_000,
	maxTokens: 8192,
};

const MAX_CATALOG_BYTES = 1024 * 1024;
const MAX_DISCOVERED_MODELS = 64;

function record(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

/** Decode the machine-readable catalog emitted by `agy --output-format json models`. */
export function parseAntigravityModelCatalog(output: string): string[] {
	let decoded: unknown;
	try {
		decoded = JSON.parse(output);
	} catch {
		throw new Error("agy returned an unreadable model catalog; update the Antigravity CLI");
	}
	const envelope = record(decoded);
	const command = record(envelope?.command);
	const data = record(command?.data);
	if (envelope?.status !== "SUCCESS" || command?.name !== "models" || !Array.isArray(data?.models)) {
		throw new Error("agy returned an unsupported model catalog; update the Antigravity CLI");
	}
	const models: string[] = [];
	const seen = new Set<string>();
	for (const value of data.models) {
		const model = record(value);
		const id = typeof model?.id === "string" ? model.id.trim() : "";
		if (id.length === 0 || id.length > 256 || /[\r\n\0]/u.test(id)) {
			throw new Error("agy returned an invalid model identifier");
		}
		if (!seen.has(id)) {
			seen.add(id);
			models.push(id);
		}
		if (models.length >= MAX_DISCOVERED_MODELS) break;
	}
	if (models.length === 0) {
		throw new Error("agy returned no available models; run `agy` locally and finish Google sign-in");
	}
	return models;
}

function probeAntigravityModels(ctx: ProbeContext): Promise<{ models: string[]; latencyMs: number }> {
	return new Promise((resolve, reject) => {
		const startedAt = Date.now();
		const child = spawn("agy", ["--output-format", "json", "models"], {
			cwd: process.cwd(),
			env: process.env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		let settled = false;
		const finish = (error?: Error): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			ctx.signal?.removeEventListener("abort", abort);
			if (error) reject(error);
			else {
				try {
					resolve({ models: parseAntigravityModelCatalog(stdout), latencyMs: Date.now() - startedAt });
				} catch (cause) {
					reject(cause);
				}
			}
		};
		const abort = (): void => {
			if (child.exitCode === null) child.kill("SIGKILL");
			finish(new Error(ctx.signal?.aborted ? "agy model discovery was cancelled" : "agy model discovery timed out"));
		};
		const timer = setTimeout(abort, Math.max(1, ctx.httpTimeoutMs));
		ctx.signal?.addEventListener("abort", abort, { once: true });
		if (ctx.signal?.aborted) abort();
		child.stdout.on("data", (chunk) => {
			stdout += String(chunk);
			if (Buffer.byteLength(stdout) > MAX_CATALOG_BYTES) {
				if (child.exitCode === null) child.kill("SIGKILL");
				finish(new Error("agy model catalog exceeded 1 MiB"));
			}
		});
		child.stderr.on("data", (chunk) => {
			stderr = `${stderr}${String(chunk)}`.slice(-8192);
		});
		child.once("error", (cause) => {
			const detail =
				(cause as NodeJS.ErrnoException).code === "ENOENT" ? "install `agy` and put it on PATH" : cause.message;
			finish(new Error(`could not start Antigravity CLI: ${detail}`));
		});
		child.once("close", (code) => {
			if (settled) return;
			if (code !== 0) {
				const detail = stderr.trim() || `agy exited ${code ?? "without a status"}`;
				finish(new Error(`Antigravity CLI is unavailable: ${detail}`));
				return;
			}
			finish();
		});
	});
}

const antigravityCodeRuntime: RuntimeDescriptor = {
	id: "antigravity-code",
	displayName: "Antigravity CLI (experimental)",
	kind: "subprocess",
	tier: "subscription",
	// The worker branches on runtime id before pi-ai inference. This family is
	// therefore only an internal erased model shape; no Gemini API request occurs.
	apiFamily: "google-generative-ai",
	auth: "none",
	authNotice: ANTIGRAVITY_AUTH_NOTICE,
	knownModels: [...ANTIGRAVITY_MODELS],
	binaryName: "agy",
	headlessCommand: "agy --output-format stream-json --print",
	outputParser: "antigravity-stream-json",
	defaultCapabilities: antigravityCapabilities,
	async probe(_target: TargetDescriptor, ctx: ProbeContext) {
		try {
			const result = await probeAntigravityModels(ctx);
			return { ok: true, latencyMs: result.latencyMs, models: result.models };
		} catch (cause) {
			return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
		}
	},
	synthesizeModel(target: TargetDescriptor, wireModelId: string, kb: KnowledgeBaseHit | null): Model<Api> {
		return synthesizeCatalogBackedModel({
			target,
			wireModelId,
			kb,
			defaultCapabilities: antigravityCapabilities,
			runtimeId: "antigravity-code",
			api: "google-generative-ai",
			provider: "google",
			defaultBaseUrl: "antigravity-cli://local",
		});
	},
};

export default antigravityCodeRuntime;

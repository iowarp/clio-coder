import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, writeFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { Api, AssistantMessageEventStream, Model, StreamOptions } from "@earendil-works/pi-ai";
import type { TargetCacheSettings } from "../domains/providers/types/target-descriptor.js";
import type { PinnedPromptPrefix } from "./apis/anthropic-system-split.js";
import { splitAnthropicSystem } from "./apis/anthropic-system-split.js";
import { findEngineEnvKeys } from "./env-api-keys.js";

/**
 * Which caller a provider call serves. A subscription runtime may give the
 * session's own turn requests a longer cache lifetime; workers and side calls
 * (compaction, memory, judges, side questions) keep the provider default, as
 * Claude Code does for its subagents and side requests (#422).
 */
export type ProviderCallScope = "main" | "side";

type ClioCoderCacheMetadata = { clioCoder?: { cache?: TargetCacheSettings; mainThreadCacheRetention?: "long" } };

/**
 * The cache retention a request takes once the request, the target, the Anthropic environment override and the
 * main-thread default have spoken, in that order (#422). The cache keepalive reads the same answer (#423).
 */
export function effectiveCacheRetention(
	model: Model<Api>,
	options: StreamOptions | undefined,
	scope: ProviderCallScope,
): StreamOptions["cacheRetention"] {
	const metadata = (model as Model<Api> & ClioCoderCacheMetadata).clioCoder;
	const requested = options?.cacheRetention ?? metadata?.cache?.retention;
	if (requested !== undefined || model.api !== "anthropic-messages") return requested;
	const retention = process.env.CLIO_CODER_ANTHROPIC_CACHE_RETENTION;
	if (retention !== undefined && retention !== "") {
		if (retention !== "none" && retention !== "short" && retention !== "long") {
			throw new Error("CLIO_CODER_ANTHROPIC_CACHE_RETENTION must be none, short, or long");
		}
		return retention;
	}
	return scope === "main" ? metadata?.mainThreadCacheRetention : undefined;
}

/** Process-owned opt-in reaches every native engine call, including prewarm and workers. */
export function instrumentProviderCall<T extends StreamOptions>(
	model: Model<Api>,
	options: T | undefined,
	invoke: (options: T | undefined) => AssistantMessageEventStream,
	scope: ProviderCallScope = "side",
): AssistantMessageEventStream {
	const retention = effectiveCacheRetention(model, options, scope);
	let effective =
		options?.cacheRetention !== undefined || retention === undefined
			? options
			: ({ ...options, cacheRetention: retention } as T);
	const { clioCoderPinnedPrefix, ...providerOptions } = (effective ?? {}) as T & {
		clioCoderPinnedPrefix?: PinnedPromptPrefix;
	};
	if (clioCoderPinnedPrefix !== undefined) {
		// Clio's compiler metadata never reaches Pi or a provider option surface (#423).
		effective = providerOptions as T;
		if (scope === "main" && model.api === "anthropic-messages") {
			const onPayload = effective.onPayload;
			effective = {
				...effective,
				onPayload: async (payload: unknown, currentModel: Model<Api>) => {
					const replacement = await onPayload?.(payload, currentModel);
					return splitAnthropicSystem(replacement === undefined ? payload : replacement, clioCoderPinnedPrefix);
				},
			} as T;
		}
	}
	const path = process.env.CLIO_CODER_PROVIDER_DUMP_PATH;
	if (!path) return invoke(effective);
	const sink = openDump(path);
	const payloads: unknown[] = [];
	const redact = diagnosticSerializer(model, effective);
	const callId = randomUUID();
	const onPayload = effective?.onPayload;
	const instrumented = {
		...effective,
		onPayload: async (payload: unknown, currentModel: Model<Api>) => {
			// Caller-owned thinking/tool/schema patches finish first. Snapshot now:
			// providers and callbacks can retain or mutate their objects afterward.
			const replacement = await onPayload?.(payload, currentModel);
			try {
				payloads.push(JSON.parse(redact(replacement === undefined ? payload : replacement)));
			} catch {
				payloads.push({ diagnosticError: "payload could not be serialized" });
			}
			return replacement;
		},
	} as T;
	const finish = (terminal: { response: unknown } | { error: string }) => {
		try {
			writeFileSync(sink, `${redact({ callId, api: model.api, model: model.id, payloads, ...terminal })}\n`, "utf8");
		} catch {
			// Diagnostics must not turn a completed provider call into a retry or
			// inject content into the ledger. Report only the sink failure category.
			process.emitWarning("Provider diagnostic dump could not be written", { code: "CLIO_CODER_PROVIDER_DUMP_FAILED" });
		} finally {
			try {
				closeSync(sink);
			} catch {
				process.emitWarning("Provider diagnostic dump could not be closed", { code: "CLIO_CODER_PROVIDER_DUMP_FAILED" });
			}
		}
	};
	try {
		const stream = invoke(instrumented);
		// result() observes the existing terminal promise; it never consumes the
		// event iterator that the agent and durable ledger projection own.
		void stream.result().then(
			(response) => finish({ response }),
			(error) => finish({ error: String(error) }),
		);
		return stream;
	} catch (error) {
		finish({ error: error instanceof Error ? error.message : String(error) });
		throw error;
	}
}

/** Refuse insecure existing files instead of silently changing their permissions. */
function openDump(path: string): number {
	if (!isAbsolute(path)) throw new Error("CLIO_CODER_PROVIDER_DUMP_PATH must be an absolute file path");
	const fd = openSync(
		path,
		constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK,
		0o600,
	);
	try {
		const stat = fstatSync(fd);
		if (
			!stat.isFile() ||
			(stat.mode & 0o777) !== 0o600 ||
			(process.getuid !== undefined && stat.uid !== process.getuid())
		) {
			throw new Error("CLIO_CODER_PROVIDER_DUMP_PATH must be an operator-owned regular file with mode 0600");
		}
		return fd;
	} catch (error) {
		closeSync(fd);
		throw error;
	}
}

function diagnosticSerializer(model: Model<Api>, options: StreamOptions | undefined): (value: unknown) => string {
	const secrets = new Set<string>();
	const ambientKeys = (findEngineEnvKeys(model.provider, options?.env) ?? []).map(
		(name) => options?.env?.[name] || process.env[name],
	);
	for (const key of [options?.apiKey, ...ambientKeys]) {
		if (key && key !== "<authenticated>") secrets.add(key);
	}
	for (const headers of [options?.headers, model.headers]) {
		for (const [key, value] of Object.entries(headers ?? {})) {
			if (typeof value === "string" && value.length > 0 && /auth|api[-_]?key|cookie|token|secret/iu.test(key)) {
				secrets.add(value);
				const token = value.match(/^(?:Bearer|Basic)\s+(.+)$/iu)?.[1];
				if (token) secrets.add(token);
			}
		}
	}
	return (value) => {
		// This is a body-level diagnostic, never an HTTP/auth/options dump. Keep
		// nested tool schemas intact, including tools with a parameter named headers.
		const body =
			typeof value === "object" && value !== null && !Array.isArray(value)
				? Object.fromEntries(
						Object.entries(value).filter(([key]) => !/^(?:headers|env|apiKey|api_key|authorization)$/iu.test(key)),
					)
				: value;
		// Encrypted provider state is usable context, never diagnostic text (#423).
		let serialized = JSON.stringify(body, (_key, value: unknown) =>
			value !== null && typeof value === "object" && "type" in value && value.type === "compaction"
				? { type: "compaction", encrypted_content: "[REDACTED]" }
				: value,
		);
		if (serialized === undefined) serialized = "null";
		for (const secret of secrets) serialized = serialized.replaceAll(JSON.stringify(secret).slice(1, -1), "[REDACTED]");
		return serialized;
	};
}

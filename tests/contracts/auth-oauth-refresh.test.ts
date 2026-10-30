/**
 * Stored OAuth refresh, cross-store locking, failure handling and the login
 * callback path had no coverage before the Pi credential-store adoption. These
 * scenarios pin the behavior callers depend on, offline: `globalThis.fetch`
 * answers with Globus- or Anthropic-shaped token responses and is restored
 * after every test.
 */
import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { rememberOAuthCallFailure, withOAuthRefresh } from "../../src/core/oauth-retry.js";
import { isProviderAuthRejection } from "../../src/core/provider-auth-error.js";
import { FileAuthStorageBackend } from "../../src/domains/providers/auth/backend-file.js";
import { AuthStorage, resolveAuthTarget } from "../../src/domains/providers/auth/storage.js";
import type { ProvidersContract } from "../../src/domains/providers/contract.js";
import { resolveSideCallAuth } from "../../src/domains/providers/side-call-auth.js";
import type { RuntimeDescriptor } from "../../src/domains/providers/types/runtime-descriptor.js";
import type { TargetDescriptor } from "../../src/domains/providers/types/target-descriptor.js";
import { registerClioOAuthProviders } from "../../src/engine/oauth.js";
import { retryStreamOnceOnAuthRejection } from "../../src/engine/oauth-retry-stream.js";

// The engine registry is lazy and ALCF joins it only through this call, which
// the providers extension and the configure and target CLI paths make.
registerClioOAuthProviders();

const realFetch = globalThis.fetch;

function globusResponse(access: string, refresh = "refresh-new", expiresIn = 3600): Response {
	return new Response(
		JSON.stringify({
			access_token: "root-token-not-gateway",
			resource_server: "auth.globus.org",
			other_tokens: [
				{
					resource_server: "681c10cc-f684-4540-bcd7-0b4df3bc26ef",
					access_token: access,
					refresh_token: refresh,
					expires_in: expiresIn,
				},
			],
		}),
		{ status: 200, headers: { "content-type": "application/json" } },
	);
}

describe("contracts/auth OAuth refresh", () => {
	let root: string;
	let path: string;
	let calls: Array<{ url: string; body: string }>;
	const open = (): AuthStorage => new AuthStorage(new FileAuthStorageBackend(path));

	function seed(expiresInMs: number): void {
		writeFileSync(
			path,
			[
				"version: 2",
				"entries:",
				"  alcf:",
				"    type: oauth",
				"    access: old-access",
				"    refresh: refresh-old",
				`    expires: ${Date.now() + expiresInMs}`,
				"    updatedAt: 2026-01-01T00:00:00.000Z",
				"  mistral:",
				"    type: api_key",
				'    key: "sk-keep"',
				"",
			].join("\n"),
			"utf8",
		);
	}

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "clio-coder-oauth-refresh-"));
		path = join(root, "credentials.yaml");
		calls = [];
	});
	afterEach(() => {
		globalThis.fetch = realFetch;
		rmSync(root, { recursive: true, force: true });
	});

	it("refreshes an expired credential, persists it, and returns the new key", async () => {
		seed(-1000);
		globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
			calls.push({ url: String(url), body: String(init?.body) });
			return globusResponse("access-new");
		}) as typeof fetch;
		const storage = open();
		const resolved = await storage.resolveApiKey("alcf");
		strictEqual(resolved.apiKey, "access-new");
		strictEqual(calls.length, 1);
		ok(calls[0]?.body.includes("grant_type=refresh_token"));
		const text = readFileSync(path, "utf8");
		ok(text.includes("access-new") && text.includes("refresh-new"), text);
		ok(text.includes("sk-keep"), "the other provider's key survives the rewrite");
		strictEqual(storage.damageReason(), null);
		const reopened = open().get("alcf");
		strictEqual(reopened?.type, "oauth");
		ok(typeof reopened?.updatedAt === "string" && reopened.updatedAt !== "2026-01-01T00:00:00.000Z");
	});

	it("does not call the network for a credential with more than five minutes left", async () => {
		seed(60 * 60_000);
		globalThis.fetch = (async () => {
			throw new Error("network must not be touched");
		}) as typeof fetch;
		strictEqual((await open().resolveApiKey("alcf")).apiKey, "old-access");
	});

	it("refreshes inside the skew window and on a server rejection of an unexpired token (#427)", async () => {
		globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
			calls.push({ url: String(url), body: String(init?.body) });
			return globusResponse(`access-${calls.length}`);
		}) as typeof fetch;
		// Two minutes left is inside the five-minute margin, so the token is refreshed before use.
		seed(2 * 60_000);
		strictEqual((await open().resolveApiKey("alcf")).apiKey, "access-1");
		strictEqual(calls.length, 1);

		// Codex has an hour left locally, but the server rejects it: one locked refresh, one same-call retry.
		writeFileSync(
			path,
			[
				"version: 2",
				"entries:",
				"  openai-codex:",
				"    type: oauth",
				"    access: codex-old",
				"    refresh: refresh-old",
				`    expires: ${Date.now() + 60 * 60_000}`,
				"    updatedAt: 2026-01-01T00:00:00.000Z",
				"",
			].join("\n"),
		);
		const claims = { "https://api.openai.com/auth": { chatgpt_account_id: "acct-427" } };
		const codexAccess = `h.${Buffer.from(JSON.stringify(claims)).toString("base64")}.s`;
		globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
			calls.push({ url: String(url), body: String(init?.body) });
			return new Response(JSON.stringify({ access_token: codexAccess, refresh_token: "refresh-new", expires_in: 3600 }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as typeof fetch;
		const storage = open();
		// The same delegation the providers extension gives the auth contract.
		const auth = {
			resolveForTarget: (target, runtime, options) =>
				storage.resolveForTarget(resolveAuthTarget(target, runtime), { includeFallback: false, ...options }),
		} as Pick<ProvidersContract["auth"], "resolveForTarget"> as ProvidersContract["auth"];
		const sideAuth = await resolveSideCallAuth(
			auth,
			{ id: "codex", runtime: "openai-codex" } as TargetDescriptor,
			{ id: "openai-codex", auth: "oauth" } as RuntimeDescriptor,
			"unused",
		);
		strictEqual(sideAuth.apiKey, "codex-old");
		strictEqual(calls.length, 1, "a locally unexpired token is used without a refresh");
		const sent: string[] = [];
		const answer = await withOAuthRefresh(sideAuth, async ({ apiKey }) => {
			sent.push(String(apiKey));
			if (apiKey !== "codex-old") return "ok";
			// The message alone does not read as an auth rejection; only the recorded 401 does.
			const error = new Error("provider request failed");
			rememberOAuthCallFailure(error, { invoked: true, stage: "provider", httpStatus: 401, errorClass: "http" });
			throw error;
		});
		strictEqual(answer, "ok");
		deepStrictEqual(sent, ["codex-old", codexAccess]);
		strictEqual(calls.length, 2, "exactly one refresh for the rejection");
		ok(calls[1]?.url.includes("auth.openai.com/oauth/token"), calls[1]?.url);
		ok(readFileSync(path, "utf8").includes(codexAccess), "the forced rotation is persisted");
	});

	it("retries a worker round once on an auth rejection and otherwise keeps the round's own ending (#427)", async () => {
		type Message = Parameters<ReturnType<typeof createAssistantMessageEventStream>["end"]>[0] & object;
		const base = {
			role: "assistant",
			content: [],
			api: "openai-codex-responses",
			provider: "openai-codex",
			model: "m",
			timestamp: 1,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		};
		const stream = (text: string | null, errorMessage?: string) => {
			const s = createAssistantMessageEventStream();
			const message = {
				...base,
				...(errorMessage === undefined ? { stopReason: "stop" } : { stopReason: "error", errorMessage }),
				content: text === null ? [] : [{ type: "text", text }],
			} as Message;
			queueMicrotask(() => {
				s.push({ type: "start", partial: message });
				if (text !== null) s.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
				s.push(
					errorMessage === undefined
						? { type: "done", reason: "stop", message }
						: { type: "error", reason: "error", error: message },
				);
				s.end(message);
			});
			return s;
		};
		const rejected = "Your authentication token has expired. Please try refreshing it.";
		const isAuth = (error: Message) => isProviderAuthRejection(error.errorMessage);
		const run = async (source: ReturnType<typeof stream>, recover: () => Promise<ReturnType<typeof stream> | null>) => {
			let recovers = 0;
			const out = retryStreamOnceOnAuthRejection(source, isAuth, () => {
				recovers++;
				return recover();
			});
			const events: string[] = [];
			for await (const event of out) events.push(event.type);
			const result = await out.result();
			return {
				recovers,
				events,
				stopReason: result.stopReason,
				errorMessage: result.errorMessage,
				text: result.content[0]?.type === "text" ? result.content[0].text : null,
			};
		};
		const recovered = await run(stream(null, rejected), async () => stream("retried"));
		deepStrictEqual(recovered, {
			recovers: 1,
			events: ["start", "text_delta", "done"],
			stopReason: "stop",
			errorMessage: undefined,
			text: "retried",
		});
		const noCredential = await run(stream(null, rejected), async () => null);
		deepStrictEqual(noCredential, {
			recovers: 1,
			events: ["start", "error"],
			stopReason: "error",
			errorMessage: rejected,
			text: null,
		});
		const remedy =
			"OAuth credential for target 'codex' could not be refreshed. Run clio-coder auth login openai-codex again.";
		const failedRefresh = await run(stream(null, rejected), async () => {
			throw new Error(remedy);
		});
		deepStrictEqual(failedRefresh, {
			recovers: 1,
			events: ["start", "error"],
			stopReason: "error",
			errorMessage: remedy,
			text: null,
		});
		const otherError = await run(stream(null, "503 Service Unavailable"), async () => stream("never"));
		deepStrictEqual(otherError, {
			recovers: 0,
			events: ["start", "error"],
			stopReason: "error",
			errorMessage: "503 Service Unavailable",
			text: null,
		});
		// A rejection after content already streamed is the round's own ending; the caller has seen output.
		const afterOutput = await run(stream("partial", rejected), async () => stream("never"));
		deepStrictEqual(afterOutput, {
			recovers: 0,
			events: ["start", "text_delta", "error"],
			stopReason: "error",
			errorMessage: rejected,
			text: "partial",
		});
	});

	it("refreshes once when two stores race on the same file", async () => {
		seed(-1000);
		globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
			calls.push({ url: String(url), body: String(init?.body) });
			await new Promise((resolve) => setTimeout(resolve, 30));
			return globusResponse("access-once");
		}) as typeof fetch;
		const [a, b] = await Promise.all([open().resolveApiKey("alcf"), open().resolveApiKey("alcf")]);
		strictEqual(a.apiKey, "access-once");
		strictEqual(b.apiKey, "access-once");
		strictEqual(calls.length, 1, "double-checked locking: the second store sees the first store's token");
	});

	it("leaves the file byte-identical and reports no key when the refresh is rejected", async () => {
		seed(-1000);
		const before = readFileSync(path, "utf8");
		globalThis.fetch = (async () => new Response("invalid_grant", { status: 400 })) as typeof fetch;
		const storage = open();
		const resolved = await storage.resolveApiKey("alcf");
		strictEqual(resolved.apiKey, undefined);
		strictEqual(resolved.available, false);
		strictEqual(resolved.source, "stored-oauth");
		strictEqual(storage.status("alcf").available, false);
		strictEqual(readFileSync(path, "utf8"), before);
	});

	it("keeps the committed credential when the refreshed token cannot be written", async () => {
		seed(-1000);
		globalThis.fetch = (async () => globusResponse("access-unwritable")) as typeof fetch;
		const committed = readFileSync(path, "utf8");
		const backend = new FileAuthStorageBackend(path);
		const storage = new AuthStorage({
			read: () => backend.read(),
			withLock: (fn) => backend.withLock(fn),
			withLockAsync: (fn, options) =>
				backend.withLockAsync(async (current) => {
					const out = await fn(current);
					if (out.next !== undefined) throw new Error("ENOSPC: no space left on device");
					return out;
				}, options),
		});
		const resolved = await storage.resolveApiKey("alcf");
		strictEqual(resolved.apiKey, undefined, "an unpersisted rotation is not advertised");
		strictEqual(readFileSync(path, "utf8"), committed);
		const kept = storage.get("alcf");
		ok(kept?.type === "oauth" && kept.access === "old-access", "the committed credential is still the one in memory");
	});

	it("propagates an abort instead of reporting a missing key", async () => {
		seed(-1000);
		const controller = new AbortController();
		globalThis.fetch = ((_url: unknown, init?: RequestInit) =>
			new Promise((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
				controller.abort(new Error("operator cancelled"));
			})) as typeof fetch;
		await rejects(open().resolveApiKey("alcf", { signal: controller.signal }), /operator cancelled/);
	});

	it("logs in through ALCF using the callback shape the CLI and TUI implement", async () => {
		globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
			calls.push({ url: String(url), body: String(init?.body) });
			return globusResponse("access-login");
		}) as typeof fetch;
		const events: string[] = [];
		const storage = open();
		await storage.login("alcf", {
			onAuth: ({ url }) => events.push(`auth:${new URL(url).searchParams.get("client_id")}`),
			onDeviceCode: () => events.push("device"),
			onPrompt: async () => {
				events.push("prompt");
				return "x";
			},
			onSelect: async () => undefined,
			onManualCodeInput: async () => "https://auth.globus.org/v2/web/auth-code?code=abc123",
			onProgress: (message) => events.push(`progress:${message.slice(0, 10)}`),
		});
		deepStrictEqual(events, ["auth:58fdd3bc-e1c3-4ce5-80ea-8d6b87cfb944", "progress:Exchanging"]);
		ok(calls[0]?.body.includes("code=abc123"));
		const stored = storage.get("alcf");
		strictEqual(stored?.type, "oauth");
		strictEqual(storage.damageReason(), null);
		deepStrictEqual(
			storage.getOAuthProviders().map((p) => p.id),
			["alcf", "anthropic-max", "github-copilot", "openai-codex"],
		);
	});

	it("refreshes Pi's own Anthropic OAuth the same way, offline", async () => {
		writeFileSync(
			path,
			[
				"version: 2",
				"entries:",
				"  anthropic-max:",
				"    type: oauth",
				"    access: sk-ant-oat01-old",
				"    refresh: refresh-old",
				`    expires: ${Date.now() - 1000}`,
				"    updatedAt: 2026-01-01T00:00:00.000Z",
				"",
			].join("\n"),
		);
		globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
			calls.push({ url: String(url), body: String(init?.body) });
			return new Response(
				JSON.stringify({ access_token: "sk-ant-oat01-new", refresh_token: "refresh-new", expires_in: 3600 }),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}) as typeof fetch;
		const resolved = await open().resolveApiKey("anthropic-max");
		strictEqual(resolved.apiKey, "sk-ant-oat01-new");
		strictEqual(calls.length, 1);
		ok(calls[0]?.url.includes("oauth/token"), calls[0]?.url);
	});
});

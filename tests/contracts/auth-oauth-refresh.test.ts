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
import { FileAuthStorageBackend } from "../../src/domains/providers/auth/backend-file.js";
import { AuthStorage } from "../../src/domains/providers/auth/storage.js";

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

	function seed(expiresInMs: number, extra = ""): void {
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
				extra,
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
		globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
			calls.push({ url: String(url), body: String(init?.body) });
			throw new Error("network must not be touched");
		}) as typeof fetch;
		strictEqual((await open().resolveApiKey("alcf")).apiKey, "old-access");
		strictEqual(calls.length, 0);
	});

	it("keeps a token that has not expired when the early refresh fails", async () => {
		seed(2 * 60_000);
		const before = readFileSync(path, "utf8");
		globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
			calls.push({ url: String(url), body: String(init?.body) });
			return new Response("temporarily unavailable", { status: 503 });
		}) as typeof fetch;
		strictEqual((await open().resolveApiKey("alcf")).apiKey, "old-access");
		ok(calls.length >= 1, "the refresh was attempted");
		strictEqual(readFileSync(path, "utf8"), before);
	});

	it("refreshes inside Pi's five-minute window instead of only at expiry", async () => {
		seed(2 * 60_000);
		globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
			calls.push({ url: String(url), body: String(init?.body) });
			return globusResponse("access-early");
		}) as typeof fetch;
		strictEqual((await open().resolveApiKey("alcf")).apiKey, "access-early");
		strictEqual(calls.length, 1);
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
		strictEqual(resolved.available, true);
		strictEqual(resolved.source, "stored-oauth");
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
		ok(storage.damageReason()?.includes("no space left on device"), `got: ${storage.damageReason()}`);
	});

	it("never rewrites a damaged store while refreshing", async () => {
		seed(-1000, "\tstray: tab");
		const before = readFileSync(path, "utf8");
		globalThis.fetch = (async () => {
			throw new Error("network must not be touched for a store that read as empty");
		}) as typeof fetch;
		const storage = open();
		ok(storage.damageReason()?.includes("not valid YAML"));
		const resolved = await storage.resolveApiKey("alcf");
		strictEqual(resolved.apiKey, undefined);
		strictEqual(readFileSync(path, "utf8"), before);
		await rejects(
			storage.modify("alcf", async () => ({ type: "oauth", access: "a", refresh: "r", expires: 1 })),
			/refusing to write credentials/,
		);
		strictEqual(readFileSync(path, "utf8"), before);
		strictEqual(storage.damageReason() !== null, true);
	});

	it("does not call a rejected refresh a write failure", async () => {
		seed(-1000);
		globalThis.fetch = (async () => new Response("invalid_grant", { status: 400 })) as typeof fetch;
		const storage = open();
		await storage.resolveApiKey("alcf");
		strictEqual(storage.damageReason(), null);
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

	it("refuses to persist a credential shape the file cannot represent", async () => {
		seed(60 * 60_000);
		const before = readFileSync(path, "utf8");
		await rejects(
			open().modify("amazon-bedrock", async () => ({ type: "api_key", env: { AWS_PROFILE: "p" } })),
			/not representable/,
		);
		strictEqual(readFileSync(path, "utf8"), before);
		strictEqual(open().damageReason(), null);
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
			["alcf", "anthropic", "github-copilot", "openai-codex"],
		);
	});

	it("refreshes Pi's own Anthropic OAuth the same way, offline", async () => {
		writeFileSync(
			path,
			[
				"version: 2",
				"entries:",
				"  anthropic:",
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
		const resolved = await open().resolveApiKey("anthropic");
		strictEqual(resolved.apiKey, "sk-ant-oat01-new");
		strictEqual(calls.length, 1);
		ok(calls[0]?.url.includes("oauth/token"), calls[0]?.url);
	});
});

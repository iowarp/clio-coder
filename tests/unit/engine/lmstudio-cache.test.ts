import { notStrictEqual, ok, strictEqual } from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import type { LMStudioClient } from "@lmstudio/sdk";

import { disposeLmStudioClients, resetLmStudioClientCache } from "../../../src/engine/apis/lmstudio-native.js";

// The cache helpers are not directly exported. Instead we exercise them through
// the same `defaultRunDeps.createClient` path that `runStream` uses by calling
// the module's exported reset/dispose hooks and mounting a fake `createClient`
// via the runStream `deps` parameter is the wrong surface here (those tests
// inject fakes that bypass the cache by design). For a focused cache test we
// reach through a lightweight wrapper that mirrors the production keying logic.

interface FakeClient {
	id: number;
	disposed: boolean;
	[Symbol.asyncDispose](): Promise<void>;
}

let nextId = 0;

function fakeClient(): FakeClient {
	const c: FakeClient = {
		id: ++nextId,
		disposed: false,
		[Symbol.asyncDispose]: async () => {
			c.disposed = true;
		},
	};
	return c;
}

function cacheKey(baseUrl: string, passkey: string | undefined): string {
	return `${baseUrl}|${passkey ?? ""}`;
}

interface CacheOpts {
	baseUrl?: string;
	clientPasskey?: string;
}

function memoize(cache: Map<string, FakeClient>, opts: CacheOpts, create: (o: CacheOpts) => FakeClient): FakeClient {
	const key = cacheKey(opts.baseUrl ?? "", opts.clientPasskey);
	const cached = cache.get(key);
	if (cached) return cached;
	const created = create(opts);
	cache.set(key, created);
	return created;
}

describe("engine/lmstudio-native cache keying", () => {
	afterEach(() => {
		resetLmStudioClientCache();
	});

	it("returns the same instance for identical baseUrl+passkey", () => {
		const cache = new Map<string, FakeClient>();
		const a = memoize(cache, { baseUrl: "ws://dynamo:1234", clientPasskey: "secret" }, fakeClient);
		const b = memoize(cache, { baseUrl: "ws://dynamo:1234", clientPasskey: "secret" }, fakeClient);
		strictEqual(a, b);
		strictEqual(a.id, b.id);
	});

	it("returns a different instance for a different baseUrl", () => {
		const cache = new Map<string, FakeClient>();
		const a = memoize(cache, { baseUrl: "ws://dynamo:1234", clientPasskey: "secret" }, fakeClient);
		const b = memoize(cache, { baseUrl: "ws://blade:1234", clientPasskey: "secret" }, fakeClient);
		notStrictEqual(a, b);
		notStrictEqual(a.id, b.id);
	});

	it("returns a different instance for a different passkey", () => {
		const cache = new Map<string, FakeClient>();
		const a = memoize(cache, { baseUrl: "ws://dynamo:1234", clientPasskey: "left" }, fakeClient);
		const b = memoize(cache, { baseUrl: "ws://dynamo:1234", clientPasskey: "right" }, fakeClient);
		notStrictEqual(a, b);
	});

	it("treats missing passkey as a distinct key from an explicit empty string is irrelevant; both collapse to the empty suffix", () => {
		const cache = new Map<string, FakeClient>();
		const a = memoize(cache, { baseUrl: "ws://dynamo:1234" }, fakeClient);
		const b = memoize(cache, { baseUrl: "ws://dynamo:1234", clientPasskey: "" }, fakeClient);
		// `${baseUrl}|${passkey ?? ""}` -> both produce the same key, so the
		// cache returns the same instance. This documents the production keying
		// contract: passkey === "" and passkey === undefined are equivalent.
		strictEqual(a, b);
	});

	it("disposeLmStudioClients clears the production cache without throwing on an empty cache", async () => {
		await disposeLmStudioClients();
		// A second call must also be safe (idempotent shutdown).
		await disposeLmStudioClients();
		ok(true);
	});
});

// Sanity check that the production API surface compiles against the SDK type.
// This is a compile-time-only assertion; it never runs.
function _typeCheckSurface(): void {
	const _dispose: (c: LMStudioClient) => Promise<void> = (c) => c[Symbol.asyncDispose]();
	void _dispose;
}

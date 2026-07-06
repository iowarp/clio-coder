import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { residentModelsSummary } from "../../src/cli/targets.js";
import {
	ensureLlamaCppResidency,
	observeLlamaCppResidency,
	parseLlamaCppResident,
	parseLlamaCppResidentModels,
	parseLlamaCppRouterProps,
	resetLlamaCppResidencyState,
} from "../../src/engine/apis/llamacpp-residency.js";
import { type ResidencyNotice, setResidencyNoticeSink } from "../../src/engine/apis/residency.js";

function modelsPayload(entries: Array<{ id: string; state: string; tags?: string[] }>): unknown {
	return {
		data: entries.map((entry) => ({
			id: entry.id,
			object: "model",
			status: { value: entry.state },
			...(entry.tags ? { tags: entry.tags } : {}),
		})),
	};
}

function fetchReturning(payload: unknown, calls: string[]): typeof fetch {
	return (async (url: unknown) => {
		calls.push(String(url));
		return { ok: true, json: async () => payload } as Response;
	}) as typeof fetch;
}

function fetchRoutes(routes: Record<string, unknown>, calls: string[]): typeof fetch {
	return (async (url: unknown) => {
		const key = String(url);
		calls.push(key);
		return { ok: true, json: async () => routes[key] ?? {} } as Response;
	}) as typeof fetch;
}

function jsonResponse(payload: unknown): Response {
	return new Response(JSON.stringify(payload), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

describe("contracts/llamacpp residency observer", () => {
	let notices: ResidencyNotice[];

	beforeEach(() => {
		resetLlamaCppResidencyState();
		notices = [];
		setResidencyNoticeSink((notice) => notices.push(notice));
	});

	afterEach(() => {
		setResidencyNoticeSink(null);
		resetLlamaCppResidencyState();
	});

	it("parses resident ids from the router models payload", () => {
		const payload = modelsPayload([
			{ id: "coder", state: "loaded" },
			{ id: "warming", state: "loading", tags: ["role:scout"] },
			{ id: "cold", state: "unloaded" },
		]);
		deepStrictEqual(parseLlamaCppResident(payload), ["coder", "warming"]);
		deepStrictEqual(parseLlamaCppResidentModels(payload), [
			{ id: "coder", tags: [] },
			{ id: "warming", tags: ["role:scout"] },
		]);
		deepStrictEqual(parseLlamaCppResident({}), []);
		deepStrictEqual(parseLlamaCppResident(null), []);
		deepStrictEqual(parseLlamaCppResident({ data: [{ id: 42 }] }), []);
	});

	it("parses router capacity from /props", () => {
		deepStrictEqual(parseLlamaCppRouterProps({ max_instances: 2 }), { maxInstances: 2 });
		deepStrictEqual(parseLlamaCppRouterProps({ max_instances: 0 }), {});
		deepStrictEqual(parseLlamaCppRouterProps({ max_instances: "2" }), {});
		deepStrictEqual(parseLlamaCppRouterProps(null), {});
	});

	it("records a swap when the router holds a different model, TTL-deduped", async () => {
		const calls: string[] = [];
		let now = 1_000;
		const input = {
			baseUrl: "http://mini:8080/v1",
			targetId: "mini",
			runtimeId: "llamacpp",
			keepModelId: "requested-model",
			fetchImpl: fetchReturning(modelsPayload([{ id: "resident-model", state: "loaded" }]), calls),
			now: () => now,
			ttlMs: 10_000,
		};

		await observeLlamaCppResidency(input);
		strictEqual(notices.length, 1);
		strictEqual(notices[0]?.kind, "swap");
		strictEqual(notices[0]?.level, "info");
		ok(notices[0]?.message.includes("resident-model"));
		ok(notices[0]?.message.includes("requested-model"));
		deepStrictEqual(calls, ["http://mini:8080/v1/models"]);

		// Within the TTL the observer neither refetches nor re-notices.
		now += 100;
		await observeLlamaCppResidency(input);
		strictEqual(calls.length, 1);
		strictEqual(notices.length, 1);
	});

	it("reports allowed co-residency as capacity info when the router allows the resident count", async () => {
		const calls: string[] = [];
		const stacked = {
			baseUrl: "http://mini:8080/v1",
			targetId: "mini",
			runtimeId: "llamacpp",
			keepModelId: "coder",
			fetchImpl: fetchRoutes(
				{
					"http://mini:8080/v1/models": modelsPayload([
						{ id: "coder", state: "loaded" },
						{ id: "scout", state: "loaded", tags: ["role:scout", "pinned:true"] },
					]),
					"http://mini:8080/props": { max_instances: 2 },
				},
				calls,
			),
		};
		await observeLlamaCppResidency(stacked);
		strictEqual(notices[0]?.kind, "co-resident");
		strictEqual(notices[0]?.level, "info");
		ok(notices[0]?.message.includes("2/2"));
		ok(notices[0]?.message.includes("scout (scout)"));
		ok(notices[0]?.message.includes("cannot verify remaining VRAM"));
		deepStrictEqual(calls, ["http://mini:8080/v1/models", "http://mini:8080/props"]);
	});

	it("reports double residency as stress when capacity is unknown or exceeded and stays silent when clean", async () => {
		const stacked = {
			baseUrl: "http://mini:8080/v1",
			targetId: "mini",
			runtimeId: "llamacpp",
			keepModelId: "coder",
			fetchImpl: fetchReturning(
				modelsPayload([
					{ id: "coder", state: "loaded" },
					{ id: "other", state: "loaded" },
				]),
				[],
			),
		};
		await observeLlamaCppResidency(stacked);
		strictEqual(notices[0]?.kind, "stress");
		strictEqual(notices[0]?.level, "warning");
		ok(notices[0]?.message.includes("cannot verify enough remaining VRAM"));

		notices.length = 0;
		resetLlamaCppResidencyState();
		await observeLlamaCppResidency({
			...stacked,
			fetchImpl: fetchReturning(modelsPayload([{ id: "coder", state: "loaded" }]), []),
		});
		strictEqual(notices.length, 0);
	});

	it("degrades fetch failures silently and never throws", async () => {
		await observeLlamaCppResidency({
			baseUrl: "http://mini:8080/v1",
			targetId: "mini",
			runtimeId: "llamacpp",
			keepModelId: "coder",
			fetchImpl: (async () => {
				throw new Error("offline");
			}) as typeof fetch,
		});
		strictEqual(notices.length, 0);
	});

	it("loads the selected model, unloads prior code residents, and restores the scout", async () => {
		const calls: Array<{ url: string; method: string; body?: unknown }> = [];
		let modelPolls = 0;
		const fetchImpl = (async (url: unknown, init?: RequestInit) => {
			const method = init?.method ?? "GET";
			const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
			calls.push({ url: String(url), method, body });
			if (String(url) === "http://mini:8080/v1/models") {
				modelPolls += 1;
				const entries =
					modelPolls === 1
						? [
								{ id: "MiniCPM5-1B-Q8_0-131K", state: "loaded", tags: ["role:scout", "pinned:true"] },
								{ id: "old-code", state: "loaded", tags: ["role:code"] },
								{ id: "new-code", state: "unloaded", tags: ["role:code"] },
							]
						: modelPolls < 4
							? [
									{ id: "MiniCPM5-1B-Q8_0-131K", state: "unloaded", tags: ["role:scout", "pinned:true"] },
									{ id: "new-code", state: "loaded", tags: ["role:code"] },
								]
							: [
									{ id: "MiniCPM5-1B-Q8_0-131K", state: "loaded", tags: ["role:scout", "pinned:true"] },
									{ id: "new-code", state: "loaded", tags: ["role:code"] },
								];
				return jsonResponse(modelsPayload(entries));
			}
			if (String(url) === "http://mini:8080/models/unload" || String(url) === "http://mini:8080/models/load") {
				return jsonResponse({ ok: true });
			}
			throw new Error(`unexpected fetch ${method} ${String(url)}`);
		}) as typeof fetch;

		await ensureLlamaCppResidency({
			baseUrl: "http://mini:8080/v1",
			targetId: "mini",
			runtimeId: "llamacpp",
			keepModelId: "new-code",
			fetchImpl,
		});

		deepStrictEqual(
			calls.filter((call) => call.method === "POST").map((call) => [call.url, call.body]),
			[
				["http://mini:8080/models/unload", { model: "old-code" }],
				["http://mini:8080/models/load", { model: "new-code" }],
				["http://mini:8080/models/load", { model: "MiniCPM5-1B-Q8_0-131K" }],
			],
		);
		ok(
			!calls.some(
				(call) => call.url === "http://mini:8080/models/unload" && JSON.stringify(call.body ?? {}).includes("MiniCPM5"),
			),
			"scout/pinned resident must never be unloaded",
		);
		strictEqual(notices[0]?.kind, "swap");
		ok(notices[0]?.message.includes("old-code"));
	});

	it("does not manage non-router llama.cpp model payloads", async () => {
		const calls: string[] = [];
		const fetchImpl = (async (url: unknown, init?: RequestInit) => {
			calls.push(`${init?.method ?? "GET"} ${String(url)}`);
			return jsonResponse({ data: [{ id: "new-code", object: "model", owned_by: "llamacpp" }] });
		}) as typeof fetch;

		await ensureLlamaCppResidency({
			baseUrl: "http://plain-llama:8080/v1",
			targetId: "plain-llama",
			runtimeId: "llamacpp",
			keepModelId: "new-code",
			fetchImpl,
		});

		deepStrictEqual(calls, ["GET http://plain-llama:8080/v1/models"]);
	});
});

describe("contracts/targets residency summary", () => {
	it("summarizes discovered model load states for the probe notes column", () => {
		strictEqual(residentModelsSummary(undefined), null);
		strictEqual(residentModelsSummary(null), null);
		strictEqual(residentModelsSummary({}), null);
		strictEqual(
			residentModelsSummary({
				a: { state: "loaded" },
				b: { state: "unloaded" },
				c: { state: "loading" },
			}),
			"resident: a, c (loading)",
		);
		strictEqual(residentModelsSummary({ a: { state: "unloaded" }, b: { state: "unknown" } }), "resident: none");
	});
});

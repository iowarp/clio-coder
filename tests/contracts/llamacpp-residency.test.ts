import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { residentModelsSummary } from "../../src/cli/targets.js";
import {
	observeLlamaCppResidency,
	parseLlamaCppResident,
	resetLlamaCppResidencyState,
} from "../../src/engine/apis/llamacpp-residency.js";
import { type ResidencyNotice, setResidencyNoticeSink } from "../../src/engine/apis/residency.js";

function modelsPayload(entries: Array<{ id: string; state: string }>): unknown {
	return { data: entries.map((entry) => ({ id: entry.id, object: "model", status: { value: entry.state } })) };
}

function fetchReturning(payload: unknown, calls: string[]): typeof fetch {
	return (async (url: unknown) => {
		calls.push(String(url));
		return { ok: true, json: async () => payload } as Response;
	}) as typeof fetch;
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
			{ id: "warming", state: "loading" },
			{ id: "cold", state: "unloaded" },
		]);
		deepStrictEqual(parseLlamaCppResident(payload), ["coder", "warming"]);
		deepStrictEqual(parseLlamaCppResident({}), []);
		deepStrictEqual(parseLlamaCppResident(null), []);
		deepStrictEqual(parseLlamaCppResident({ data: [{ id: 42 }] }), []);
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

	it("reports double residency as stress and stays silent when clean", async () => {
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

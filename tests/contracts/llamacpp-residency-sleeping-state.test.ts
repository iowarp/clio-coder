import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	ensureLlamaCppResidency,
	type LlamaCppResidencyInput,
	parseLlamaCppResident,
	resetLlamaCppResidencyState,
} from "../../src/engine/apis/llamacpp-residency.js";
import {
	type ResidencyNotice,
	setProtectedModelsProvider,
	setResidencyNoticeSink,
} from "../../src/engine/apis/residency.js";

const KEEP = "Qwen3.8-27B-IQ4_NL-262K";
const OTHER = "Qwen3.6-27B-UD-Q4_K_XL-262K";

function jsonResponse(payload: unknown, status = 200): Response {
	return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

interface RouterCall {
	url: string;
	method: string;
	body?: unknown;
}

/**
 * Router fake with `--sleep-idle-seconds` semantics, matching the retuned mini
 * node: an idle model reports `sleeping` while it keeps its slot and its
 * weights, and a load posted against it is refused with
 * `400 model is already running` rather than being treated as a no-op.
 */
function sleepingRouter(initial: Array<{ id: string; state: string; tags?: string[] }>, maxInstances?: number) {
	const states = new Map(initial.map((entry) => [entry.id, entry.state]));
	const tags = new Map(initial.map((entry) => [entry.id, entry.tags ?? []]));
	const calls: RouterCall[] = [];
	const fetchImpl = (async (url: unknown, init?: RequestInit) => {
		const href = String(url);
		const method = init?.method ?? "GET";
		const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
		calls.push({ url: href, method, body });
		if (href.endsWith("/v1/models")) {
			return jsonResponse({
				data: [...states.entries()].map(([id, state]) => ({
					id,
					object: "model",
					status: { value: state },
					tags: tags.get(id) ?? [],
				})),
			});
		}
		if (href.endsWith("/props")) {
			return jsonResponse(maxInstances === undefined ? {} : { max_instances: maxInstances });
		}
		if (href.endsWith("/models/load")) {
			const id = String(body.model);
			const state = states.get(id);
			if (state === "loaded" || state === "sleeping") {
				return jsonResponse({ error: { message: "model is already running" } }, 400);
			}
			states.set(id, "loaded");
			return jsonResponse({ ok: true });
		}
		if (href.endsWith("/models/unload")) {
			states.set(String(body.model), "unloaded");
			return jsonResponse({ ok: true });
		}
		throw new Error(`unexpected fetch ${method} ${href}`);
	}) as typeof fetch;
	const posts = () => calls.filter((call) => call.method === "POST").map((call) => call.url);
	return { fetchImpl, posts, states };
}

function ensureInput(fetchImpl: typeof fetch, keepModelId: string): LlamaCppResidencyInput {
	return {
		baseUrl: "http://mini:8080/v1",
		targetId: "mini",
		runtimeId: "llamacpp",
		keepModelId,
		managed: true,
		fetchImpl,
		withLock: async (_targetKey, fn) => fn(),
	};
}

describe("contracts/llamacpp residency sleeping state (#134)", () => {
	let notices: ResidencyNotice[];

	beforeEach(() => {
		resetLlamaCppResidencyState();
		notices = [];
		setResidencyNoticeSink((notice) => notices.push(notice));
	});

	afterEach(() => {
		setResidencyNoticeSink(null);
		setProtectedModelsProvider(null);
		resetLlamaCppResidencyState();
	});

	it("counts a sleeping model as resident", () => {
		deepStrictEqual(
			parseLlamaCppResident({
				data: [
					{ id: KEEP, status: { value: "sleeping" } },
					{ id: OTHER, status: { value: "unloaded" } },
				],
			}),
			[KEEP],
		);
	});

	it("never re-loads a sleeping keep model, because the router refuses it with a 400", async () => {
		const router = sleepingRouter([{ id: KEEP, state: "sleeping" }], 1);

		await ensureLlamaCppResidency(ensureInput(router.fetchImpl, KEEP));

		deepStrictEqual(router.posts(), [], "a resident model needs no load and no unload");
		strictEqual(router.states.get(KEEP), "sleeping");
	});

	it("does not evict a sleeping co-resident to free a slot it already holds", async () => {
		const router = sleepingRouter(
			[
				{ id: KEEP, state: "sleeping" },
				{ id: OTHER, state: "unloaded" },
			],
			1,
		);

		await ensureLlamaCppResidency(ensureInput(router.fetchImpl, KEEP));

		deepStrictEqual(router.posts(), []);
		strictEqual(router.states.get(KEEP), "sleeping");
	});

	it("still frees a slot when the sleeping resident is not the keep model", async () => {
		const router = sleepingRouter(
			[
				{ id: KEEP, state: "sleeping" },
				{ id: OTHER, state: "unloaded" },
			],
			1,
		);

		await ensureLlamaCppResidency(ensureInput(router.fetchImpl, OTHER));

		ok(
			router.posts().some((url) => url.endsWith("/models/unload")),
			"a sleeping resident still occupies the only slot and must be unloaded for a different keep model",
		);
		strictEqual(router.states.get(KEEP), "unloaded");
		strictEqual(router.states.get(OTHER), "loaded");
	});
});

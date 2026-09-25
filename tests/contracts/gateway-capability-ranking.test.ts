/**
 * The `capabilities` decision site as gateway find sees it.
 *
 * A ranking may reorder an unfiltered listing or add related entries beside a
 * query's own hits. It may never remove an entry, reorder what a query
 * matched, or change anything at all when the site is unbound or the ranker
 * has no opinion: those listings must be byte-identical to the gateway's own.
 */

import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Type } from "typebox";

import { validateSettings } from "../../src/core/config.js";
import type { ToolName } from "../../src/core/tool-names.js";
import { ToolNames } from "../../src/core/tool-names.js";
import { clioStateDir } from "../../src/core/xdg.js";
import type { ProvidersContract } from "../../src/domains/providers/index.js";
import typesafeJev from "../../src/domains/providers/runtimes/cloud/typesafe-jev.js";
import { rankCapabilities } from "../../src/domains/providers/sites/capabilities.js";
import type { DecideOptions, DecideResult, DecisionAnswer } from "../../src/domains/providers/types/inference.js";
import { createWorkerSafety } from "../../src/engine/worker-tools.js";
import {
	createGatewayTool,
	GATEWAY_RANK_MIN_LISTING,
	GATEWAY_RELATED_MAX,
	type GatewayCapabilityRanker,
} from "../../src/tools/gateway/index.js";
import { createRegistry, type ToolRegistry } from "../../src/tools/registry.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

function capabilityName(index: number): string {
	return `cap_${String(index).padStart(3, "0")}`;
}

/** A session-shaped registry with `count` gateway capabilities and an optional ranker. */
function registryWith(count: number, ranker?: GatewayCapabilityRanker): ToolRegistry {
	const registry = createRegistry({ safety: createWorkerSafety({ cwd: clioStateDir() }), autonomy: () => "yolo" });
	for (let index = 0; index < count; index += 1) {
		registry.register({
			name: capabilityName(index) as ToolName,
			placement: "gateway",
			description: index === 7 ? "Opens a pull request from a branch." : `Reads records of kind ${index}.`,
			parameters: Type.Object({}),
			baseActionClass: "read",
			run: async () => ({ kind: "ok", output: "" }),
		});
	}
	registry.register(createGatewayTool({ registry, ...(ranker ? { rankCapabilities: ranker } : {}) }));
	return registry;
}

async function find(registry: ToolRegistry, query?: string): Promise<string> {
	const verdict = await registry.invoke({
		tool: ToolNames.Gateway,
		args: { op: "find", ...(query === undefined ? {} : { query }) },
	});
	if (verdict.kind !== "ok" || verdict.result.kind !== "ok") throw new Error(JSON.stringify(verdict));
	return verdict.result.output;
}

function names(output: string, key: "capabilities" | "related" = "capabilities"): string[] {
	const payload = JSON.parse(output) as Record<string, Array<{ name: string }> | undefined>;
	return (payload[key] ?? []).map((entry) => entry.name);
}

/** A ranker that scores by a fixed map and counts how often it was asked. */
function scoring(scores: Record<string, number>) {
	const calls: Array<{ query: string; names: string[] }> = [];
	const ranker: GatewayCapabilityRanker = async (request) => {
		calls.push({ query: request.query, names: request.entries.map((entry) => entry.name) });
		return { scores, source: "jev/jev-latest" };
	};
	return { calls, ranker };
}

describe("gateway find with a capability ranker", () => {
	let env: Awaited<ReturnType<typeof isolateClioEnv>>;
	beforeEach(async () => {
		env = await isolateClioEnv("gateway-capability-ranking-");
	});
	afterEach(() => env.restore());

	const size = GATEWAY_RANK_MIN_LISTING + 5;

	it("lists byte-identically when the ranker is absent, has no opinion, or throws", async () => {
		const plain = registryWith(size);
		const silent = registryWith(size, async () => null);
		const broken = registryWith(size, async () => {
			throw new Error("down");
		});
		for (const query of [undefined, "pull request", "kind 3"]) {
			const expected = await find(plain, query);
			strictEqual(await find(silent, query), expected, `silent ${query}`);
			strictEqual(await find(broken, query), expected, `broken ${query}`);
		}
	});

	it("reorders a long unfiltered listing without dropping anything", async () => {
		const { calls, ranker } = scoring({ [capabilityName(7)]: 0.95, [capabilityName(0)]: 0.05 });
		const plainNames = names(await find(registryWith(size)));
		const output = await find(registryWith(size, ranker));
		const ranked = names(output);
		strictEqual(calls.length, 1);
		strictEqual(calls[0]?.query, "");
		deepStrictEqual([...ranked].sort(), [...plainNames].sort());
		strictEqual(ranked[0], capabilityName(7));
		ok(ranked.indexOf(capabilityName(0)) > ranked.indexOf(capabilityName(1)), "a confident no ranks after undecided");
		const payload = JSON.parse(output) as { count: number; total: number; order?: string };
		strictEqual(payload.total, plainNames.length);
		ok(payload.order?.includes("jev/jev-latest"));
	});

	it("does not ask about a short listing", async () => {
		const { calls, ranker } = scoring({});
		await find(registryWith(GATEWAY_RANK_MIN_LISTING, ranker));
		strictEqual(calls.length, 0);
	});

	it("adds related entries beside a query that missed, leaving the hits alone", async () => {
		const { calls, ranker } = scoring({
			[capabilityName(7)]: 0.9,
			[capabilityName(2)]: 0.6,
			[capabilityName(3)]: 0.4,
		});
		const registry = registryWith(10, ranker);
		const missed = await find(registry, "create pull request");
		deepStrictEqual(names(missed), []);
		deepStrictEqual(names(missed, "related"), [capabilityName(7), capabilityName(2)]);
		ok((JSON.parse(missed) as { relatedNote?: string }).relatedNote?.includes("jev/jev-latest"));
		strictEqual(calls[0]?.query, "create pull request");

		const oneHit = await find(registry, "kind 3");
		deepStrictEqual(names(oneHit), [capabilityName(3)]);
		ok(!names(oneHit, "related").includes(capabilityName(3)), "a hit is never repeated as related");
		ok(!calls.at(-1)?.names.includes(capabilityName(3)), "hits are not sent to the ranker");
	});

	it("caps related entries and does not ask when the query already matched enough", async () => {
		const every = Object.fromEntries(Array.from({ length: 10 }, (_, index) => [capabilityName(index), 0.9]));
		const { calls, ranker } = scoring(every);
		const registry = registryWith(10, ranker);
		strictEqual(names(await find(registry, "no such words"), "related").length, GATEWAY_RELATED_MAX);
		const before = calls.length;
		await find(registry, "records");
		strictEqual(calls.length, before);
	});
});

describe("capabilities site", () => {
	const ctx = { credentialsPresent: new Set<string>(), httpTimeoutMs: 5000 };
	const entries = [
		{ name: "mcp_gh__create_pr", description: "Opens a pull request." },
		{ name: "mcp_gh__list_issues", description: "Lists issues." },
	];

	function input(bound: boolean, reply: (ids: string[]) => Record<string, DecisionAnswer>) {
		const calls: Array<{ state: Record<string, unknown>; ids: string[] }> = [];
		const runtime = {
			...typesafeJev,
			async decide(_target: unknown, opts: DecideOptions): Promise<DecideResult> {
				const ids = Object.keys(opts.questions);
				calls.push({ state: opts.state as Record<string, unknown>, ids });
				return { model: "jev-1.13.0", answers: reply(ids) };
			},
		};
		const providers = {
			getTarget: () => ({ id: "jev", runtime: "typesafe-jev", defaultModel: "jev-latest" }),
			getRuntime: () => runtime,
		} as unknown as ProvidersContract;
		const settings = validateSettings({
			targets: [{ id: "jev", runtime: "typesafe-jev", defaultModel: "jev-latest" }],
			fleet: {
				profiles: { "system-one": { target: "jev", model: "jev-latest" } },
				decisionProfiles: bound ? { capabilities: "system-one" } : {},
			},
		}).settings;
		return { calls, value: { settings, providers, ctx } };
	}

	it("asks nothing when unbound", async () => {
		const { calls, value } = input(false, () => ({}));
		strictEqual(await rankCapabilities(value, { query: "open a PR", task: "ship it" }, entries), null);
		strictEqual(calls.length, 0);
	});

	it("scores the decided entries against the query, with the task as context", async () => {
		const { calls, value } = input(true, () => ({
			mcp_gh__create_pr: { type: "noul", noul: 0.93 },
			mcp_gh__list_issues: { type: "noul", noul: 0.52 },
		}));
		const ranking = await rankCapabilities(value, { query: "open a PR", task: "ship it" }, entries);
		deepStrictEqual(ranking, { scores: { mcp_gh__create_pr: 0.93 }, source: "jev/jev-latest" });
		deepStrictEqual(Object.keys(calls[0]?.state ?? {}), ["need", "task", "capabilities"]);
		strictEqual(calls[0]?.state.need, "open a PR");
	});

	it("uses the task as the need for an unfiltered listing, and returns null when nothing was decided", async () => {
		const { calls, value } = input(true, (ids) => Object.fromEntries(ids.map((id) => [id, { type: "noul", noul: 0.5 }])));
		strictEqual(await rankCapabilities(value, { query: "", task: "ship it" }, entries), null);
		deepStrictEqual(calls[0]?.state, {
			need: "ship it",
			capabilities: { mcp_gh__create_pr: "Opens a pull request.", mcp_gh__list_issues: "Lists issues." },
		});
	});
});

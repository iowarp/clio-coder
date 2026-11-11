import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { STORE_REPLACES_ARG, storeGrantBoundaries, storeProjectDir } from "../../src/core/store-paths.js";
import { ToolNames } from "../../src/core/tool-names.js";
import type { DispatchRequest } from "../../src/domains/dispatch/contract.js";
import { isDispatchIntent, normalizeDispatchIntent } from "../../src/domains/dispatch/intent.js";
import { confineGrantOnlyWriters, writeRootsOverlap } from "../../src/domains/dispatch/parallel-writers.js";
import { classify } from "../../src/domains/safety/action-classifier.js";
import { isSubset, WORKSPACE_SCOPE } from "../../src/domains/safety/scope.js";
import { openStoreBackend } from "../../src/domains/store/index.js";
import { dispatchRequestsFromArgs } from "../../src/tools/dispatch-arguments.js";
import { createStoreTool, storeAdmissionFacts } from "../../src/tools/store/store-tool.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

async function withWorkspace(fn: (root: string) => Promise<void>): Promise<void> {
	const env = await isolateClioEnv("clio-coder-store-grants-");
	try {
		const root = join(env.dir, "workspace");
		mkdirSync(join(root, "out"), { recursive: true });
		writeFileSync(join(root, "out", "summary.csv"), "a,b\n1,2\n");
		await fn(root);
	} finally {
		env.restore();
	}
}

describe("store tag grants", () => {
	it("a worker scope holding granted tag directories stays a subset of the workspace scope", () =>
		withWorkspace(async (root) => {
			const previous = process.cwd();
			process.chdir(root);
			try {
				const worker = {
					...WORKSPACE_SCOPE,
					allowedWriteRoots: [`${join(root, "out")}/`, ...storeGrantBoundaries(root, ["results"])],
				};
				strictEqual(isSubset(worker, WORKSPACE_SCOPE), true);
				strictEqual(storeGrantBoundaries(root, ["results"])[0]?.startsWith(storeProjectDir(root)), true);
			} finally {
				process.chdir(previous);
			}
		}));

	it("puts into a granted tag as the worker and refuses an ungranted tag", () =>
		withWorkspace(async (root) => {
			await createStoreTool({ getCwd: () => root, writable: true }).run({ op: "create", tag: "results" });
			await createStoreTool({ getCwd: () => root, writable: true }).run({ op: "create", tag: "other" });
			const tool = createStoreTool({
				getCwd: () => root,
				writable: false,
				grant: { tags: ["results"], dispatchRunId: "run-1" },
			});
			strictEqual((await tool.run({ op: "put", tag: "results", path: "out/summary.csv" })).kind, "ok");
			const refused = await tool.run({ op: "put", tag: "other", path: "out/summary.csv" });
			strictEqual(refused.kind, "error");
			match(String((refused as { message?: unknown }).message), /no grant for tag 'other'/);
			const created = await tool.run({ op: "create", tag: "fresh" });
			strictEqual(created.kind, "error");
			match(String((created as { message?: unknown }).message), /can read the store but not write/);
		}));

	it("reads tags a model sent as a JSON array string (M-40 3e)", () => {
		const options = { auto: { approvedAuthorities: ["read-only" as const], authorityBasis: "yolo-policy" as const } };
		const parsed = dispatchRequestsFromArgs(
			{
				tasks: [
					{ agent: "coder", task: "t", tags: '["fleet"]' },
					{ agent: "coder", task: "u", tags: "fleet" },
					// The schema validator coerces the JSON string into a one-element array before parsing.
					{ agent: "coder", task: "v", tags: ['["fleet", "notes"]'] },
				],
			},
			options,
		);
		ok(parsed.ok, JSON.stringify(parsed));
		deepStrictEqual(
			parsed.requests.map((request) => request.storeTags),
			[["fleet"], ["fleet"], ["fleet", "notes"]],
		);
	});

	it("admits a put over an existing clio-core blob as destructive once admission has stat it", () =>
		withWorkspace(async (root) => {
			const local = await openStoreBackend(root);
			const openBackend = async () => ({ ...local, kind: "clio-core" as const });
			const main = createStoreTool({ getCwd: () => root, writable: true, openBackend });
			await main.run({ op: "create", tag: "results" });
			const put = { op: "put", tag: "results", path: "out/summary.csv" };
			const fresh = await storeAdmissionFacts(put, root, openBackend);
			strictEqual(classify({ tool: ToolNames.Store, args: fresh }).actionClass, "write");
			strictEqual((await main.run(fresh)).kind, "ok");
			const replacing = await storeAdmissionFacts({ ...put, [STORE_REPLACES_ARG]: false }, root, openBackend);
			deepStrictEqual(classify({ tool: ToolNames.Store, args: replacing }), {
				actionClass: "destructive",
				reasons: ["store-replace: results:summary.csv"],
			});
			strictEqual((await main.run(replacing)).kind, "ok");
			// A replace admission did not see (a blob created after it) is still refused.
			const unseen = await main.run(put);
			strictEqual(unseen.kind, "error");
			match(String((unseen as { message?: unknown }).message), /already exists on the clio-core backend/);
		}));

	it("parallel writers granted the same tag do not overlap", () =>
		withWorkspace(async (root) => {
			const store = storeGrantBoundaries(root, ["results"]);
			strictEqual(writeRootsOverlap([`${join(root, "a")}/`, ...store], [`${join(root, "b")}/`, ...store]), false);
			strictEqual(writeRootsOverlap([`${join(root, "a")}/`], [`${join(root, "a", "x")}/`]), true);
		}));

	it("parallel writers holding only a grant are confined to their store directories (M-40 F13)", () =>
		withWorkspace(async (root) => {
			const specs = [{ id: "coder", capabilityClass: "workspace-edit" }] as never;
			const normalized = normalizeDispatchIntent({ read_roots: ["src/"] }, new Map());
			ok(normalized.ok);
			const base = { agentId: "coder", task: "put results", cwd: root, storeTags: ["results"] };
			const requests = [{ ...base }, { ...base, intent: normalized.intent }] as unknown as DispatchRequest[];
			strictEqual(confineGrantOnlyWriters(requests, specs), true);
			const store = storeGrantBoundaries(root, ["results"]);
			deepStrictEqual(requests[0]?.writeRoots, store);
			deepStrictEqual(requests[1]?.intent?.writeRoots, [...store].sort());
			strictEqual(isDispatchIntent(requests[1]?.intent), true);
			const mixed = [{ ...base }, { agentId: "coder", task: "edit", cwd: root }] as unknown as DispatchRequest[];
			strictEqual(confineGrantOnlyWriters(mixed, specs), false);
			strictEqual(mixed[0]?.writeRoots, undefined);
		}));
});

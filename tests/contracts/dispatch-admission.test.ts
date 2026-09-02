import { deepStrictEqual, match, ok, rejects, strictEqual, throws } from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import type { AgentSpec } from "../../src/domains/agents/spec.js";
import {
	type AdmissionQueueRequest,
	createAdmissionQueue,
	orderAdmissionRequests,
} from "../../src/domains/dispatch/admission-queue.js";
import { assessCapabilityMismatch } from "../../src/domains/dispatch/capability-match.js";
import { isBoundedGateRolePrompt, REVIEWER_GATE_PROMPT } from "../../src/domains/dispatch/gate-role-prompts.js";
import { normalizeDispatchIntent } from "../../src/domains/dispatch/intent.js";
import { classifyDispatchIntentCompatibility } from "../../src/domains/dispatch/intent-compatibility.js";
import {
	declaredScopeReplacementNotice,
	inferredScopeDroppedPathNotice,
	resolveDispatchPathScope,
} from "../../src/domains/dispatch/path-scope.js";
import { endpointCapacityFor } from "../../src/domains/providers/endpoint-capacity.js";
import {
	EMPTY_CAPABILITIES,
	type ProvidersContract,
	type RuntimeDescriptor,
} from "../../src/domains/providers/index.js";
import { createDispatchTool } from "../../src/tools/dispatch.js";
import { isolateDispatchState, makeDispatchBundle, restoreDispatchState } from "../harness/dispatch.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";

function queued(id: string, priority = 0): AdmissionQueueRequest<string> {
	return {
		requestId: id,
		assignmentId: id,
		priority,
		queuedAt: 10,
		deadlineAt: 1_000,
		planId: null,
		planOrder: null,
		value: id,
	};
}

function agent(id: string, capabilityClass: AgentSpec["capabilityClass"]): AgentSpec {
	return { id, capabilityClass } as AgentSpec;
}

function capacityLimit(capacity: ReturnType<typeof endpointCapacityFor>): number {
	if (capacity === null) throw new TypeError("expected endpoint capacity");
	return capacity.limit;
}

describe("dispatch admission boundary", () => {
	beforeEach(async () => isolateDispatchState());
	afterEach(() => restoreDispatchState());

	it("refuses a pinned read-only recipe for a mutation and admits sound capability pairings", () => {
		const specs = [agent("verifier", "verification"), agent("coder", "workspace-edit")];
		const mismatch = assessCapabilityMismatch({
			agentId: "verifier",
			capabilityClass: "verification",
			task: "Fix the off-by-one bug in src/sum.ts",
			autoSelected: false,
			resultContractKind: "verifier-report",
			specs,
		});
		strictEqual(mismatch?.verdict, "refuse");
		strictEqual(mismatch?.suggestedAgentId, "coder");
		strictEqual(
			assessCapabilityMismatch({
				agentId: "coder",
				capabilityClass: "workspace-edit",
				task: "Fix the off-by-one bug in src/sum.ts",
				autoSelected: false,
				resultContractKind: "mutation-report",
				specs,
			}),
			null,
		);
	});

	it("lets a typed intent that declares no writes outrank the prose classifier for a read-only recipe", () => {
		const specs = [agent("scout", "read-only"), agent("coder", "workspace-edit")];
		const task =
			"Reconnaissance question: find every caller of shouldCompact; the fix will write the failing test first.";
		strictEqual(
			assessCapabilityMismatch({
				agentId: "scout",
				capabilityClass: "read-only",
				task,
				autoSelected: false,
				resultContractKind: "scout-report",
				specs,
			})?.verdict,
			"refuse",
		);
		strictEqual(
			assessCapabilityMismatch({
				agentId: "scout",
				capabilityClass: "read-only",
				task,
				autoSelected: false,
				resultContractKind: "scout-report",
				specs,
				intent: { writeRoots: [], expectedOutputs: [] },
			}),
			null,
		);
		strictEqual(
			assessCapabilityMismatch({
				agentId: "scout",
				capabilityClass: "read-only",
				task,
				autoSelected: false,
				resultContractKind: "scout-report",
				specs,
				intent: { writeRoots: ["src/"], expectedOutputs: [] },
			})?.verdict,
			"refuse",
		);
	});

	it("orders capacity requests deterministically and fails closed at the queue bound", async () => {
		deepStrictEqual(
			orderAdmissionRequests([queued("b"), queued("a"), queued("urgent", 1)]).map((entry) => entry.requestId),
			["urgent", "a", "b"],
		);
		const queue = createAdmissionQueue<string>({ maxSize: 1, finiteCeilingMs: 1_000, now: () => 10 });
		const first = queue.enqueue(queued("first"));
		await rejects(queue.enqueue(queued("second")), /queue full/u);
		queue.cancel("first");
		strictEqual((await first).state, "canceled");
	});

	it("uses operator capacity, then discovered capacity, then the conservative local default", () => {
		const target = { id: "local", runtime: "llamacpp", url: "http://localhost:8080/v1" };
		const runtime = { id: "llamacpp", tier: "local-native" as const };
		strictEqual(
			capacityLimit(
				endpointCapacityFor({ target: { ...target, maxConcurrentRequests: 3 }, runtime, discoveredSlots: 2 }, {}),
			),
			3,
		);
		strictEqual(capacityLimit(endpointCapacityFor({ target, runtime, discoveredSlots: 2 }, {})), 2);
		strictEqual(capacityLimit(endpointCapacityFor({ target, runtime }, {})), 1);
	});

	it("reads a dot scope entry as the repository root instead of refusing the declaration", () => {
		// Local models write read_roots: ["."] to say "the whole repository" and
		// then spend a round on the rejection; the root is what an empty scope
		// already means, so the entry is dropped rather than refused. An output
		// path still has to name a file.
		const scoped = normalizeDispatchIntent({ version: 2, read_roots: [".", "src/"], write_roots: ["./"] }, new Map());
		ok(scoped.ok);
		deepStrictEqual(scoped.intent.readRoots, ["src/"]);
		deepStrictEqual(scoped.intent.writeRoots, []);
		const output = normalizeDispatchIntent({ version: 2, expected_outputs: ["."] }, new Map());
		strictEqual(output.ok, false);
	});

	it("infers a path from a briefing that quotes an import specifier instead of refusing the dispatch", () => {
		// "./parser.js" in prose is the same repository path without the prefix;
		// a live orchestrator lost two dispatch rounds to the dot-segment refusal.
		const scope = resolveDispatchPathScope({
			task: "Make parseLine trim trailing whitespace",
			briefing: "tests/round-trip.test.ts imports ./parser.js and index.ts re-exports it",
		} as Parameters<typeof resolveDispatchPathScope>[0]);
		strictEqual(scope.source, "inferred");
		ok(scope.workingContextPaths.includes("parser.js"));
	});

	it("anchors a quoted ../ specifier that names a real file, drops one that does not, and still refuses an escape", () => {
		// Round-5 run 3: a coder briefing quoted `import { Store } from "../src/store.js"`
		// out of test/store.test.ts and admission failed the whole dispatch with
		// legacy_scope_path_malformed. Inference never sees the quote's origin, so
		// the remainder is probed against the dispatch root instead of refused.
		const root = mkdtempSync(join(tmpdir(), "clio-path-scope-"));
		try {
			mkdirSync(join(root, "src"), { recursive: true });
			writeFileSync(join(root, "src", "store.js"), "export const store = 1;\n", "utf8");
			const scope = resolveDispatchPathScope({
				cwd: root,
				task: "Make the store durable",
				briefing: 'test/store.test.ts has import { Store } from "../src/store.js" and ../src/absent.js',
			} as Parameters<typeof resolveDispatchPathScope>[0]);
			strictEqual(scope.source, "inferred");
			ok(scope.workingContextPaths.includes("src/store.js"), scope.workingContextPaths.join(","));
			ok(!scope.workingContextPaths.includes("../src/absent.js"), scope.workingContextPaths.join(","));
			deepStrictEqual(
				scope.droppedPaths.map((entry) => entry.path),
				["../src/absent.js"],
			);
			const notice = inferredScopeDroppedPathNotice(scope);
			ok(notice, "a dropped prose token is named in the scope notice");
			ok(notice.message.startsWith("[dispatch scope] "), notice.message);
			ok(notice.message.includes("../src/absent.js"), notice.message);
			throws(
				() =>
					resolveDispatchPathScope({
						cwd: root,
						task: "read src/../../etc/passwd now",
					} as Parameters<typeof resolveDispatchPathScope>[0]),
				/legacy_scope_path_malformed/u,
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("keeps typed scope entries refusing a parent segment that prose inference now anchors", () => {
		// The prose leniency stops at the request text. A declared scope entry has
		// a known root and an escape there is decidable, so it stays a refusal.
		const relevant = normalizeDispatchIntent({ version: 2, relevant_paths: ["../src/store.js"] }, new Map());
		ok(!relevant.ok);
		strictEqual(relevant.reason, "intent_path_escapes_root");
		const read = normalizeDispatchIntent({ version: 2, read_roots: ["../src/store.js"] }, new Map());
		ok(!read.ok);
		strictEqual(read.reason, "intent_path_escapes_root");
		const outputs = normalizeDispatchIntent({ version: 2, expected_outputs: ["../src/store.js"] }, new Map());
		ok(!outputs.ok);
		strictEqual(outputs.reason, "intent_path_escapes_root");
	});

	it("reports only path-looking tokens when a typed intent replaces prose inference", () => {
		const scope = resolveDispatchPathScope({
			task:
				"Fix #15 in src/compaction.ts: dead/raw > 0.5 at ratio 0.5, e.g. 4/10 lines on node v24.9 with tsc 6.0; Store.fromText and store.set stay; pin it in tests/compaction.test.ts",
			intent: {
				version: 2,
				readRoots: [],
				writeRoots: ["src/compaction.ts"],
				relevantPaths: [],
				pathProvenance: [],
				expectedOutputs: ["src/compaction.ts"],
				verification: [],
			},
		} as unknown as Parameters<typeof resolveDispatchPathScope>[0]);
		strictEqual(scope.source, "declared");
		const notice = declaredScopeReplacementNotice(scope);
		ok(notice, "the omitted test file is worth a notice");
		ok(notice.omittedPaths.includes("tests/compaction.test.ts"), notice.omittedPaths.join(","));
		for (const token of ["0.5", "4/10", "v24.9", "6.0", "e.g", "dead/raw", "Store.fromText", "store.set"]) {
			ok(!notice.omittedPaths.includes(token), `${token} is not a path`);
		}
	});

	it("reads a verification check of none as the empty declaration unless a project declared that id", () => {
		// The word every model reaches for to say "no verification". Refusing it
		// as undeclared cost a dispatch round each time; it is not a check.
		const none = normalizeDispatchIntent(
			{ version: 2, write_roots: ["src/"], verification: [{ check: "none" }] },
			new Map([["typecheck", { id: "typecheck", timeoutMs: 30_000 }]]),
		);
		ok(none.ok);
		deepStrictEqual(none.intent.verification, []);
		const declared = normalizeDispatchIntent(
			{ version: 2, verification: [{ check: "none" }] },
			new Map([["none", { id: "none", timeoutMs: 5_000 }]]),
		);
		ok(declared.ok);
		deepStrictEqual(declared.intent.verification, [{ check: "none", timeoutMs: 5_000 }]);
		const still = normalizeDispatchIntent({ version: 2, verification: [{ check: "git diff" }] }, new Map());
		strictEqual(still.ok, false);
	});

	it("probes an endpoint still at the blind slot default once when the domain starts", async () => {
		// A fresh home has no slot record, so admission bound llama.cpp targets
		// to one slot and refused a two-task batch until `targets --probe` ran.
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.targets = [
			{ id: "mini", runtime: "llama.cpp", url: "http://127.0.0.1:8080", defaultModel: "m" },
			{
				id: "mini-pinned",
				runtime: "llama.cpp",
				url: "http://127.0.0.1:8081",
				defaultModel: "m",
				maxConcurrentRequests: 2,
			},
		];
		settings.fleet.default.target = "mini";
		settings.fleet.default.model = "m";
		const runtime: RuntimeDescriptor = {
			id: "llama.cpp",
			displayName: "llama.cpp",
			kind: "http",
			tier: "local-native",
			apiFamily: "openai-completions",
			auth: "none",
			defaultCapabilities: { ...EMPTY_CAPABILITIES, chat: true, tools: true },
			synthesizeModel: () => ({ id: "m", provider: "llama.cpp" }) as never,
		};
		const stub = dispatchStubContext({ settings, runtime });
		const providers = stub.getContract<ProvidersContract>("providers");
		if (!providers) throw new Error("stub providers missing");
		const probed: Array<[string, unknown]> = [];
		const wrapped: ProvidersContract = {
			...providers,
			probeTarget: async (id, options) => {
				probed.push([id, options]);
				return providers.probeTarget(id, options);
			},
		};
		const bundle = makeDispatchBundle({
			bus: stub.bus,
			getContract: ((name: string) =>
				name === "providers" ? wrapped : stub.getContract(name)) as typeof stub.getContract,
		});
		await bundle.extension.start?.();
		try {
			deepStrictEqual(probed, [["mini", { reasoning: false }]]);
		} finally {
			await bundle.extension.stop?.();
		}
	});

	it("refuses write authority on a read-only request without widening or dropping it", () => {
		const normalized = normalizeDispatchIntent(
			{
				version: 2,
				read_roots: ["src/"],
				write_roots: ["src/generated/"],
				expected_outputs: ["src/generated/index.ts"],
				verification: [{ check: "typecheck" }],
			},
			new Map([["typecheck", { id: "typecheck", timeoutMs: 30_000 }]]),
		);
		ok(normalized.ok);
		const findings = classifyDispatchIntentCompatibility({ intent: normalized.intent, autonomy: "read-only" });
		deepStrictEqual(
			findings.filter((finding) => finding.decision === "refuse").map((finding) => finding.code),
			["intent_write_without_authority"],
		);
	});

	it("admits only coordinator-bounded ACP gate prompts under read-only authority", () => {
		strictEqual(
			isBoundedGateRolePrompt({ role: "reviewer", autonomy: "read-only", systemPrompt: REVIEWER_GATE_PROMPT }),
			true,
		);
		strictEqual(
			isBoundedGateRolePrompt({ role: "reviewer", autonomy: "auto-edit", systemPrompt: REVIEWER_GATE_PROMPT }),
			false,
		);
		strictEqual(
			isBoundedGateRolePrompt({ role: "reviewer", autonomy: "read-only", systemPrompt: "caller persona" }),
			false,
		);
	});

	it("rejects unmediated ACP autonomy narrowing before any worker starts", async () => {
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.safety.autonomy = "full-auto";
		settings.integrations.externalAgents.entries = [
			{ id: "external-reviewer", command: "mock-acp", args: [], toolGovernance: "agent-managed" },
		];
		let starts = 0;
		const bundle = makeDispatchBundle(dispatchStubContext({ settings }), {
			spawnWorker: () => {
				starts += 1;
				throw new Error("native worker must not start");
			},
			startAcpDelegationRun: () => {
				starts += 1;
				throw new Error("ACP worker must not start");
			},
		});
		await bundle.extension.start();
		try {
			const tool = createDispatchTool({
				getAgentSpecs: () => [],
				dispatch: bundle.contract,
				getAutonomy: () => "full-auto",
			});
			const result = (await tool.run({ tasks: ["build first"], review: { reviewer: "external-reviewer" } }, {})) as {
				kind: string;
				message?: string;
			};
			strictEqual(result.kind, "error");
			match(result.message ?? "", /agent-managed.*cannot enforce request autonomy narrowing/u);
			strictEqual(starts, 0);
			strictEqual(bundle.contract.listRuns().length, 0);
		} finally {
			await bundle.extension.stop?.();
		}
	});
});

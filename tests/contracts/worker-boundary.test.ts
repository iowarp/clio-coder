import { deepStrictEqual, ok, strictEqual, throws } from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { parseAgentRecipeSchema } from "../../src/domains/agents/recipe-schema.js";
import { parseCodeReport } from "../../src/domains/agents/result-contract.js";
import { normalizeAgentSpec, resolveAgentToolCompatibility } from "../../src/domains/agents/spec.js";
import {
	approvedIdentityForSpec,
	computeSettingsFingerprint,
	createBoundedEventQueue,
	verifyWorkerAttestation,
} from "../../src/domains/dispatch/worker-protocol.js";
import { mergeCapabilities } from "../../src/domains/providers/capabilities.js";
import { EMPTY_CAPABILITIES } from "../../src/domains/providers/types/capability-flags.js";
import { projectWorkerEventForStdout } from "../../src/worker/event-projection.js";
import {
	canonicalJson,
	endpointIdentityHash,
	parseBulkFrame,
	toolSignatureOf,
	WORKER_PROTOCOL_VERSION,
	workerSpecDigest,
} from "../../src/worker/protocol.js";
import { createOrderedSteerHandler } from "../../src/worker/stdin-demux.js";

function recipe() {
	return parseAgentRecipeSchema({
		id: "reviewer",
		source: "project",
		filepath: "/repo/.clio-coder/agents/reviewer.md",
		body: "# Reviewer\nVerify the change.",
		frontmatter: {
			version: 1,
			name: "Reviewer",
			description: "Checks a change.",
			tools: { required: ["read", { anyOf: ["grep", "find"] }], optional: ["verify"] },
			skills: [],
			audience: "custom",
			category: "quality",
			capabilityClass: "verification",
			latencyClass: "fast",
			projectContextTier: "bounded",
			budget: { toolCalls: 8, readReserve: 2, synthesis: true },
			resultContract: { kind: "verifier-report" },
			tags: ["review"],
		},
	});
}

describe("worker boundary", () => {
	it("parses a strict recipe and admits only a compatible tool envelope", () => {
		const spec = normalizeAgentSpec(recipe());
		strictEqual(spec.capabilityClass, "verification");
		deepStrictEqual(spec.tools, ["read", "grep", "find", "verify"]);
		deepStrictEqual(resolveAgentToolCompatibility(spec, ["read", "find"], { mediatesDispatch: true }), {
			compatible: true,
			missingRequired: [],
			lostOptional: ["verify"],
		});
		deepStrictEqual(resolveAgentToolCompatibility(spec, ["read"], { mediatesDispatch: true }), {
			compatible: false,
			missingRequired: ["anyOf(grep|find)"],
			lostOptional: ["verify"],
		});
		throws(
			() =>
				parseAgentRecipeSchema({
					...recipe(),
					frontmatter: { version: 1, forbiddenRoutingHint: "model-x" },
				} as never),
			/unknown key|is required/,
		);
	});

	it("keeps live capability probes and explicit target limits authoritative", () => {
		const defaults = { ...EMPTY_CAPABILITIES, chat: true, tools: true, contextWindow: 8_192 };
		const probed = mergeCapabilities(defaults, { tools: true }, { tools: false, contextWindow: 32_768 }, null);
		strictEqual(probed.tools, true, "written model metadata may correct the probe");
		strictEqual(probed.contextWindow, 32_768, "the served window remains live authority");
		strictEqual(mergeCapabilities(defaults, { tools: true }, { tools: true }, { tools: false }).tools, false);
	});

	it("round-trips a typed worker result and rejects contradictory reports", () => {
		const report = {
			passed: true,
			exitCode: 0,
			checks: [{ name: "typecheck", passed: true, evidence: "clean" }],
			artifactPaths: ["src/index.ts"],
			outputExcerpt: "ok",
		};
		deepStrictEqual(parseCodeReport(`\`\`\`json\n${JSON.stringify(report)}\n\`\`\``), report);
		strictEqual(parseCodeReport(JSON.stringify({ ...report, exitCode: 1 })), null);
	});

	it("binds transport admission to the entire approved worker identity", () => {
		const workerSpec = {
			specVersion: 5,
			settingsFingerprint: "settings-digest",
			runtimeId: "openai",
			wireModelId: "gpt-5",
			target: { id: "frontier", url: "https://api.example/v1/" },
			allowedTools: ["read", "verify"],
		};
		const approved = approvedIdentityForSpec(workerSpec);
		const attestation = { protocolVersion: WORKER_PROTOCOL_VERSION, ...approved };
		deepStrictEqual(verifyWorkerAttestation(attestation as never, approved), { ok: true });
		const drift = verifyWorkerAttestation({ ...attestation, toolSignature: "changed" } as never, approved);
		strictEqual(drift.ok, false);
	});

	it("emits canonical hash domains and normalizes released event ids at the wire read boundary", () => {
		const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");
		const settings = { version: 2, chat: { target: "local" } };
		const spec = { specVersion: 5, agentId: "coder" };
		deepStrictEqual(parseBulkFrame('{"type":"clio_tool_finish","payload":{"tool":"read","outcome":"ok"}}'), {
			ok: true,
			value: { type: "clio_coder_tool_finish", payload: { tool: "read", outcome: "ok" } },
		});
		strictEqual(computeSettingsFingerprint(settings), sha256(`clio-coder.settings:${canonicalJson(settings)}`));
		strictEqual(workerSpecDigest(spec), sha256(`clio-coder.workerSpec:${canonicalJson(spec)}`));
		strictEqual(toolSignatureOf(["write", "read"]), sha256("clio-coder.tools:read,write"));
		strictEqual(endpointIdentityHash(undefined), sha256("clio-coder.endpoint:none"));
		strictEqual(endpointIdentityHash("https://example.test/v1/"), sha256("clio-coder.endpoint:https://example.test:/v1"));
	});

	it("projects incremental events and preserves terminal evidence under backpressure", () => {
		const update = {
			type: "message_update",
			message: { role: "assistant", content: [{ type: "text", text: "cumulative" }] },
			assistantMessageEvent: { type: "text_delta", delta: "tail", partial: { role: "assistant" } },
		};
		deepStrictEqual(projectWorkerEventForStdout(update as never), {
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: "tail" },
		});
		const queue = createBoundedEventQueue(2);
		queue.push({ type: "message_update", delta: "old" });
		queue.push({ type: "message_end", message: { content: "sealed result" } });
		queue.push({ type: "message_update", delta: "new" });
		deepStrictEqual(queue.shift(), { type: "message_end", message: { content: "sealed result" } });
		strictEqual(queue.stats().droppedDisplayFrames, 1);
	});

	it("serializes live steering and acknowledges exact accepted sequences", async () => {
		const delivered: string[] = [];
		const accepted: number[] = [];
		const rejected: string[] = [];
		const handle = createOrderedSteerHandler(
			async (text) => {
				delivered.push(text);
				return text !== "refuse";
			},
			(steer) => accepted.push(steer.sequence),
			(reason) => rejected.push(reason),
		);
		await Promise.all([
			handle({ text: "first", sequence: 1 }),
			handle({ text: "refuse", sequence: 2 }),
			handle({ text: "third", sequence: 3 }),
		]);
		deepStrictEqual(delivered, ["first", "refuse", "third"]);
		deepStrictEqual(accepted, [1, 3]);
		strictEqual(rejected.length, 1);
		ok(rejected[0]?.includes("does not accept"));
	});
});

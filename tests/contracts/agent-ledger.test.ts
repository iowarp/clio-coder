/**
 * Agent ledger contract suite.
 *
 * The agent ledger is the bounded coordination surface concurrent dispatch
 * workers share. Four properties carry the whole design and each one is a
 * separate failure if it slips:
 *
 *   - Attribution is orchestrator-stamped. No worker-supplied value may reach
 *     an attribution field, and a post that arrives before the worker's
 *     announce has no admitted identity to stamp, so it is dropped.
 *   - The bounds are the costly signal. Out-of-bounds input is refused, never
 *     truncated, and the per-run cap is enforced twice: locally in the worker
 *     port for a synchronous verdict, authoritatively at append for the count
 *     the receipt seals.
 *   - The render never merges. An uncorroborated single-author finding is the
 *     one a consensus summary drops and the one a hidden-profile task turns
 *     on, so it renders labeled and standing on its own.
 *   - Nothing this feature adds may perturb what already exists: a receipt
 *     without a contribution digests to the same bytes it did before the
 *     field existed, and a spec whose allowed tools omit the ledger attests to
 *     the same tool signature.
 *
 * The two pinned hex constants below were computed against the tree before the
 * agent ledger landed. They are the "nothing moved" half of the suite; a
 * failure there means an optional field or an unconditional registration
 * changed a digest that peers on both ends of the wire compare.
 */

import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { resolvePackageRoot } from "../../src/core/package-root.js";
import { ToolNames } from "../../src/core/tool-names.js";
import { loadRecipesFromDir } from "../../src/domains/agents/registry.js";
import { routeValidationProjection } from "../../src/domains/dispatch/active-route-planner.js";
import { claimConflicts, corroboration, disputes, renderAgentLedger } from "../../src/domains/dispatch/agent-ledger.js";
import { publishAgentLedgerEntry, subscribeAgentLedger } from "../../src/domains/dispatch/agent-ledger-hub.js";
import {
	agentLedgerContribution,
	appendAgentLedgerEntry,
	closeAgentLedger,
	MAX_AGENT_LEDGER_POSTS_PER_RUN,
	openAgentLedger,
	readAgentLedger,
} from "../../src/domains/dispatch/agent-ledger-store.js";
import type { DispatchRequest } from "../../src/domains/dispatch/contract.js";
import { buildDynamicPromptMessages } from "../../src/domains/dispatch/extension.js";
import {
	COMPETE_STANCES,
	isBoundedGateRolePrompt,
	JUDGE_GATE_PROMPT,
} from "../../src/domains/dispatch/gate-role-prompts.js";
import {
	computeReceiptIntegrity,
	RECEIPT_INTEGRITY_FIELD_COVERAGE,
	RUN_RECEIPT_INTEGRITY_VERSION,
} from "../../src/domains/dispatch/receipt-integrity.js";
import type { RunLedgerContribution, RunReceiptDraft } from "../../src/domains/dispatch/types.js";
import { validateJobSpec } from "../../src/domains/dispatch/validation.js";
import { spawnWorkerProcess } from "../../src/domains/dispatch/worker-spawn.js";
import { attestedToolSignature } from "../../src/engine/worker-tools.js";
import {
	createWorkerAgentLedgerMirror,
	createWorkerAgentLedgerPort,
	WORKER_AGENT_LEDGER_POST_CAP,
} from "../../src/worker/ledger-mirror.js";
import {
	AGENT_LEDGER_CLAIM_MAX_CHARS,
	AGENT_LEDGER_EVIDENCE_MAX_CHARS,
	AGENT_LEDGER_INTENT_MAX_CHARS,
	AGENT_LEDGER_SCOPE_ENTRY_MAX_CHARS,
	AGENT_LEDGER_SCOPE_MAX_ENTRIES,
	type AgentLedgerBody,
	type AgentLedgerEntry,
	parseAgentLedgerBody,
	parseControlFrame,
	toolSignatureOf,
	type WorkerControlFrame,
} from "../../src/worker/protocol.js";
import { WORKER_RUNTIME_DESCRIPTOR_VERSION, WORKER_SPEC_VERSION } from "../../src/worker/spec-contract.js";
import { createWorkerStdinDemux } from "../../src/worker/stdin-demux.js";
import { fixtureEnvelope, fixtureReceiptDraft } from "../harness/receipt.js";
import { isolateClioEnv } from "../harness/scratch-env.js";
import { fixtureSettingsFingerprint, STUB_ANNOUNCE_SOURCE } from "../harness/worker-attestation.js";

/**
 * Integrity digest of the shared receipt fixture, computed on the tree before
 * the ledger contribution field existed. A receipt without a contribution must
 * still digest to exactly this.
 */
const PRE_LEDGER_RECEIPT_DIGEST = "e3c1a7567c5549de6446f5a185c64ca3c23b2cff3d1acc4fffd644ba06fddad6";

/**
 * Attested tool signature for `allowedTools: ["read", "grep"]`, computed on the
 * same pre-ledger tree. Registration of the ledger tool is unconditional, so
 * this value proves the registration alone did not widen an existing worker's
 * signed surface.
 */
const PRE_LEDGER_READ_GREP_SIGNATURE = "44c1383c10b9f1c5ba568f0dfdd7ecbcd9b69928ce4a9567650dab4dc235a12b";

const ATTRIBUTION_A = { runId: "run-a", assignmentId: "asg-a", agentId: "scout", nodeId: "local" } as const;
const ATTRIBUTION_B = { runId: "run-b", assignmentId: "asg-b", agentId: "scout", nodeId: "blade" } as const;

function entry(overrides: Partial<AgentLedgerEntry> & { sequence: number; body: AgentLedgerBody }): AgentLedgerEntry {
	return {
		id: `e${overrides.sequence}`,
		at: "2026-08-14T12:00:00.000Z",
		runId: "run-a",
		assignmentId: "asg-a",
		agentId: "scout",
		nodeId: "local",
		...overrides,
	};
}

function findingEntry(sequence: number, runId: string, claim: string, path?: string): AgentLedgerEntry {
	return entry({
		sequence,
		runId,
		body: path === undefined ? { kind: "finding", claim } : { kind: "finding", claim, path },
	});
}

function lineFor(rendered: string, id: string): string {
	const line = rendered.split("\n").find((candidate) => candidate.trim().startsWith(`${id} `));
	ok(line !== undefined, `rendered board has no line for ${id}:\n${rendered}`);
	return line;
}

// ---------------------------------------------------------------------------
// Case 3. Bounds are refusals, never truncations.
// ---------------------------------------------------------------------------

describe("contracts/agent-ledger body validation", () => {
	it("refuses out-of-bounds bodies rather than truncating them", () => {
		const nineScopes = Array.from({ length: AGENT_LEDGER_SCOPE_MAX_ENTRIES + 1 }, (_, index) => `src/d${index}`);
		const overScope = parseAgentLedgerBody({ kind: "claim", scope: nineScopes, intent: "stake it" });
		strictEqual(overScope.ok, false);
		ok(overScope.ok === false && overScope.reason.length > 0, "a refusal carries a reason a model can read");

		const overIntent = parseAgentLedgerBody({
			kind: "claim",
			scope: ["src/tools"],
			intent: "i".repeat(AGENT_LEDGER_INTENT_MAX_CHARS + 1),
		});
		strictEqual(overIntent.ok, false);

		const overClaim = parseAgentLedgerBody({
			kind: "finding",
			claim: "c".repeat(AGENT_LEDGER_CLAIM_MAX_CHARS + 1),
		});
		strictEqual(overClaim.ok, false);

		const overEvidence = parseAgentLedgerBody({
			kind: "review",
			target: "e3",
			passed: true,
			evidence: "e".repeat(AGENT_LEDGER_EVIDENCE_MAX_CHARS + 1),
		});
		strictEqual(overEvidence.ok, false);

		const longScopeEntry = parseAgentLedgerBody({
			kind: "claim",
			scope: ["s".repeat(AGENT_LEDGER_SCOPE_ENTRY_MAX_CHARS + 1)],
			intent: "stake it",
		});
		strictEqual(longScopeEntry.ok, false);
	});

	it("accepts input exactly at each bound and returns it unchanged", () => {
		const scope = Array.from({ length: AGENT_LEDGER_SCOPE_MAX_ENTRIES }, (_, index) => `src/d${index}`);
		const intent = "i".repeat(AGENT_LEDGER_INTENT_MAX_CHARS);
		const claimBody = parseAgentLedgerBody({ kind: "claim", scope, intent });
		ok(claimBody.ok);
		deepStrictEqual(claimBody.body, { kind: "claim", scope, intent });

		const claim = "c".repeat(AGENT_LEDGER_CLAIM_MAX_CHARS);
		const finding = parseAgentLedgerBody({ kind: "finding", claim, path: "src/a.ts", line: 12 });
		ok(finding.ok);
		deepStrictEqual(finding.body, { kind: "finding", claim, path: "src/a.ts", line: 12 });

		const evidence = "e".repeat(AGENT_LEDGER_EVIDENCE_MAX_CHARS);
		const review = parseAgentLedgerBody({ kind: "review", target: "e7", passed: false, evidence });
		ok(review.ok);
		deepStrictEqual(review.body, { kind: "review", target: "e7", passed: false, evidence });
	});

	it("closes the taxonomy and refuses malformed citations and targets", () => {
		strictEqual(parseAgentLedgerBody({ kind: "note", text: "hello" }).ok, false);
		strictEqual(parseAgentLedgerBody("claim").ok, false);
		strictEqual(parseAgentLedgerBody({ kind: "finding", claim: "x", line: 0 }).ok, false);
		strictEqual(parseAgentLedgerBody({ kind: "finding", claim: "x", line: 1.5 }).ok, false);
		strictEqual(parseAgentLedgerBody({ kind: "review", target: "not-an-id", passed: true, evidence: "x" }).ok, false);
	});
});

// ---------------------------------------------------------------------------
// Case 4. Conflicts are cross-run and advisory.
// ---------------------------------------------------------------------------

describe("contracts/agent-ledger claim conflicts", () => {
	it("stamps overlapping peer scopes and stays empty within one run", () => {
		const live = [
			entry({ sequence: 1, runId: "run-a", body: { kind: "claim", scope: ["src/tools"], intent: "tool work" } }),
			entry({ sequence: 2, runId: "run-b", body: { kind: "claim", scope: ["docs/"], intent: "docs work" } }),
		];

		const peerOverlap = claimConflicts(
			{ kind: "claim", scope: ["src/tools/ledger.ts"], intent: "add tool" },
			live,
			"run-c",
		);
		deepStrictEqual([...peerOverlap], ["e1"]);

		const ownRun = claimConflicts({ kind: "claim", scope: ["src/tools/ledger.ts"], intent: "refine" }, live, "run-a");
		deepStrictEqual([...ownRun], []);

		const disjoint = claimConflicts({ kind: "claim", scope: ["tests/contracts"], intent: "tests" }, live, "run-c");
		deepStrictEqual([...disjoint], []);

		// Only claims stake scope; a finding conflicts with nothing.
		deepStrictEqual([...claimConflicts({ kind: "finding", claim: "x", path: "src/tools/a.ts" }, live, "run-c")], []);
	});
});

// ---------------------------------------------------------------------------
// Cases 5-7. The render labels, marks, and drops whole entries.
// ---------------------------------------------------------------------------

describe("contracts/agent-ledger render", () => {
	const board: AgentLedgerEntry[] = [
		findingEntry(1, "run-a", "lock is taken twice", "src/core/state-file-lock.ts"),
		findingEntry(2, "run-b", "second reader confirms the double take", "src/core/state-file-lock.ts"),
		findingEntry(3, "run-c", "the receipt digest skips undefined fields", "src/domains/dispatch/receipt-integrity.ts"),
		findingEntry(4, "run-c", "something is off in admission, no line yet"),
	];

	it("labels an uncorroborated finding and never merges it into the corroborated one", () => {
		const report = corroboration(board);
		strictEqual(report.byEntryId.get("e1"), "corroborated");
		strictEqual(report.byEntryId.get("e2"), "corroborated");
		strictEqual(report.byEntryId.get("e3"), "uncorroborated");
		strictEqual(report.byEntryId.get("e4"), "ungrounded lead");

		const rendered = renderAgentLedger(board);
		// Every claim survives verbatim. A summary that dropped the single-author
		// finding is the exact failure the hidden-profile result names.
		for (const source of board) {
			ok(source.body.kind === "finding");
			ok(rendered.includes(source.body.claim), `claim missing from the board: ${source.body.claim}`);
		}
		match(lineFor(rendered, "e3"), /uncorroborated/);
		match(lineFor(rendered, "e1"), /corroborated/);
		match(lineFor(rendered, "e4"), /ungrounded lead/);

		// No count, no score, no consensus line.
		ok(!/\b\d+\s+(findings?|entries|agree|votes?)\b/i.test(rendered), `render emitted a count:\n${rendered}`);
		ok(!/consensus|majority|score|summary/i.test(rendered), `render emitted a merged view:\n${rendered}`);
	});

	it("marks a failed review's target as disputed where the target stands", () => {
		const withReview = [
			...board,
			entry({
				sequence: 5,
				runId: "run-b",
				body: { kind: "review", target: "e3", passed: false, evidence: "line does not exist at that path" },
			}),
		];
		deepStrictEqual([...disputes(withReview)], ["e3"]);

		const rendered = renderAgentLedger(withReview);
		match(lineFor(rendered, "e3"), /disputed/);
		ok(!/disputed/.test(lineFor(rendered, "e1")), "an unreviewed entry is not marked disputed");

		// A passing review disputes nothing.
		const passing = [
			...board,
			entry({ sequence: 6, runId: "run-b", body: { kind: "review", target: "e1", passed: true, evidence: "confirmed" } }),
		];
		deepStrictEqual([...disputes(passing)], []);
	});

	it("drops oldest entries whole under maxChars and never cuts a body", () => {
		const full = renderAgentLedger(board);
		const budget = full.length - 20;
		const trimmed = renderAgentLedger(board, { maxChars: budget });

		ok(trimmed.length <= budget, `render exceeded maxChars: ${trimmed.length} > ${budget}`);
		// The newest entry is intact; the oldest is gone whole, not clipped.
		ok(trimmed.includes("something is off in admission, no line yet"));
		ok(!trimmed.includes("e1 "), `the dropped entry left an id behind:\n${trimmed}`);
		ok(!trimmed.includes("lock is taken twice"), `the dropped entry left body text behind:\n${trimmed}`);

		// Whatever survives, survives whole: no rendered claim is a prefix of its
		// source claim.
		for (const source of board) {
			ok(source.body.kind === "finding");
			const claim = source.body.claim;
			if (!trimmed.includes(claim.slice(0, 8))) continue;
			ok(trimmed.includes(claim), `an entry was truncated mid-body:\n${trimmed}`);
		}

		// A ceiling too small for even one entry yields no partial entry at all.
		const starved = renderAgentLedger(board, { maxChars: 10 });
		for (const source of board) {
			ok(source.body.kind === "finding");
			ok(!starved.includes(source.body.claim.slice(0, 8)), `a starved render leaked body text: ${starved}`);
		}
	});
});

// ---------------------------------------------------------------------------
// Cases 1-2. The store stamps attribution and counts refusals.
// ---------------------------------------------------------------------------

describe("contracts/agent-ledger store", () => {
	let scratch: ReturnType<typeof isolateClioEnv>;

	beforeEach(() => {
		scratch = isolateClioEnv("clio-agent-ledger-store-");
	});

	afterEach(() => {
		scratch.restore();
	});

	it("stamps attribution from the admission record and ignores worker-supplied identity", async () => {
		await openAgentLedger("led-1");
		// A worker that tries to author its own attribution: every identity field
		// below is a lie the orchestrator must not carry.
		const forged = {
			kind: "finding",
			claim: "forged attribution attempt",
			path: "src/a.ts",
			runId: "run-victim",
			assignmentId: "asg-victim",
			agentId: "coder",
			nodeId: "dragon",
			id: "e99",
			sequence: 99,
		};

		const appended = await appendAgentLedgerEntry("led-1", ATTRIBUTION_A, forged);
		ok(appended.ok, "a valid finding with extra keys is admitted on its valid fields");

		const stored = readAgentLedger("led-1")?.entries ?? [];
		strictEqual(stored.length, 1);
		const only = stored[0];
		ok(only !== undefined);
		strictEqual(only.runId, ATTRIBUTION_A.runId);
		strictEqual(only.assignmentId, ATTRIBUTION_A.assignmentId);
		strictEqual(only.agentId, ATTRIBUTION_A.agentId);
		strictEqual(only.nodeId, ATTRIBUTION_A.nodeId);
		strictEqual(only.id, "e1");
		strictEqual(only.sequence, 1);
		// The stored body carries the taxonomy's fields and nothing else.
		deepStrictEqual(only.body, { kind: "finding", claim: "forged attribution attempt", path: "src/a.ts" });
		ok(!Object.hasOwn(only.body as object, "runId"), "a worker-supplied runId reached the stored body");
		ok(!Object.hasOwn(only.body as object, "nodeId"), "a worker-supplied nodeId reached the stored body");
	});

	it("stamps conflictsWith across runs at admission", async () => {
		await openAgentLedger("led-conflict");
		await appendAgentLedgerEntry("led-conflict", ATTRIBUTION_A, {
			kind: "claim",
			scope: ["src/tools"],
			intent: "own the tool surface",
		});
		const second = await appendAgentLedgerEntry("led-conflict", ATTRIBUTION_B, {
			kind: "claim",
			scope: ["src/tools/ledger.ts"],
			intent: "add the ledger tool",
		});
		ok(second.ok);
		deepStrictEqual([...(second.entry.conflictsWith ?? [])], ["e1"]);
	});

	it("refuses past the per-run cap with a typed reason and counts every refusal", async () => {
		await openAgentLedger("led-cap");
		for (let index = 0; index < 20; index += 1) {
			const result = await appendAgentLedgerEntry("led-cap", ATTRIBUTION_A, {
				kind: "finding",
				claim: `finding ${index}`,
				path: "src/a.ts",
			});
			ok(result.ok, `post ${index} within the cap was refused`);
		}

		const overCap = await appendAgentLedgerEntry("led-cap", ATTRIBUTION_A, { kind: "finding", claim: "one too many" });
		ok(overCap.ok === false);
		strictEqual(overCap.refusal, "per-run-cap");

		// A peer's budget is its own; the cap is per run, not per ledger.
		const peer = await appendAgentLedgerEntry("led-cap", ATTRIBUTION_B, { kind: "finding", claim: "peer post" });
		ok(peer.ok, "the cap is per run, not per ledger");

		const invalid = await appendAgentLedgerEntry("led-cap", ATTRIBUTION_B, { kind: "note", text: "chat" });
		ok(invalid.ok === false);
		strictEqual(invalid.refusal, "invalid-body");

		const contributionA = agentLedgerContribution("led-cap", ATTRIBUTION_A.runId);
		ok(contributionA !== null);
		strictEqual(contributionA.posted, 20);
		strictEqual(contributionA.refused, 1);
		match(contributionA.digest, /^[0-9a-f]{64}$/);

		const contributionB = agentLedgerContribution("led-cap", ATTRIBUTION_B.runId);
		ok(contributionB !== null);
		strictEqual(contributionB.posted, 1);
		strictEqual(contributionB.refused, 1);
		ok(contributionA.digest !== contributionB.digest, "two runs' contributions digest differently");
	});

	it("refuses appends to a closed ledger and counts them", async () => {
		await openAgentLedger("led-closed");
		await closeAgentLedger("led-closed");
		const refused = await appendAgentLedgerEntry("led-closed", ATTRIBUTION_A, { kind: "finding", claim: "late" });
		ok(refused.ok === false);
		strictEqual(refused.refusal, "ledger-closed");
		strictEqual(agentLedgerContribution("led-closed", ATTRIBUTION_A.runId)?.refused, 1);
	});
});

// ---------------------------------------------------------------------------
// Case 2, worker half. The port refuses the same cap synchronously.
// ---------------------------------------------------------------------------

describe("contracts/agent-ledger worker port", () => {
	function portWithLog(ledger: { id: string; sequence: number } | undefined): {
		port: ReturnType<typeof createWorkerAgentLedgerPort>;
		mirror: ReturnType<typeof createWorkerAgentLedgerMirror>;
		frames: WorkerControlFrame[];
	} {
		const frames: WorkerControlFrame[] = [];
		const mirror = createWorkerAgentLedgerMirror();
		const port = createWorkerAgentLedgerPort({
			...(ledger === undefined ? {} : { ledger }),
			mirror,
			emitControlFrame: (frame) => {
				frames.push(frame);
			},
		});
		return { port, mirror, frames };
	}

	it("refuses at the same per-run cap the orchestrator enforces, synchronously and before the wire", () => {
		const { port, frames } = portWithLog({ id: "led-1", sequence: 0 });

		for (let index = 0; index < WORKER_AGENT_LEDGER_POST_CAP; index += 1) {
			deepStrictEqual(port.post({ kind: "finding", claim: `finding ${index}` }), { ok: true });
		}
		// The worker's local cap and the orchestrator's authoritative cap are the
		// same number, or a model is refused at one boundary and counted at another.
		strictEqual(WORKER_AGENT_LEDGER_POST_CAP, MAX_AGENT_LEDGER_POSTS_PER_RUN);

		const refused = port.post({ kind: "finding", claim: "one too many" });
		ok(refused.ok === false);
		// The same token the orchestrator's append path refuses with, so the model
		// reads one vocabulary whichever side stopped it.
		strictEqual(refused.reason, "per-run-cap");
		strictEqual(frames.length, WORKER_AGENT_LEDGER_POST_CAP, "a locally refused post never reaches the control lane");

		// The shared validator refuses out-of-bounds bodies before the wire too.
		const invalid = port.post({ kind: "claim", scope: [], intent: "nothing" } as unknown as AgentLedgerBody);
		ok(invalid.ok === false);
		strictEqual(invalid.reason, "invalid-body");
		strictEqual(frames.length, WORKER_AGENT_LEDGER_POST_CAP);

		// What did reach the lane is a body and nothing else: no attribution field
		// is available for a worker to author.
		const first = frames[0];
		ok(first !== undefined && first.kind === "ledger_post");
		deepStrictEqual(Object.keys(first.body).sort(), ["claim", "kind"]);
	});

	it("answers read from the local mirror with a watermark and null without a ledger", () => {
		const { port } = portWithLog({ id: "led-1", sequence: 0 });
		const board = port.read();
		ok(board !== null);
		strictEqual(board.watermark, 0);
		deepStrictEqual([...board.entries], []);

		const solo = portWithLog(undefined);
		strictEqual(solo.port.read(), null, "a run with no ledger reads null, not an empty board");
		const refused = solo.port.post({ kind: "finding", claim: "nowhere to post" });
		ok(refused.ok === false);
		strictEqual(refused.reason, "no-ledger");
		deepStrictEqual(solo.frames, []);
	});
});

// ---------------------------------------------------------------------------
// Case 8. A pre-announce post has no admitted identity, so it is dropped.
// ---------------------------------------------------------------------------

describe("contracts/agent-ledger control lane", () => {
	it("parses a ledger_post control frame through the shared validator", () => {
		const good = parseControlFrame(
			`@clio-control/1 ${JSON.stringify({ kind: "ledger_post", body: { kind: "finding", claim: "x", path: "src/a.ts" } })}`,
		);
		ok(good.ok);
		strictEqual(good.value.kind, "ledger_post");

		const bad = parseControlFrame(
			`@clio-control/1 ${JSON.stringify({ kind: "ledger_post", body: { kind: "note", text: "chat" } })}`,
		);
		strictEqual(bad.ok, false);
	});

	it("a heartbeat frame carries no timestamp, and a legacy `at` is ignored rather than read", () => {
		const bare = parseControlFrame(`@clio-control/1 ${JSON.stringify({ kind: "heartbeat" })}`);
		ok(bare.ok);
		deepStrictEqual(bare.value, { kind: "heartbeat" });
		const legacy = parseControlFrame(`@clio-control/1 ${JSON.stringify({ kind: "heartbeat", at: 1 })}`);
		ok(legacy.ok);
		deepStrictEqual(legacy.value, { kind: "heartbeat" });
	});

	it("drops a ledger_post that arrives before announce acceptance", async () => {
		const scratch = mkdtempSync(join(tmpdir(), "clio-agent-ledger-lane-"));
		const stubEntry = join(scratch, "stub-entry.js");
		// One post before the announce and one after. Only the second has an
		// admitted identity to attribute, so only the second may be delivered.
		writeFileSync(
			stubEntry,
			`
${STUB_ANNOUNCE_SOURCE}
const readline = require("readline");
const rl = readline.createInterface({ input: process.stdin });
const post = (claim) => process.stderr.write(
	"@clio-control/1 " + JSON.stringify({ kind: "ledger_post", body: { kind: "finding", claim } }) + "\\n",
);
let sawSpec = false;
rl.on("line", (line) => {
	if (sawSpec) return;
	sawSpec = true;
	post("before announce");
	announceSpec(JSON.parse(line));
	post("after announce");
	setTimeout(() => process.exit(0), 50);
});
`,
		);
		chmodSync(stubEntry, 0o755);
		const spec = {
			specVersion: WORKER_SPEC_VERSION,
			settingsFingerprint: fixtureSettingsFingerprint(),
			systemPrompt: "",
			agentId: "scout",
			executionRole: "builder",
			task: "ledger lane",
			target: { id: "default", runtime: "openai", defaultModel: "gpt-4o" },
			runtime: { version: 2, id: "openai", kind: "http", apiFamily: "openai-completions", auth: "api-key" },
			runtimeId: "openai",
			wireModelId: "gpt-4o",
			allowedTools: ["read"],
		};
		const posted: AgentLedgerBody[] = [];
		try {
			const worker = spawnWorkerProcess(process.execPath, [stubEntry], spec as never, {
				cwd: scratch,
				onLedgerPost: (body) => posted.push(body),
			});
			const result = await worker.promise;
			strictEqual(result.exitCode, 0);
			deepStrictEqual(posted, [{ kind: "finding", claim: "after announce" }]);
			match(result.stderrTail ?? "", /dropped a ledger post/);
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	});
});

// ---------------------------------------------------------------------------
// Case 9. Deltas that land before the handler is wired are replayed, not lost.
// ---------------------------------------------------------------------------

describe("contracts/agent-ledger stdin lane", () => {
	const spec = {
		specVersion: WORKER_SPEC_VERSION,
		settingsFingerprint: fixtureSettingsFingerprint(),
		systemPrompt: "",
		agentId: "scout",
		executionRole: "builder",
		task: "ledger delta",
		target: { id: "e", runtime: "x" },
		runtime: {
			version: WORKER_RUNTIME_DESCRIPTOR_VERSION,
			id: "x",
			kind: "http",
			apiFamily: "openai-responses",
			auth: "none",
		},
		runtimeId: "x",
		wireModelId: "m",
		allowedTools: ["read"],
		budget: { toolCalls: 18, readReserve: 0, synthesis: true, hardCap: 50 },
	};

	it("buffers ledger_delta lines that precede registration and replays them in order", async () => {
		const demux = createWorkerStdinDemux();
		demux.feed(`${JSON.stringify(spec)}\n`);
		await demux.readSpec();

		const first = entry({ sequence: 1, body: { kind: "finding", claim: "first" } });
		const second = entry({ sequence: 2, body: { kind: "finding", claim: "second" } });
		demux.feed(`${JSON.stringify({ type: "ledger_delta", entries: [first] })}\n`);
		demux.feed(`${JSON.stringify({ type: "ledger_delta", entries: [second] })}\n`);

		const batches: AgentLedgerEntry[][] = [];
		demux.onLedgerDelta((entries) => batches.push([...entries]));
		deepStrictEqual(batches, [[first], [second]], "buffered deltas replay in arrival order on registration");

		const third = entry({ sequence: 3, body: { kind: "finding", claim: "third" } });
		demux.feed(`${JSON.stringify({ type: "ledger_delta", entries: [third] })}\n`);
		deepStrictEqual(batches[2], [third], "a delta after registration is delivered live");

		const droppedBefore = demux.droppedLineCount();
		demux.feed(`${JSON.stringify({ type: "ledger_delta", entries: "not-an-array" })}\n`);
		strictEqual(demux.droppedLineCount(), droppedBefore + 1, "a malformed delta is dropped, not delivered");
		strictEqual(batches.length, 3);
	});
});

// ---------------------------------------------------------------------------
// Case 10. Subscription replays the whole board; the mirror dedupes it.
// ---------------------------------------------------------------------------

describe("contracts/agent-ledger hub", () => {
	let scratch: ReturnType<typeof isolateClioEnv>;

	beforeEach(() => {
		scratch = isolateClioEnv("clio-agent-ledger-hub-");
	});

	afterEach(() => {
		scratch.restore();
	});

	it("replays the full board on subscription and keeps publishing to the author's own run", async () => {
		await openAgentLedger("led-hub");
		const first = await appendAgentLedgerEntry("led-hub", ATTRIBUTION_A, { kind: "finding", claim: "already here" });
		ok(first.ok);

		const delivered: AgentLedgerEntry[][] = [];
		const unsubscribe = subscribeAgentLedger("led-hub", ATTRIBUTION_B.runId, (entries) => {
			delivered.push([...entries]);
			return true;
		});
		try {
			// Decision 4: a late subscriber's mirror is complete regardless of when
			// the run spawned.
			strictEqual(delivered.length, 1, "subscription delivers the existing board immediately");
			deepStrictEqual(
				delivered[0]?.map((value) => value.id),
				["e1"],
			);

			const second = await appendAgentLedgerEntry("led-hub", ATTRIBUTION_B, { kind: "finding", claim: "mine" });
			ok(second.ok);
			publishAgentLedgerEntry("led-hub", second.entry);
			// The author's own run sees its attributed entry; the mirror is how a
			// worker learns the id its post was given.
			deepStrictEqual(
				delivered[1]?.map((value) => value.id),
				["e2"],
			);
		} finally {
			unsubscribe();
		}

		publishAgentLedgerEntry("led-hub", first.entry);
		strictEqual(delivered.length, 2, "an unsubscribed run receives nothing further");
	});

	it("dedupes a replayed board in the mirror the subscription feeds", async () => {
		const port = createWorkerAgentLedgerPort({
			ledger: { id: "led-hub-2", sequence: 0 },
			emitControlFrame: () => {},
		});

		await openAgentLedger("led-hub-2");
		const first = await appendAgentLedgerEntry("led-hub-2", ATTRIBUTION_A, { kind: "finding", claim: "one" });
		const second = await appendAgentLedgerEntry("led-hub-2", ATTRIBUTION_B, { kind: "finding", claim: "two" });
		ok(first.ok && second.ok);

		// A late subscriber's first batch is the whole board; the entry it then
		// publishes overlaps what the replay already carried.
		const unsubscribe = subscribeAgentLedger("led-hub-2", ATTRIBUTION_B.runId, (entries) => {
			port.acceptDelta(entries);
			return true;
		});
		try {
			publishAgentLedgerEntry("led-hub-2", second.entry);
			publishAgentLedgerEntry("led-hub-2", second.entry);
		} finally {
			unsubscribe();
		}

		const board = port.read();
		ok(board !== null);
		deepStrictEqual(
			board.entries.map((value) => value.id),
			["e1", "e2"],
			"a sequence delivered twice appears once",
		);
		strictEqual(board.watermark, 2, "the watermark is the max sequence seen, and a read says so");
	});

	it("drops an unreachable subscriber rather than retrying it", async () => {
		await openAgentLedger("led-hub-3");
		let deliveries = 0;
		const unsubscribe = subscribeAgentLedger("led-hub-3", "run-dead", () => {
			deliveries += 1;
			return false;
		});
		try {
			const appended = await appendAgentLedgerEntry("led-hub-3", ATTRIBUTION_A, { kind: "finding", claim: "post" });
			ok(appended.ok);
			publishAgentLedgerEntry("led-hub-3", appended.entry);
			publishAgentLedgerEntry("led-hub-3", appended.entry);
			strictEqual(deliveries, 1, "an unreachable worker is retired on its first refusal");
		} finally {
			unsubscribe();
		}
	});
});

// ---------------------------------------------------------------------------
// Case 11. The receipt gains an optional field and moves no existing digest.
// ---------------------------------------------------------------------------

describe("contracts/agent-ledger receipt", () => {
	it("digests a receipt without a contribution exactly as it did before the field existed", () => {
		const envelope = fixtureEnvelope();
		const draft = fixtureReceiptDraft(envelope);
		const integrity = computeReceiptIntegrity(draft, envelope);
		strictEqual(integrity.version, RUN_RECEIPT_INTEGRITY_VERSION);
		strictEqual(RUN_RECEIPT_INTEGRITY_VERSION, 15, "an optional absent field is not a version bump");
		strictEqual(integrity.digest, PRE_LEDGER_RECEIPT_DIGEST);
	});

	it("covers the contribution in integrity and digests it distinctly when present", () => {
		strictEqual(RECEIPT_INTEGRITY_FIELD_COVERAGE.ledgerContribution, true);

		const envelope = fixtureEnvelope();
		const contribution: RunLedgerContribution = {
			ledgerId: "led-1",
			posted: 3,
			refused: 1,
			digest: "a".repeat(64),
		};
		const draft: RunReceiptDraft = { ...fixtureReceiptDraft(envelope), ledgerContribution: contribution };
		const sealed = computeReceiptIntegrity(draft, envelope);
		strictEqual(sealed.version, RUN_RECEIPT_INTEGRITY_VERSION);
		ok(sealed.digest !== PRE_LEDGER_RECEIPT_DIGEST, "a sealed contribution is inside the digest");

		const tampered: RunReceiptDraft = {
			...draft,
			ledgerContribution: { ...contribution, posted: 4 },
		};
		ok(computeReceiptIntegrity(tampered, envelope).digest !== sealed.digest, "editing the contribution breaks the seal");
	});
});

// ---------------------------------------------------------------------------
// Case 12. Unconditional registration must not move an existing signature.
// ---------------------------------------------------------------------------

describe("contracts/agent-ledger tool attestation", () => {
	it("leaves the attested signature untouched for a spec whose allowed tools omit the ledger", () => {
		const signature = attestedToolSignature({ toolsSupported: true, allowedTools: ["read", "grep"] });
		strictEqual(signature, PRE_LEDGER_READ_GREP_SIGNATURE);
		strictEqual(signature, toolSignatureOf(["read", "grep"]));
	});

	it("every dispatchable builtin declares the ledger, so a ledgered run is actually offered it", () => {
		// A worker's tool surface is its recipe's declared inventory, narrowed and
		// never widened: applyToolProfile only filters, effectiveToolNames only
		// subtracts, withLedgerToolNarrowing only removes the ledger from a run
		// with no board, and admission refuses any tool the recipe did not
		// declare. No builtin declared the ledger, so no dispatched worker could
		// reach it. A live three-scout fan-out sealed an empty board: sequence 0,
		// no entries, and posted 0 in all three receipts.
		const builtinDir = join(resolvePackageRoot(), "src", "domains", "agents", "builtins");
		const recipes = loadRecipesFromDir({ dir: builtinDir, source: "builtin" });
		const missing = recipes
			.filter((entry) => entry.audience !== "internal")
			.filter((entry) => !entry.tools.includes(ToolNames.Ledger))
			.map((entry) => entry.id);
		deepStrictEqual(missing, [], "a fanned-out builtin with no ledger in its recipe can never post");
		// The one internal agent is the single-run bootstrap behind
		// `clio-coder context init`, which never runs beside a peer.
		const bootstrap = recipes.find((entry) => entry.id === "context-bootstrap");
		strictEqual(bootstrap?.tools.includes(ToolNames.Ledger), false);
	});

	it("attests consistently for a spec that includes the ledger", () => {
		const withLedger = attestedToolSignature({
			toolsSupported: true,
			allowedTools: ["read", "grep", ToolNames.Ledger],
		});
		strictEqual(withLedger, toolSignatureOf(["read", "grep", ToolNames.Ledger]));
		ok(withLedger !== PRE_LEDGER_READ_GREP_SIGNATURE, "the ledger is part of the surface it signs");
		// The registry is built with no arguments on both ends, so the same input
		// signs the same way twice.
		strictEqual(
			withLedger,
			attestedToolSignature({ toolsSupported: true, allowedTools: [ToolNames.Ledger, "grep", "read"] }),
		);
	});
});

// ---------------------------------------------------------------------------
// Case 13 (Phase 4). Identical candidates get distinct stances.
// ---------------------------------------------------------------------------

function dynamicHashOf(messages: ReadonlyArray<{ body: string }>): string {
	const text = messages.map((message) => message.body).join("\n\n");
	return createHash("sha256")
		.update(messages.length > 0 ? text : "", "utf8")
		.digest("hex");
}

describe("contracts/agent-ledger compete stances", () => {
	const base: DispatchRequest = { agentId: "coder", executionRole: "builder", task: "ship the feature" };

	it("gives two candidates distinct stance messages and distinct dynamic hashes", () => {
		const first = buildDynamicPromptMessages({ ...base, competeStance: "minimal-diff" }, { autonomy: "auto-edit" });
		const second = buildDynamicPromptMessages({ ...base, competeStance: "test-first" }, { autonomy: "auto-edit" });

		const firstStance = first.find((message) => message.id === "dispatch-compete-stance");
		const secondStance = second.find((message) => message.id === "dispatch-compete-stance");
		ok(firstStance !== undefined, "a compete candidate carries a stance message");
		ok(secondStance !== undefined);
		ok(firstStance.body !== secondStance.body, "identical agents must not receive identical postures");
		ok(firstStance.contentHash !== secondStance.contentHash);
		// dynamicHash is sha256 over the joined message bodies (extension.ts:3077),
		// so a stance that changes the body changes the per-run hash with it.
		ok(dynamicHashOf(first) !== dynamicHashOf(second), "the stance reaches dynamicHash, which is already per-run");

		// Every stance in the closed union is assignable and rendered.
		for (const stance of COMPETE_STANCES) {
			const messages = buildDynamicPromptMessages({ ...base, competeStance: stance }, { autonomy: "auto-edit" });
			ok(
				messages.some((message) => message.id === "dispatch-compete-stance"),
				`stance ${stance} renders a message`,
			);
		}

		// A request outside compete carries no stance message at all.
		const plain = buildDynamicPromptMessages(base, { autonomy: "auto-edit" });
		strictEqual(
			plain.some((message) => message.id === "dispatch-compete-stance"),
			false,
		);
	});

	/**
	 * The admission path both orchestrator-minted fields travel, end to end.
	 *
	 * They are minted the same way and validated differently, which is the part
	 * that is easy to get wrong from either side. `ledger` is stripped before
	 * validateJobSpec and put back by restore, exactly as `reservation` is,
	 * because a model must never be able to author a ledger reference.
	 * `competeStance` stays in the projected job spec and is checked against the
	 * closed union. Asserting the projection rather than validateJobSpec alone is
	 * what distinguishes "the validator rejects this key" from "this key never
	 * reaches the validator".
	 */
	it("carries ledger and competeStance through projection, validation, and restore", () => {
		const request: DispatchRequest = {
			...base,
			competeStance: "spec-literal",
			ledger: { id: "agent-ledger-1", sequence: 7 },
		};

		const projection = routeValidationProjection(request);
		// Stripped before the validator sees it; the stance is not.
		strictEqual("ledger" in projection.jobSpec, false, "an orchestrator-minted ledger never reaches validateJobSpec");
		strictEqual(projection.jobSpec.competeStance, "spec-literal");

		const validated = validateJobSpec(projection.jobSpec);
		ok(validated.ok, `admission refused a well-formed request: ${validated.ok ? "" : validated.errors.join("; ")}`);

		const restored = projection.restore(validated.spec);
		deepStrictEqual(restored.ledger, { id: "agent-ledger-1", sequence: 7 }, "restore puts the ledger back intact");
		strictEqual(restored.competeStance, "spec-literal");

		// A stance outside the closed union is refused, so the union stays closed
		// on the wire and not only in the type system.
		const bogus = validateJobSpec({ ...projection.jobSpec, competeStance: "vibes-based" });
		strictEqual(bogus.ok, false);
		ok(bogus.ok === false && bogus.errors.some((error) => error.includes("competeStance")));

		// A request with neither field still projects and validates unchanged.
		const plain = routeValidationProjection(base);
		ok(validateJobSpec(plain.jobSpec).ok);
	});

	it("keeps the judge prompt bounded after the disagreement directive lands", () => {
		match(JUDGE_GATE_PROMPT, /disagree/i);
		strictEqual(isBoundedGateRolePrompt({ role: "judge", autonomy: "read-only", systemPrompt: JUDGE_GATE_PROMPT }), true);
		strictEqual(
			isBoundedGateRolePrompt({ role: "judge", autonomy: "read-only", systemPrompt: `${JUDGE_GATE_PROMPT}\nextra` }),
			false,
		);
	});
});

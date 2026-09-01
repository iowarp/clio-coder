import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { capacityDrain, setCapacityDraining } from "../../src/domains/dispatch/capacity-lease.js";
import { compileExecutionPlan } from "../../src/domains/dispatch/execution-plan.js";
import type { ExecutionStepResult } from "../../src/domains/dispatch/execution-scheduler.js";
import { runFleetNodePreflight } from "../../src/domains/dispatch/fleet-preflight.js";
import { planFleetResume } from "../../src/domains/dispatch/fleet-run.js";
import {
	materializePendingGateDecision,
	readPendingGateDecisions,
	stagePendingGateDecision,
	verifyGateDecisionArtifact,
} from "../../src/domains/dispatch/gate-decisions.js";
import { createFleetPlacementResolver } from "../../src/domains/dispatch/placement.js";
import type { FleetRunRecord } from "../../src/domains/dispatch/state.js";
import type { WorkerTransport } from "../../src/domains/dispatch/transport.js";
import { createFleetRegistry } from "../../src/domains/scheduling/cluster.js";
import {
	claimCompeteGroup,
	cleanupCompeteGroup,
	createCandidateWorktreeMapped,
	loadCompeteGroup,
	markCompeteGroupCleanupReady,
	removeCandidateWorktreeMapped,
} from "../../src/tools/compete-worktrees.js";
import { cleanupTaskWorktree, createTaskWorktree } from "../../src/tools/task-worktree.js";
import { clearScratchClioHome, newScratchClioHome } from "../harness/scratch-env.js";

const NODES = [
	{ id: "blade", host: "blade.lan", maxWorkers: 1 },
	{ id: "mini", host: "mini.lan", maxWorkers: 1 },
];

function transport(id: string, host: string): WorkerTransport {
	return {
		kind: "ssh",
		node: { id, kind: "ssh", host },
		spawn: () => {
			throw new Error("lifecycle contract does not launch workers");
		},
	};
}

function result(stepId: string, succeeded = true, integrityValid = true): ExecutionStepResult {
	return {
		stepId,
		assignmentId: `assignment-${stepId}`,
		terminalRunId: `run-${stepId}`,
		receiptDigest: `digest-${stepId}`,
		output: `${stepId} outcome`,
		succeeded,
		integrityValid,
	};
}

function git(root: string, ...args: string[]): string {
	return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}

function initGitRepository(root: string): void {
	mkdirSync(root, { recursive: true });
	git(root, "init", "-b", "main");
	git(root, "config", "user.name", "Naming Contract");
	git(root, "config", "user.email", "naming-contract@example.invalid");
	writeFileSync(join(root, "tracked.txt"), "baseline\n", "utf8");
	git(root, "add", "tracked.txt");
	git(root, "commit", "-m", "baseline");
}

describe("fleet lifecycle boundary", () => {
	let scratch: string | null = null;
	afterEach(() => {
		if (scratch !== null) clearScratchClioHome(scratch);
		scratch = null;
	});

	it("places by durable usage and excludes a failed node on failover", () => {
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.fleet.nodes = structuredClone(NODES);
		const usage: Record<string, number> = { blade: 0, mini: 0 };
		const registry = createFleetRegistry(() => settings.fleet.nodes, {
			activeWorkers: (nodeId) => usage[nodeId] ?? 0,
		});
		const place = createFleetPlacementResolver({
			getSettings: () => settings,
			fleet: registry,
			preflightVerdict: () => ({ ok: true, reason: null }),
			transportForNode: (node) => transport(node.id, node.host),
		});
		strictEqual(place({ agentId: "coder", executionRole: "builder", task: "build" })?.node.id, "blade");
		usage.blade = 1;
		strictEqual(place({ agentId: "coder", executionRole: "builder", task: "build" })?.node.id, "mini");

		registry.recordChannelFailure("blade", "channel closed");
		strictEqual(registry.recordChannelFailure("blade", "channel closed"), "offline");
		const rerouted = place({
			agentId: "coder",
			executionRole: "builder",
			task: "retry",
			reroutes: [{ attempt: 1, fromNode: "blade", toNode: "", reason: "node classified dead" }],
		});
		strictEqual(rerouted?.node.id, "mini");
		deepStrictEqual(rerouted?.reroutes, [
			{ attempt: 1, fromNode: "blade", toNode: "mini", reason: "node classified dead" },
		]);
	});

	it("persists an operator drain and clears it explicitly", async () => {
		scratch = await newScratchClioHome("clio-fleet-lifecycle-");
		const now = Date.parse("2026-08-23T12:00:00.000Z");
		const drain = setCapacityDraining(true, { nowMs: now, ttlMs: 60_000 });
		deepStrictEqual(capacityDrain(now + 1), drain);
		strictEqual(capacityDrain(now + 60_001), null, "expired drain cannot wedge future admission");
		setCapacityDraining(true, { nowMs: now + 120_000, ttlMs: 60_000 });
		strictEqual(setCapacityDraining(false, { nowMs: now + 120_001 }), null);
		strictEqual(capacityDrain(now + 120_002), null);
	});

	it("resumes only the longest integrity-valid successful prefix", () => {
		const plan = compileExecutionPlan({
			topology: "fleet",
			rootTask: "release",
			maxWorkers: 1,
			onFailure: "stop",
			steps: [
				{ kind: "code", id: "build", commandId: "build", scope: "workspace", dependencies: [] },
				{ kind: "code", id: "verify", commandId: "verify", scope: "readonly", dependencies: ["build"] },
				{ kind: "code", id: "publish", commandId: "publish", scope: "workspace", dependencies: ["verify"] },
			],
		});
		const record: FleetRunRecord = {
			version: 1,
			id: "fleet-run-1",
			fleet: "release",
			planHash: plan.hash,
			stepIds: plan.steps.map(({ id }) => id),
			planSteps: structuredClone([...plan.steps]),
			vars: { channel: "stable" },
			startedAt: "2026-08-23T12:00:00.000Z",
			endedAt: null,
			resumedFrom: null,
			steps: [
				{ stepId: "build", result: result("build") },
				{ stepId: "verify", result: result("verify", false) },
				{ stepId: "publish", result: result("publish") },
			],
			dynamicPlans: [],
		};
		const resumed = planFleetResume(record, plan, { name: "release" }, { channel: "stable" });
		strictEqual(resumed.ok, true);
		if (resumed.ok) deepStrictEqual([...resumed.replayed.keys()], ["build"]);
		deepStrictEqual(planFleetResume(record, plan, { name: "release" }, { channel: "edge" }), {
			ok: false,
			reason: "vars",
		});
	});

	it("writes canonical gate seals and accepts released decision and pending seals", async () => {
		scratch = await newScratchClioHome("clio-gate-naming-");
		const stateDir = join(scratch, "state");
		const handle = stagePendingGateDecision(
			{
				group: "naming-contract",
				topology: "review",
				cycle: 1,
				outcome: "pass",
				subjects: [{ runId: "subject-run", digest: "a".repeat(64) }],
				createdAt: "2026-09-01T00:00:00.000Z",
			},
			{ stateDir },
		);
		if (handle.record.kind !== "decision") throw new Error("staged gate record did not contain a decision");
		const decision = handle.record.decision;
		const decisionPayload = (contract: string) => ({
			contract,
			version: decision.version,
			id: decision.id,
			group: decision.group,
			topology: decision.topology,
			cycle: decision.cycle,
			outcome: decision.outcome,
			subjects: decision.subjects.map((subject) => ({ runId: subject.runId, digest: subject.digest })),
			createdAt: decision.createdAt,
		});
		const sha256 = (value: unknown): string => createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
		strictEqual(decision.integrity.digest, sha256(decisionPayload("clio-coder.gateDecision.integrity")));

		const legacyDecision = {
			...decision,
			integrity: { algorithm: "sha256" as const, digest: sha256(decisionPayload("clio.gateDecision.integrity")) },
		};
		deepStrictEqual(verifyGateDecisionArtifact(legacyDecision), { ok: true });
		const legacyPending = {
			...handle.record,
			decision: legacyDecision,
			integrity: { ...handle.record.integrity },
		};
		const pendingPayload = {
			contract: "clio.gateDecision.pending",
			version: legacyPending.version,
			kind: legacyPending.kind,
			id: legacyPending.id,
			decision: {
				...decisionPayload("clio.gateDecision.integrity"),
				integrity: { ...legacyDecision.integrity },
			},
			createdAt: legacyPending.createdAt,
		};
		legacyPending.integrity.digest = sha256(pendingPayload);
		writeFileSync(handle.path, JSON.stringify(legacyPending, null, 2), "utf8");
		const sealedBytes = readFileSync(handle.path, "utf8");
		const recovered = readPendingGateDecisions(stateDir);
		deepStrictEqual(recovered.errors, []);
		strictEqual(recovered.records.length, 1);
		strictEqual(readFileSync(handle.path, "utf8"), sealedBytes, "legacy WAL read must not rewrite its seal");
		const recoveredHandle = recovered.records[0];
		if (recoveredHandle === undefined) throw new Error("legacy pending gate was not recovered");
		const materialized = materializePendingGateDecision(recoveredHandle);
		strictEqual(materialized.artifact.integrity.digest, legacyDecision.integrity.digest);
		deepStrictEqual(verifyGateDecisionArtifact(materialized.artifact), { ok: true });
	});

	it("creates canonical task and compete refs while retaining exact legacy cleanup ownership", async () => {
		scratch = await newScratchClioHome("clio-git-naming-");
		const root = join(scratch, "repository");
		initGitRepository(root);

		const task = createTaskWorktree(root, "naming-task");
		strictEqual(task.branch, "clio-coder/task/naming-task");
		const taskMarkerPath = `${task.path}.task-owner.json`;
		const taskMarker = JSON.parse(readFileSync(taskMarkerPath, "utf8")) as Record<string, unknown>;
		strictEqual(taskMarker.kind, "clio-coder-task-worktree");
		const legacyTaskBranch = "clio/task/naming-task";
		git(task.path, "branch", "-m", legacyTaskBranch);
		writeFileSync(
			taskMarkerPath,
			`${JSON.stringify({ ...taskMarker, kind: "clio-task-worktree", branch: legacyTaskBranch }, null, 2)}\n`,
			"utf8",
		);
		cleanupTaskWorktree({ ...task, branch: legacyTaskBranch }, true);
		strictEqual(git(root, "branch", "--list", legacyTaskBranch), "");

		const ownership = claimCompeteGroup(root, "naming-group");
		const manifestPath = join(ownership.directory, ".clio-coder-compete-owner.json");
		const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
		strictEqual(manifest.kind, "clio-coder-compete-group");
		const candidate = await createCandidateWorktreeMapped(ownership, 1, git(root, "rev-parse", "HEAD"));
		strictEqual(candidate.branch, "clio-coder/compete/naming-group/1");
		const legacyCompeteBranch = "clio/compete/naming-group/1";
		git(candidate.path, "branch", "-m", legacyCompeteBranch);
		writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, kind: "clio-compete-group" }, null, 2)}\n`, "utf8");
		const legacyOwnership = loadCompeteGroup(root, "naming-group");
		if (legacyOwnership === null) throw new Error("legacy compete ownership was not accepted");
		await removeCandidateWorktreeMapped(legacyOwnership, { ...candidate, branch: legacyCompeteBranch }, true);
		strictEqual(git(root, "branch", "--list", legacyCompeteBranch), "");
		cleanupCompeteGroup(markCompeteGroupCleanupReady(legacyOwnership));
	});

	it("emits the canonical fleet preflight protocol and accepts the released spelling", async () => {
		scratch = await newScratchClioHome("clio-preflight-naming-");
		const canonicalSsh = join(scratch, "canonical-ssh.sh");
		writeFileSync(
			canonicalSsh,
			`#!/bin/sh
case "$*" in
  *clio-coder-preflight/1*clioCoder=*) ;;
  *) exit 9 ;;
esac
printf '%s\\n' 'clio-coder-preflight/1' 'cwd=ok' 'clioCoder=custom-entry' 'state=ok' 'cpu=1' 'memkb=1' 'gpu=unknown' 'vrammb=unknown'
`,
			"utf8",
		);
		chmodSync(canonicalSsh, 0o755);
		const node = { id: "canonical", host: "canonical.invalid", clioCoderEntry: "/opt/custom-worker" };
		const canonical = await runFleetNodePreflight(node, scratch, { sshBinary: canonicalSsh });
		strictEqual(canonical.ok, true);
		deepStrictEqual(canonical.checks, {
			reachable: true,
			clioPresent: true,
			versionMatch: true,
			pathParity: true,
			stateDirWritable: true,
		});

		const legacySsh = join(scratch, "legacy-ssh.sh");
		writeFileSync(
			legacySsh,
			"#!/bin/sh\nprintf '%s\\n' 'clio-preflight/1' 'cwd=ok' 'clio=custom-entry' 'state=ok' 'cpu=1' 'memkb=1' 'gpu=unknown' 'vrammb=unknown'\n",
			"utf8",
		);
		chmodSync(legacySsh, 0o755);
		const legacy = await runFleetNodePreflight(
			{ id: "legacy", host: "legacy.invalid", clioCoderEntry: "/opt/custom-worker" },
			scratch,
			{ sshBinary: legacySsh },
		);
		strictEqual(legacy.ok, true);
		strictEqual(legacy.checks.reachable, true);
		strictEqual(legacy.checks.clioPresent, true);
	});
});

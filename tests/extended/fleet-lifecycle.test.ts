import { deepStrictEqual, rejects, strictEqual, throws } from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it, mock } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { readClioVersion } from "../../src/core/package-root.js";
import { withTelemetryContext } from "../../src/core/telemetry/context.js";
import { capacityDrain, setCapacityDraining } from "../../src/domains/dispatch/capacity-lease.js";
import { compileExecutionPlan } from "../../src/domains/dispatch/execution-plan.js";
import type { ExecutionStepResult } from "../../src/domains/dispatch/execution-scheduler.js";
import { rememberSessionFleetNode } from "../../src/domains/dispatch/fleet-placement-preference.js";
import {
	FLEET_PREFLIGHT_MAX_AGE_MS,
	fleetPreflightVerdict,
	recordFleetPreflight,
	runFleetNodePreflight,
} from "../../src/domains/dispatch/fleet-preflight.js";
import { planFleetResume } from "../../src/domains/dispatch/fleet-run.js";
import {
	gateDecisionsDirectory,
	materializePendingGateDecision,
	readPendingGateDecisions,
	stagePendingGateDecision,
	stagePendingGateOutput,
	verifyGateDecisionArtifact,
} from "../../src/domains/dispatch/gate-decisions.js";
import {
	createFleetPlacementPreviewResolver,
	createFleetPlacementResolver,
} from "../../src/domains/dispatch/placement.js";
import type { FleetRunRecord } from "../../src/domains/dispatch/state.js";
import { resolveSshTargetLifecycle, type WorkerTransport } from "../../src/domains/dispatch/transport.js";
import { createFleetRegistry } from "../../src/domains/scheduling/cluster.js";
import { openCallJournal, readCallJournal } from "../../src/domains/telemetry/call-journal.js";
import { telemetryRunDirectory } from "../../src/domains/telemetry/paths.js";
import { formatBudgetLine } from "../../src/interactive/overlays/fleet-run-approval.js";
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

	it("projects SSH residency into target lifecycle without weakening target opt-outs", () => {
		strictEqual(resolveSshTargetLifecycle(undefined, undefined), "user-managed");
		strictEqual(resolveSshTargetLifecycle("observe", "clio-coder-managed"), "user-managed");
		strictEqual(resolveSshTargetLifecycle("manage", undefined), "clio-coder-managed");
		strictEqual(resolveSshTargetLifecycle("manage", "clio-coder-managed"), "clio-coder-managed");
		strictEqual(resolveSshTargetLifecycle("manage", "user-managed"), "user-managed");
	});

	it("keeps unpinned work local and honors standing/session pins with failover exclusions", () => {
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
		strictEqual(place({ agentId: "coder", executionRole: "builder", task: "build" })?.node.id, "local");
		settings.fleet.defaultNode = "mini";
		usage.blade = 1;
		strictEqual(place({ agentId: "coder", executionRole: "builder", task: "build" })?.node.id, "mini");

		rememberSessionFleetNode("fleet-placement-contract", "blade");
		const sessionRequest = {
			agentId: "coder",
			executionRole: "builder",
			task: "build",
			ownerSessionId: "fleet-placement-contract",
		} as const;
		strictEqual(place(sessionRequest)?.node.id, "blade");
		strictEqual(place({ ...sessionRequest, node: "local" })?.node.id, "local");
		const preview = createFleetPlacementPreviewResolver({
			getSettings: () => settings,
			fleet: registry,
			preflightVerdict: () => ({ ok: true, reason: null }),
		});
		strictEqual(preview(sessionRequest).node.id, "blade");
		const previewBeforeStamp = createFleetPlacementPreviewResolver({
			getSettings: () => settings,
			getSessionId: () => "fleet-placement-contract",
			fleet: registry,
			preflightVerdict: () => ({ ok: true, reason: null }),
		});
		strictEqual(previewBeforeStamp({ agentId: "coder", executionRole: "builder", task: "build" }).node.id, "blade");
		settings.fleet.defaultNode = null;
		registry.recordChannelFailure("blade", "channel closed");
		strictEqual(registry.recordChannelFailure("blade", "channel closed"), "offline");
		const rerouted = place({
			agentId: "coder",
			executionRole: "builder",
			task: "retry",
			reroutes: [{ attempt: 1, fromNode: "blade", toNode: "", reason: "node classified dead" }],
		});
		strictEqual(rerouted?.node.id, "local");
		deepStrictEqual(rerouted?.reroutes, [
			{ attempt: 1, fromNode: "blade", toNode: "local", reason: "node classified dead" },
		]);
	});

	it("explains when a node pin names a profile in execution and preview", () => {
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.fleet.profiles["worker-luna"] = {
			target: "openai-codex",
			model: "gpt-6-luna",
			thinkingLevel: "off",
		};
		const deps = { getSettings: () => settings, fleet: undefined };
		const request = { agentId: "coder", executionRole: "builder", task: "build", node: "worker-luna" } as const;
		for (const place of [createFleetPlacementResolver(deps), createFleetPlacementPreviewResolver(deps)]) {
			throws(
				() => place(request),
				/unknown fleet node 'worker-luna'; 'worker-luna' is a fleet profile.*Select the profile target\/model/u,
			);
			throws(() => place({ ...request, node: "not-configured" }), /unknown fleet node 'not-configured'$/u);
		}
	});

	it("persists an operator drain and clears it explicitly", async () => {
		scratch = await newScratchClioHome("clio-coder-fleet-lifecycle-");
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
			cwd: "/workspace/release",
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
		};
		const resumed = planFleetResume(record, plan, { name: "release" }, { channel: "stable" }, "/workspace/release");
		strictEqual(resumed.ok, true);
		if (resumed.ok) deepStrictEqual([...resumed.replayed.keys()], ["build"]);
		deepStrictEqual(planFleetResume(record, plan, { name: "release" }, { channel: "edge" }, "/workspace/release"), {
			ok: false,
			reason: "vars",
		});
	});

	it("writes canonical gate seals and records their telemetry owner", async () => {
		scratch = await newScratchClioHome("clio-coder-gate-naming-");
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
			{ stateDir, telemetry: { sessionId: null, runId: "naming-contract", label: "main" } },
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

		const recovered = readPendingGateDecisions(stateDir);
		deepStrictEqual(recovered.errors, []);
		strictEqual(recovered.records.length, 1);
		const recoveredHandle = recovered.records[0];
		if (recoveredHandle === undefined) throw new Error("pending gate was not recovered");
		deepStrictEqual(recoveredHandle.record.telemetry, { sessionId: null, runId: "naming-contract", label: "main" });
		const materialized = await materializePendingGateDecision(recoveredHandle);
		strictEqual(materialized.artifact.integrity.digest, decision.integrity.digest);
		deepStrictEqual(verifyGateDecisionArtifact(materialized.artifact), { ok: true });
	});

	it("recovers an artifact without its event once, in its staged owner, and retains failed publications", async () => {
		scratch = await newScratchClioHome("clio-coder-gate-publication-");
		const stateDir = join(scratch, "state");
		const context = { sessionId: null, runId: "gate-publication", label: "main" } as const;
		const draft = {
			group: "publication",
			topology: "review",
			cycle: 1,
			outcome: "pass",
			subjects: [{ runId: "subject", digest: "a".repeat(64) }],
		} as const;
		const staged = withTelemetryContext(context, () =>
			stagePendingGateDecision({ ...draft, subjects: [...draft.subjects] }, { stateDir }),
		);
		if (staged.record.kind !== "decision") throw new Error("expected a decision");
		const artifact = staged.record.decision;
		writeFileSync(join(gateDecisionsDirectory(stateDir), `${artifact.id}.json`), JSON.stringify(artifact));
		const directory = telemetryRunDirectory(stateDir, context.runId);
		const writer = await openCallJournal({ directory, context, writer: { clioCoderVersion: "test", piVersion: "test" } });
		try {
			const failed = mock.method(writer, "enqueue", () => false);
			await rejects(materializePendingGateDecision(staged), /could not be enqueued/);
			strictEqual(existsSync(staged.path), true);
			strictEqual(
				(await readCallJournal(directory)).records.filter(({ record }) => record.k === "gate.decided").length,
				0,
			);
			failed.mock.restore();
		} finally {
			await writer.close();
		}
		const recovered = readPendingGateDecisions(stateDir).records[0];
		if (!recovered) throw new Error("pending gate was lost");
		await withTelemetryContext({ sessionId: "different-session", label: "main" }, async () => {
			await Promise.all([materializePendingGateDecision(recovered), materializePendingGateDecision(recovered)]);
		});
		strictEqual(existsSync(staged.path), false);
		await materializePendingGateDecision(staged);
		const rows = (await readCallJournal(directory)).records.filter(({ record }) => record.k === "gate.decided");
		strictEqual(rows.length, 1);
		deepStrictEqual(rows[0]?.record.ctx, context);
		if (rows[0]?.record.k !== "gate.decided") throw new Error("missing gate event");
		strictEqual(rows[0].record.data.decisionId, artifact.id);
		const next = stagePendingGateDecision({ ...draft, subjects: [...draft.subjects] }, { stateDir, telemetry: context });
		const reopened = await openCallJournal({
			directory,
			context,
			writer: { clioCoderVersion: "test", piVersion: "test" },
		});
		try {
			const health = reopened.health();
			const failed = mock.method(reopened, "health", () => ({ ...health, writeErrors: 1 }));
			await rejects(materializePendingGateDecision(next), /not durably written/);
			strictEqual(existsSync(next.path), true);
			failed.mock.restore();
			await materializePendingGateDecision(next);
			strictEqual(existsSync(next.path), false);
		} finally {
			await reopened.close();
		}
	});

	it("requires a stage-time owner and rejects pending records without that field", async () => {
		scratch = await newScratchClioHome("clio-coder-gate-owner-");
		const stateDir = join(scratch, "state");
		const draft = {
			group: "owner",
			topology: "review" as const,
			cycle: 1,
			outcome: "pass" as const,
			subjects: [{ runId: "subject", digest: "a".repeat(64) }],
		};
		throws(() => stagePendingGateDecision(draft, { stateDir }), /owning telemetry context at stage time/);
		throws(
			() => stagePendingGateOutput({ ...draft, deciderRunId: "reviewer", finalOutput: "{}" }, stateDir),
			/owning telemetry context at stage time/,
		);
		const explicit = { sessionId: null, runId: "owner", label: "main" } as const;
		const staged = withTelemetryContext({ sessionId: "ambient", label: "main" }, () =>
			stagePendingGateDecision(draft, { stateDir, telemetry: explicit }),
		);
		deepStrictEqual(staged.record.telemetry, explicit);
		const { telemetry: _telemetry, ...withoutOwner } = staged.record;
		writeFileSync(staged.path, JSON.stringify(withoutOwner));
		const read = readPendingGateDecisions(stateDir);
		strictEqual(read.records.length, 0);
		strictEqual(read.errors[0]?.message, "pending gate decision telemetry context invalid");
	});

	it("creates canonical task and compete refs while retaining exact legacy cleanup ownership", async () => {
		scratch = await newScratchClioHome("clio-coder-git-naming-");
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

	it("invalidates recorded eligibility when any connection fact changes", async () => {
		scratch = await newScratchClioHome("clio-coder-preflight-connection-");
		const ssh = join(scratch, "ssh");
		writeFileSync(
			ssh,
			`#!/bin/sh
printf '%s\\n' 'clio-coder-preflight/1' 'cwd=ok' 'clioCoder=${readClioVersion()}' 'workerSpecs=8 9' 'state=ok'
`,
		);
		chmodSync(ssh, 0o755);
		const node = { id: "test", host: "test.invalid" };
		const record = await runFleetNodePreflight(node, scratch, { sshBinary: ssh });
		strictEqual(fleetPreflightVerdict(node, scratch, [record]).ok, true);
		for (const patch of [
			{ user: "other" },
			{ port: 2222 },
			{ identityFile: "/other/key" },
			{ clioCoderEntry: "other worker" },
			{ clioCoderVersionCommand: "other --version" },
		]) {
			strictEqual(fleetPreflightVerdict({ ...node, ...patch }, scratch, [record]).ok, false);
		}
	});

	it("expires recorded eligibility after a day", async () => {
		scratch = await newScratchClioHome("clio-coder-preflight-age-");
		const ssh = join(scratch, "ssh");
		writeFileSync(
			ssh,
			`#!/bin/sh
printf '%s\\n' 'clio-coder-preflight/1' 'cwd=ok' 'clioCoder=${readClioVersion()}' 'workerSpecs=8 9' 'state=ok'
`,
		);
		chmodSync(ssh, 0o755);
		const node = { id: "test", host: "test.invalid" };
		const record = await runFleetNodePreflight(node, scratch, { sshBinary: ssh });
		const expired = { ...record, checkedAt: new Date(Date.now() - FLEET_PREFLIGHT_MAX_AGE_MS - 1000).toISOString() };
		strictEqual(fleetPreflightVerdict(node, scratch, [expired]).ok, false);
	});

	it("probes an absent remote state directory without creating it", async () => {
		scratch = await newScratchClioHome("clio-coder-preflight-readonly-");
		const ssh = join(scratch, "ssh");
		const remoteState = join(scratch, "absent-state");
		writeFileSync(
			ssh,
			`#!/bin/sh
for arg; do command="$arg"; done
export XDG_STATE_HOME='${remoteState}'
exec sh -c "$command"
`,
		);
		chmodSync(ssh, 0o755);
		await runFleetNodePreflight(
			{ id: "test", host: "test.invalid", clioCoderVersionCommand: `printf '${readClioVersion()}'` },
			scratch,
			{ sshBinary: ssh },
		);
		strictEqual(existsSync(remoteState), false);
	});

	it("refuses custom entries without a version probe", async () => {
		scratch = await newScratchClioHome("clio-coder-preflight-custom-");
		const ssh = join(scratch, "ssh");
		writeFileSync(ssh, '#!/bin/sh\nfor arg; do command="$arg"; done\nexec sh -c "$command"\n');
		chmodSync(ssh, 0o755);
		const record = await runFleetNodePreflight(
			{ id: "test", host: "test.invalid", clioCoderEntry: "/custom/worker" },
			scratch,
			{ sshBinary: ssh },
		);
		strictEqual(record.ok, false);
		strictEqual(record.detail?.includes("clioCoderVersionCommand"), true);
	});

	it("emits the canonical fleet preflight protocol and accepts the released spelling", async () => {
		scratch = await newScratchClioHome("clio-coder-preflight-naming-");
		const canonicalSsh = join(scratch, "canonical-ssh.sh");
		writeFileSync(
			canonicalSsh,
			`#!/bin/sh
case "$*" in
  *clio-coder-preflight/1*clioCoder=*) ;;
  *) exit 9 ;;
esac
printf '%s\\n' 'clio-coder-preflight/1' 'cwd=ok' 'clioCoder=${readClioVersion()}' 'workerSpecs=8 9' 'state=ok' 'cpu=1' 'memkb=1' 'gpu=unknown' 'vrammb=unknown'
`,
			"utf8",
		);
		chmodSync(canonicalSsh, 0o755);
		const node = {
			id: "canonical",
			host: "canonical.invalid",
			clioCoderEntry: "/opt/custom-worker",
			clioCoderVersionCommand: "/opt/custom-worker --version",
		};
		const canonical = await runFleetNodePreflight(node, scratch, { sshBinary: canonicalSsh });
		strictEqual(canonical.ok, true);
		deepStrictEqual(canonical.checks, {
			reachable: true,
			clioPresent: true,
			versionMatch: true,
			pathParity: true,
			stateDirWritable: true,
		});
		// Admission reads only the stored record, so a passing probe admits
		// nothing until it is recorded (doctor --fix).
		strictEqual(fleetPreflightVerdict(node, scratch).ok, false);
		recordFleetPreflight([canonical]);
		deepStrictEqual(fleetPreflightVerdict(node, scratch), { ok: true, reason: null });

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
		// The script Clio sends always echoes the current marker, so a reply
		// carrying only the released one did not come from that script.
		strictEqual(legacy.ok, false);
		strictEqual(legacy.checks.reachable, false);
	});

	it("formats fleet run approval budget line with shared cost formatting", () => {
		const preview = {
			budget: {
				ceilingUsd: 5,
				currentUsd: 1.25,
				playbookUsd: 2,
			},
		};
		strictEqual(
			formatBudgetLine(preview as unknown as Parameters<typeof formatBudgetLine>[0]),
			"budget: admitted under $5.00 session ceiling, $1.25 spent, playbook ceiling $2.00",
		);
		const subCent = {
			budget: {
				ceilingUsd: 5,
				currentUsd: 0.0034,
				playbookUsd: null,
			},
		};
		strictEqual(
			formatBudgetLine(subCent as unknown as Parameters<typeof formatBudgetLine>[0]),
			"budget: admitted under $5.00 session ceiling, $0.0034 spent, playbook declares no ceiling",
		);
		const zero = {
			budget: {
				ceilingUsd: 5,
				currentUsd: 0,
				playbookUsd: 1,
			},
		};
		strictEqual(
			formatBudgetLine(zero as unknown as Parameters<typeof formatBudgetLine>[0]),
			"budget: admitted under $5.00 session ceiling, $0.00 spent, playbook ceiling $1.00",
		);
	});
});

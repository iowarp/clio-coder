import assert from "node:assert/strict";
import { test } from "node:test";
import {
	accessSentence,
	approvalActions,
	BUDGET_SECONDS,
	bannerEyebrow,
	CARD_EYEBROW,
	clampText,
	decisionChips,
	decisionRows,
	decisionTone,
	deriveApprovalTimings,
	ESCALATION_SECONDS,
	formatLocations,
	gatedPreview,
	isAwaitingAnswer,
	PREVIEW_MAX_LINES,
	RESOLUTION_SUMMARY,
	resolutionSummary,
	SAFETY_POSTURE,
	safetyFacts,
	waitedSentence,
} from "../client/chat/approval.js";
import {
	FLEET_RUN_CAP,
	FLEET_STATE_LABELS,
	type FleetItemLike,
	fleetFilterStatus,
	fleetNotices,
	fleetRunDetail,
	fleetRunTitle,
	fleetSummaryLabel,
	foldFleetRuns,
	guidanceReady,
	isLiveRun,
	presentFleetFact,
	STEER_REFUSALS,
	steerOutcome,
} from "../client/chat/fleet-facts.js";
import type { Permission } from "../contracts/permissions.js";

const REQUESTED = Date.parse("2026-09-20T10:00:00.000Z");

function permission(overrides: Partial<Permission> = {}): Permission {
	return {
		id: "perm-1",
		turnId: "turn-1",
		toolCallId: "call-1",
		title: "edit",
		kind: "edit",
		requestedAt: new Date(REQUESTED).toISOString(),
		escalateAt: new Date(REQUESTED + ESCALATION_SECONDS * 1000).toISOString(),
		expiresAt: new Date(REQUESTED + BUDGET_SECONDS * 1000).toISOString(),
		status: "pending",
		canStopTurn: false,
		...overrides,
	};
}

// ---- escalation and the countdown ------------------------------------------------------------

test("escalation is derived from the clock, not from the delta, and the declared window is the promised one", () => {
	const value = permission();
	const early = deriveApprovalTimings(value, REQUESTED + 10_000);
	assert.equal(early.escalated, false);
	assert.equal(early.waitedSeconds, 10);
	assert.equal(early.remainingSeconds, BUDGET_SECONDS - 10);
	assert.equal(early.declaredEscalationSeconds, ESCALATION_SECONDS);
	assert.equal(early.expired, false);
	assert.equal(early.budgetKnown, true);

	// One millisecond past the declared window, with no `permission.escalated` delta in sight.
	const late = deriveApprovalTimings(value, REQUESTED + ESCALATION_SECONDS * 1000 + 1);
	assert.equal(late.escalated, true);
	assert.equal(bannerEyebrow(late.escalated), "APPROVAL WAITING · ESCALATED");
	assert.equal(bannerEyebrow(early.escalated), "APPROVAL NEEDED");
});

test("a server that already said escalated wins even when this clock disagrees", () => {
	const timings = deriveApprovalTimings(permission({ status: "escalated" }), REQUESTED + 1_000);
	assert.equal(timings.escalated, true);
});

test("the budget expires exactly at expiresAt and the remaining countdown never goes negative", () => {
	const value = permission();
	assert.equal(deriveApprovalTimings(value, REQUESTED + BUDGET_SECONDS * 1000 - 1).expired, false);
	const over = deriveApprovalTimings(value, REQUESTED + BUDGET_SECONDS * 1000 + 60_000);
	assert.equal(over.expired, true);
	assert.equal(over.remainingMs, 0);
	assert.equal(over.remainingSeconds, 0);
});

test("an unparsable stamp degrades rather than printing NaN", () => {
	const timings = deriveApprovalTimings(
		permission({ requestedAt: "not a time", escalateAt: "not a time", expiresAt: "not a time" }),
		REQUESTED,
	);
	assert.equal(timings.budgetKnown, false);
	assert.equal(timings.waitedMs, 0);
	assert.equal(timings.declaredEscalationSeconds, ESCALATION_SECONDS);
	const facts = safetyFacts(permission({ expiresAt: "not a time" }), undefined, timings);
	assert.ok(facts.every((fact) => !fact.includes("NaN")));
	assert.match(facts[1] ?? "", /approval budget runs out/);
});

test("the safety facts carry access, countdown, posture and wait, in that order and verbatim", () => {
	const value = permission();
	const timings = deriveApprovalTimings(value, REQUESTED + 30_000);
	const facts = safetyFacts(value, [{ path: "src/core/config.ts", line: 11 }], timings);
	assert.equal(facts.length, 4);
	assert.equal(facts[0], "edit access to src/core/config.ts:12.");
	assert.match(facts[1] ?? "", /^If unanswered, this turn stops in .+ \(at .+\)\.$/);
	assert.equal(facts[2], SAFETY_POSTURE);
	assert.equal(facts[2], "Nothing runs until you answer. The GUI never answers for you.");
	assert.equal(facts[3], "Waiting 30s.");
});

test("a permission with no locations says so rather than naming nothing", () => {
	assert.equal(accessSentence({ kind: "bash" }, undefined), "bash access to this turn.");
	assert.equal(accessSentence({ kind: "bash" }, []), "bash access to this turn.");
});

test("locations are one-based for display and the fourth onward is counted, never dropped", () => {
	assert.deepEqual(formatLocations([{ path: "a.ts", line: 0 }]), ["a.ts:1"]);
	assert.deepEqual(formatLocations([{ path: "a.ts" }, { path: "b.ts", line: null }]), ["a.ts", "b.ts"]);
	assert.deepEqual(formatLocations([1, 2, 3, 4, 5].map((n) => ({ path: `f${n}.ts` }))), [
		"f1.ts",
		"f2.ts",
		"f3.ts",
		"+2 more",
	]);
});

test("only a pending or escalated permission is still awaiting an answer", () => {
	for (const status of ["pending", "escalated"] as const) assert.ok(isAwaitingAnswer({ status }));
	for (const status of ["allowed", "rejected", "expired", "cancelled"] as const)
		assert.ok(!isAwaitingAnswer({ status }));
});

// ---- the answers -----------------------------------------------------------------------------

test("the third answer is drawn only when the agent announced it, and the affirmative is always last", () => {
	const two = approvalActions({ canStopTurn: false });
	assert.deepEqual(
		two.map((action) => action.decision),
		["reject", "allow-once"],
	);
	const three = approvalActions({ canStopTurn: true });
	assert.deepEqual(
		three.map((action) => action.decision),
		["reject", "reject-and-stop", "allow-once"],
	);
	assert.equal(three.at(-1)?.variant, "primary");
	assert.ok(three.slice(0, -1).every((action) => action.variant === "quiet"));
	assert.deepEqual(
		three.map((action) => action.keybinding),
		["reject", null, "allowOnce"],
	);
	assert.equal(CARD_EYEBROW, "APPROVAL NEEDED · ONE USE");
});

test("resolution wording keeps the difference between told no and not told no", () => {
	assert.match(RESOLUTION_SUMMARY.rejected ?? "", /was told no/);
	assert.match(RESOLUTION_SUMMARY.expired ?? "", /was not told no/);
	assert.match(RESOLUTION_SUMMARY.cancelled ?? "", /was not told no/);
	assert.equal(resolutionSummary("allowed"), "Allowed once by the operator.");
	assert.equal(resolutionSummary("something-new"), "Clio Coder recorded an outcome this GUI does not classify.");
});

// ---- the agent's own classification ----------------------------------------------------------

const DECISION = {
	tier: "workspace",
	tierLabel: "Workspace",
	title: "Edit a project file",
	semanticToken: "action",
	authorizationCopy: "You are authorizing one edit to a file in this workspace.",
	consequenceCopy: "The file changes on disk.",
	reversibilityCopy: "",
	requestedByCopy: "Clio Coder asked for it.",
	actionClass: "write",
	affectedScope: "workspace",
	reversibility: "limited",
} as const;

test("the classification is labelled from the agent's own facts and never re-derived from the tool name", () => {
	assert.deepEqual(decisionChips(DECISION), ["Workspace", "writes content", "reaches this workspace"]);
	assert.equal(decisionTone(DECISION), "warn");
	assert.equal(decisionTone({ ...DECISION, semanticToken: "accent" }), "neutral");
	assert.equal(decisionTone({ ...DECISION, semanticToken: "warning" }), "fail");
	const rows = decisionRows(DECISION);
	assert.deepEqual(
		rows.map((row) => row.term),
		["Authorization", "Consequence", "Reversibility", "Requested by"],
	);
	// An empty copy field falls back to the enum's label rather than to a blank row.
	assert.equal(rows[2]?.value, "reversible only in part");
});

test("an engine that announced no decision facts still yields a usable card", () => {
	assert.deepEqual(decisionChips(undefined), []);
	assert.deepEqual(decisionRows(undefined), []);
	assert.equal(decisionTone(undefined), "warn");
	// An unclassified enum value prints itself rather than vanishing.
	assert.deepEqual(decisionChips({ ...DECISION, actionClass: "quantum_tunnel", affectedScope: "elsewhere" }), [
		"Workspace",
		"quantum_tunnel",
		"elsewhere",
	]);
});

// ---- the concrete thing being approved ---------------------------------------------------------

test("a shell call shows its command", () => {
	const preview = gatedPreview({ title: "bash", rawInput: { command: "rm -rf build && pnpm run build" } });
	assert.equal(preview.kind, "command");
	assert.equal(preview.kind === "command" && preview.command, "rm -rf build && pnpm run build");
});

test("an edit shows the proposed replacements, a write shows the proposed contents", () => {
	const edit = gatedPreview({
		title: "edit",
		rawInput: { path: "src/a.ts", edits: [{ oldText: "one", newText: "two" }, { oldText: "three" }] },
	});
	assert.equal(edit.kind, "edits");
	if (edit.kind === "edits") {
		assert.equal(edit.path, "src/a.ts");
		assert.deepEqual(edit.edits, [
			{ oldText: "one", newText: "two" },
			{ oldText: "three", newText: "" },
		]);
		assert.match(edit.label, /not yet applied/);
	}
	const write = gatedPreview({ title: "write", rawInput: { path: "src/b.ts", content: "export const x = 1;\n" } });
	assert.equal(write.kind, "contents");
	assert.equal(write.kind === "contents" && write.contents, "export const x = 1;\n");
});

test("a write shows the path and a fetch shows the host, never a query string", () => {
	const fetched = gatedPreview({ title: "web_fetch", rawInput: { url: "https://example.test/docs?token=secret" } });
	assert.equal(fetched.kind, "host");
	if (fetched.kind === "host") {
		assert.equal(fetched.host, "example.test");
		assert.equal(fetched.url, "example.test/docs");
		assert.ok(!fetched.url.includes("secret"));
	}
	const broken = gatedPreview({ title: "web_fetch", rawInput: { url: "not a url" } });
	assert.equal(broken.kind === "host" && broken.host, "not a url");
});

test("a tool this build has never seen degrades to a readable row, never to an empty body", () => {
	const unknown = gatedPreview({ title: "teleport", rawInput: { destination: "mars" } });
	assert.equal(unknown.kind, "none");
	assert.equal(unknown.kind === "none" && unknown.note, "Clio Coder reported no reviewable input for teleport.");
	// An unrecognised tool that still reported locations shows them rather than nothing.
	const located = gatedPreview({ title: "teleport", locations: [{ path: "src/a.ts", line: 4 }] });
	assert.equal(located.kind === "path" && located.path, "src/a.ts:5");
	// And a permission with no anchored call at all says exactly that.
	const unanchored = gatedPreview(undefined);
	assert.equal(unanchored.kind, "none");
	assert.match(unanchored.kind === "none" ? unanchored.note : "", /not linked to a call/);
});

test("preview text is control-stripped and bounded so a hostile argument cannot blow up the card", () => {
	const noisy = gatedPreview({ title: "bash", rawInput: { command: "echo \u0007hi\u0000 there" } });
	assert.equal(noisy.kind === "command" && noisy.command, "echo hi there");
	const long = gatedPreview({
		title: "write",
		rawInput: { path: "a.ts", content: "x\n".repeat(PREVIEW_MAX_LINES + 50) },
	});
	assert.equal(long.kind === "contents" && long.truncated, true);
	assert.ok(long.kind === "contents" && long.contents.split("\n").length <= PREVIEW_MAX_LINES);
	const clamped = clampText("a\nb\nc", 2, 100);
	assert.deepEqual(clamped, { text: "a\nb", truncated: true });
	// Tabs and newlines survive: a command and a file body are both multi-line by nature.
	assert.deepEqual(clampText("a\n\tb", 10, 100), { text: "a\n\tb", truncated: false });
});

// ---- the fleet strip ---------------------------------------------------------------------------

let sequence = 0;
function fact(type: string, payload: Record<string, unknown>, at = "2026-09-20T10:00:00.000Z"): FleetItemLike {
	sequence += 1;
	return { id: `f${sequence}`, at, sourceSequence: sequence, fact: { type, payload } };
}

test("five events about one run fold into one row that carries every reported value", () => {
	const runs = foldFleetRuns([
		fact("fleet.enqueued", {
			runId: "r1",
			agentId: "reviewer",
			taskPreview: "Check the diff",
			node: "blade",
			attempt: 1,
		}),
		fact("fleet.started", { runId: "r1", agentId: "reviewer" }),
		fact("fleet.progress", { runId: "r1", agentId: "reviewer", progressCount: 7, truncated: true }),
		fact("fleet.completed", {
			runId: "r1",
			agentId: "reviewer",
			outcome: "succeeded",
			durationMs: 4200,
			tokenCount: 910,
		}),
	]);
	assert.equal(runs.length, 1);
	const run = runs[0];
	assert.ok(run);
	assert.equal(run.state, "done");
	assert.equal(run.agentId, "reviewer");
	assert.equal(run.taskPreview, "Check the diff");
	assert.equal(run.node, "blade");
	assert.equal(run.attempt, 1);
	assert.equal(run.progressCount, 7);
	assert.equal(run.progressTruncated, true);
	assert.equal(run.tokenCount, 910);
	assert.equal(fleetRunDetail(run), "Done · succeeded · 7+ steps · 4.2s");
	assert.equal(
		fleetRunDetail({
			...run,
			state: "progress",
			outcome: null,
			progressCount: 1,
			progressTruncated: false,
			durationMs: null,
		}),
		"Working · 1 step",
	);
	assert.equal(isLiveRun(run), false);
});

test("progress is a working run, not a phase of its own, and a failure carries its reason", () => {
	const runs = foldFleetRuns([
		fact("fleet.started", { runId: "r1", agentId: "builder" }),
		fact("fleet.progress", { runId: "r1", agentId: "builder", progressCount: 2, truncated: false }),
		fact("fleet.enqueued", { runId: "r2", agentId: "judge", taskPreview: null, node: null, attempt: null }),
		fact("fleet.failed", { runId: "r3", agentId: "worker", outcome: null, reason: "spawn refused", durationMs: 12 }),
	]);
	assert.deepEqual(
		runs.map((run) => run.state),
		["progress", "queued", "failed"],
	);
	assert.equal(FLEET_STATE_LABELS.progress, "Working");
	const [working, queued, failed] = runs;
	assert.ok(working && queued && failed);
	assert.ok(isLiveRun(working) && isLiveRun(queued) && !isLiveRun(failed));
	assert.equal(failed.outcome, "spawn refused");
	assert.equal(fleetRunTitle(queued), "No task preview was reported.");
	assert.equal(fleetSummaryLabel(runs), "Fleet · 2 running of 3");
});

test("events arriving out of order are folded in reported sequence, not in array order", () => {
	const started = fact("fleet.started", { runId: "r1", agentId: "a" });
	const completed = fact("fleet.completed", {
		runId: "r1",
		agentId: "a",
		outcome: "succeeded",
		durationMs: 5,
		tokenCount: 1,
	});
	assert.equal(foldFleetRuns([completed, started])[0]?.state, "done");
});

test("the cap drops the oldest settled run first and never a live one", () => {
	const items: FleetItemLike[] = [];
	for (let index = 0; index < FLEET_RUN_CAP + 4; index += 1) {
		const runId = `r${index}`;
		items.push(fact("fleet.enqueued", { runId, agentId: "a", taskPreview: null, node: null, attempt: null }));
		// The first six settle; everything after stays live.
		if (index < 6)
			items.push(fact("fleet.completed", { runId, agentId: "a", outcome: "succeeded", durationMs: 1, tokenCount: 1 }));
	}
	const runs = foldFleetRuns(items);
	assert.equal(runs.length, FLEET_RUN_CAP);
	assert.deepEqual(
		runs.filter((run) => !isLiveRun(run)).map((run) => run.runId),
		["r4", "r5"],
	);
	assert.equal(runs.filter(isLiveRun).length, FLEET_RUN_CAP - 2);
});

test("a run fact with no runId is skipped rather than folded into a nameless row", () => {
	assert.deepEqual(foldFleetRuns([fact("fleet.started", { agentId: "a" })]), []);
	assert.deepEqual(foldFleetRuns([{ id: "x", at: "now", sourceSequence: 1, fact: { type: "fleet.started" } }]), []);
});

test("the running-only filter says how many rows it hid", () => {
	assert.equal(fleetFilterStatus(1, 3), "1 of 3 reported runs shown");
	assert.equal(fleetFilterStatus(1, 1), "All 1 reported run shown");
	assert.equal(fleetFilterStatus(3, 3), "All 3 reported runs shown");
});

test("every fact type has a label, a tone and a sentence, and an unknown one degrades readably", () => {
	for (const type of [
		"fleet.enqueued",
		"fleet.started",
		"fleet.progress",
		"fleet.completed",
		"fleet.failed",
		"fleet.loopBlocked",
		"evidence.ready",
	]) {
		const presented = presentFleetFact({ type, payload: {} });
		assert.equal(presented.known, true, type);
		assert.ok(presented.label.length > 0 && presented.summary.length > 0, type);
		assert.ok(!presented.summary.includes("undefined") && !presented.summary.includes("[object"), type);
	}
	const unknown = presentFleetFact({ type: "fleet.teleported", payload: { anything: 1 } });
	assert.equal(unknown.known, false);
	assert.equal(unknown.label, "fleet.teleported");
	assert.equal(unknown.summary, "Clio Coder reported a fact this build does not classify.");
	// A payload of the wrong shape entirely still produces a row rather than throwing.
	assert.equal(presentFleetFact({ type: "fleet.failed", payload: "not an object" }).known, true);
	assert.equal(presentFleetFact({ type: "fleet.failed" }).summary, "Clio Coder reported no reason.");
});

test("the loop guard and evidence facts are reported as notices rather than dropped in silence", () => {
	const items = [
		fact("fleet.started", { runId: "r1", agentId: "a" }),
		fact("fleet.loopBlocked", { tool: "read", repeatCount: 9, budget: 4, disposition: "lockout", interrupted: false }),
		fact("evidence.ready", { runId: "r1", evidenceId: "e1", firstPassSuccess: true, findingCount: 3, tags: [] }),
	];
	assert.equal(foldFleetRuns(items).length, 1);
	const notices = fleetNotices(items);
	assert.deepEqual(
		notices.map((notice) => notice.presentation.label),
		["Loop guard", "Evidence ready"],
	);
	assert.match(notices[0]?.presentation.summary ?? "", /locked the tool out/);
	assert.equal(notices[1]?.presentation.tone, "success");
});

// `accepted` means the engine queued the request on the worker's stdin. Neither sentence may
// claim the worker read it or that the run has already stopped.
test("an accepted steer says queued or requested, never delivered or stopped", () => {
	const guide = steerOutcome("guide", { accepted: true });
	assert.equal(guide.tone, "success");
	assert.match(guide.message, /queued/i);
	assert.doesNotMatch(guide.message, /delivered|received/i);
	const cancel = steerOutcome("cancel", { accepted: true });
	assert.match(cancel.message, /requested/i);
	assert.doesNotMatch(cancel.message, /\bstopped\b/i);
});

// The reason vocabulary is the engine's (`dispatchSteerReason` in src/engine/acp/server.ts).
test("every engine refusal reason reads as a sentence, and an unknown one is printed as reported", () => {
	for (const reason of [
		"dispatch-unavailable",
		"fleet-unavailable",
		"run-not-active",
		"cancel-failed",
		"empty-message",
		"steering-unsupported",
		"no-input-channel",
		"input-closed",
		"run-terminating",
		"steer-failed",
	]) {
		const outcome = steerOutcome("guide", { accepted: false, reason });
		assert.equal(outcome.tone, "warn");
		assert.equal(outcome.message, STEER_REFUSALS[reason]);
		assert.match(outcome.message, /\.$/);
	}
	assert.match(steerOutcome("guide", { accepted: false, reason: "quota-exceeded" }).message, /quota-exceeded/);
	assert.equal(steerOutcome("cancel", { accepted: false }).message, STEER_REFUSALS["steer-failed"]);
});

test("whitespace is not guidance", () => {
	assert.equal(guidanceReady("  \n\t"), false);
	assert.equal(guidanceReady(" read the README "), true);
});

test("the first second of a wait says the request just arrived instead of printing 0ms", () => {
	const at = (waitedMs: number) =>
		waitedSentence({
			escalated: false,
			waitedMs,
			waitedSeconds: Math.floor(waitedMs / 1000),
			remainingMs: 0,
			remainingSeconds: 0,
			expired: false,
			budgetKnown: false,
			declaredEscalationSeconds: 45,
		});
	assert.equal(at(0), "Asked just now.");
	assert.equal(at(999), "Asked just now.");
	assert.match(at(30_000), /^Waiting 30s\.$/);
});

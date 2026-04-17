/**
 * Diag harness for dispatch primitives introduced in Phase 6 Slice 4:
 *
 *   - src/domains/dispatch/admission.ts
 *   - src/domains/dispatch/validation.ts
 *   - src/domains/dispatch/backoff.ts
 *   - src/domains/dispatch/batch-tracker.ts
 *   - src/domains/dispatch/resilience.ts
 *
 * Every branch described in the slice spec is exercised. Pure modules, no
 * filesystem, no sockets — this is just logic verification.
 */

import { admit } from "../src/domains/dispatch/admission.js";
import { createBackoff, nextDelay, reset as resetBackoff } from "../src/domains/dispatch/backoff.js";
import { createBatch, isBatchDone, onRunComplete } from "../src/domains/dispatch/batch-tracker.js";
import { allowCall, initialCircuit, recordFailure, recordSuccess } from "../src/domains/dispatch/resilience.js";
import { validateJobSpec } from "../src/domains/dispatch/validation.js";
import type { ActionClass } from "../src/domains/safety/action-classifier.js";
import { type ScopeSpec, isSubset } from "../src/domains/safety/scope.js";

const failures: string[] = [];

function check(label: string, ok: boolean, detail?: string): void {
	if (ok) {
		process.stdout.write(`[diag-dispatch-primitives] OK   ${label}\n`);
		return;
	}
	failures.push(detail ? `${label}: ${detail}` : label);
	process.stderr.write(`[diag-dispatch-primitives] FAIL ${label}${detail ? ` — ${detail}` : ""}\n`);
}

function scope(
	actions: ReadonlyArray<ActionClass>,
	roots: ReadonlyArray<string>,
	allowNetwork: boolean,
	allowDispatch: boolean,
): ScopeSpec {
	return {
		allowedActions: new Set(actions),
		allowedWriteRoots: roots,
		allowNetwork,
		allowDispatch,
	};
}

function main(): void {
	// --- admission -----------------------------------------------------------
	const orch = scope(["read", "write", "execute", "dispatch"], [process.cwd()], true, true);
	const workerOk = scope(["read", "write"], [process.cwd()], true, false);
	const workerBadSubset = scope(["read", "write", "execute", "system_modify"], [process.cwd()], true, false);
	const workerBadAction = scope(["read"], [process.cwd()], true, false);

	const admitOk = admit(
		{ requestedScope: workerOk, orchestratorScope: orch, requestedActions: ["read", "write"], agentId: "writer" },
		isSubset,
	);
	check("admission:ok", admitOk.admitted === true && admitOk.reason === "ok", JSON.stringify(admitOk));

	const admitBadSubset = admit(
		{
			requestedScope: workerBadSubset,
			orchestratorScope: orch,
			requestedActions: ["read"],
			agentId: "sysmod",
		},
		isSubset,
	);
	check(
		"admission:bad-subset",
		admitBadSubset.admitted === false &&
			admitBadSubset.reason.includes("sysmod") &&
			admitBadSubset.reason.includes("subset"),
		JSON.stringify(admitBadSubset),
	);

	const admitBadAction = admit(
		{
			requestedScope: workerBadAction,
			orchestratorScope: orch,
			requestedActions: ["read", "write"],
			agentId: "reader",
		},
		isSubset,
	);
	check(
		"admission:bad-action",
		admitBadAction.admitted === false && admitBadAction.reason.includes("write"),
		JSON.stringify(admitBadAction),
	);

	// --- validation ----------------------------------------------------------
	const good = validateJobSpec({ agentId: "writer", task: "do a thing", runtime: "native" });
	check(
		"validation:good-spec",
		good.ok === true && good.ok && good.spec.agentId === "writer" && good.spec.runtime === "native",
		JSON.stringify(good),
	);

	const missingAgent = validateJobSpec({ task: "do a thing" });
	check(
		"validation:missing-agentId",
		missingAgent.ok === false && !missingAgent.ok && missingAgent.errors.some((e) => e.includes("agentId")),
		JSON.stringify(missingAgent),
	);

	const badTask = validateJobSpec({ agentId: "writer", task: 42 });
	check(
		"validation:non-string-task",
		badTask.ok === false && !badTask.ok && badTask.errors.some((e) => e.includes("task")),
		JSON.stringify(badTask),
	);

	const unknownKey = validateJobSpec({ agentId: "writer", task: "ok", rogueKey: true });
	check(
		"validation:unknown-key",
		unknownKey.ok === false && !unknownKey.ok && unknownKey.errors.some((e) => e.includes("rogueKey")),
		JSON.stringify(unknownKey),
	);

	// --- backoff -------------------------------------------------------------
	const bo0 = createBackoff();
	const step1 = nextDelay(bo0);
	check("backoff:initial-500", step1.delayMs === 500, `delay=${step1.delayMs}`);
	const step2 = nextDelay(step1.state);
	const step3 = nextDelay(step2.state);
	check(
		"backoff:after-3-calls-4000",
		step3.state.nextDelayMs === 4000,
		`nextDelayMs=${step3.state.nextDelayMs} attempts=${step3.state.attempts}`,
	);

	// Cap at maxMs (60_000). With factor=2 from base 500, it takes ~8 calls to
	// reach 60_000. Drive deterministically by using a small maxMs.
	let capState = createBackoff({ baseMs: 10_000, factor: 10, maxMs: 60_000 });
	// call 1: delay=10000, next=60000
	const cap1 = nextDelay(capState, { baseMs: 10_000, factor: 10, maxMs: 60_000 });
	capState = cap1.state;
	// call 2: delay=60000 (capped from 100_000 clamp in next), next=60000
	const cap2 = nextDelay(capState, { baseMs: 10_000, factor: 10, maxMs: 60_000 });
	capState = cap2.state;
	// call 3: delay=60000, next=60000
	const cap3 = nextDelay(capState, { baseMs: 10_000, factor: 10, maxMs: 60_000 });
	check(
		"backoff:cap-60000",
		cap3.delayMs === 60_000 && cap3.state.nextDelayMs === 60_000,
		`delay=${cap3.delayMs} next=${cap3.state.nextDelayMs}`,
	);

	const afterReset = resetBackoff();
	check("backoff:reset-fresh", afterReset.attempts === 0 && afterReset.nextDelayMs === 500, JSON.stringify(afterReset));

	// --- batch-tracker -------------------------------------------------------
	const runIds = ["r1", "r2", "r3"];
	const b0 = createBatch(runIds);
	check(
		"batch:initial",
		b0.runIds.length === 3 && b0.completed.size === 0 && b0.failed.size === 0 && !isBatchDone(b0),
		JSON.stringify({ completed: [...b0.completed], failed: [...b0.failed] }),
	);
	const b1 = onRunComplete(b0, "r1", false);
	check("batch:after-one-complete", b1.completed.has("r1") && !isBatchDone(b1));
	const b2 = onRunComplete(b1, "r2", true);
	check("batch:after-one-fail", b2.failed.has("r2") && b2.completed.has("r1") && !isBatchDone(b2));
	const b3 = onRunComplete(b2, "r3", false);
	check("batch:done", isBatchDone(b3) && b3.completed.has("r3"));
	const b0Again = onRunComplete(b0, "unknown", false);
	check("batch:ignores-unknown-id", b0Again === b0);

	// --- resilience ----------------------------------------------------------
	let c = initialCircuit();
	check("circuit:initial-closed", c.status === "closed" && c.failuresInWindow === 0);

	// 5 failures drive it open.
	for (let i = 0; i < 5; i++) {
		c = recordFailure(c, 1000 + i);
	}
	check("circuit:open-after-5", c.status === "open" && c.openedAt === 1004, JSON.stringify(c));

	const notAllowed = allowCall(c, 1100);
	check("circuit:disallow-during-cooldown", notAllowed.allow === false && notAllowed.status === "open");

	const allowedAfterCooldown = allowCall(c, 1004 + 30_000);
	check(
		"circuit:half-open-after-cooldown",
		allowedAfterCooldown.allow === true && allowedAfterCooldown.status === "half-open",
		JSON.stringify(allowedAfterCooldown),
	);

	const closedBySuccess = recordSuccess(c);
	check(
		"circuit:success-closes",
		closedBySuccess.status === "closed" && closedBySuccess.failuresInWindow === 0 && closedBySuccess.openedAt === null,
		JSON.stringify(closedBySuccess),
	);

	// Back to half-open territory and then fail: should reopen.
	const reopened = recordFailure(c, 1004 + 30_001);
	check(
		"circuit:failure-reopens-after-cooldown",
		reopened.status === "open" && reopened.openedAt === 1004 + 30_001,
		JSON.stringify(reopened),
	);
}

main();

if (failures.length > 0) {
	process.stderr.write(`[diag-dispatch-primitives] FAILED ${failures.length} check(s)\n`);
	process.exit(1);
}
process.stdout.write("[diag-dispatch-primitives] PASS\n");

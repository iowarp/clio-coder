import { strictEqual } from "node:assert/strict";
import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fleetInspectionScope } from "../../src/cli/fleet-project-scope.js";
import type { ExecutionStepResult } from "../../src/domains/dispatch/execution-scheduler.js";
import type { FleetRunRecord } from "../../src/domains/dispatch/state.js";
import type { RunEnvelope } from "../../src/domains/dispatch/types.js";
import { type IsolatedClioEnv, isolateClioEnv } from "../harness/scratch-env.js";

function root(id: string, runIds: string[], cwd?: string): FleetRunRecord {
	return {
		version: 1,
		id,
		...(cwd !== undefined ? { cwd } : {}),
		fleet: "f",
		planHash: "h",
		stepIds: runIds.map((_, index) => `s${index}`),
		planSteps: [],
		vars: {},
		startedAt: "2026-10-01T00:00:00.000Z",
		endedAt: null,
		resumedFrom: null,
		steps: runIds.map((runId, index) => ({
			stepId: `s${index}`,
			result: { terminalRunId: runId } as unknown as ExecutionStepResult,
		})),
	};
}

describe("fleet project inspection scope", () => {
	let env: IsolatedClioEnv;
	let project: string;
	let elsewhere: string;
	beforeEach(async () => {
		env = await isolateClioEnv("clio-coder-fleet-scope-");
		project = join(realpathSync(env.dir), "project");
		elsewhere = join(realpathSync(env.dir), "elsewhere");
		mkdirSync(project, { recursive: true });
		mkdirSync(elsewhere, { recursive: true });
	});
	afterEach(() => env.restore());

	it("keeps a cwd-recording root whose runs left the ledger and infers only legacy roots", () => {
		const scope = fleetInspectionScope(false, project);
		const ledger = new Map<string, RunEnvelope>([["r-here", { id: "r-here", cwd: project } as RunEnvelope]]);
		const getRun = (id: string) => ledger.get(id) ?? null;
		// Evicted step runs never hide a root that records its own project.
		strictEqual(scope.seesRoot(root("fleet-a", ["evicted"], project), getRun), true);
		strictEqual(scope.seesRoot(root("fleet-b", ["r-here"], elsewhere), getRun), false);
		// A legacy root is placed by its terminal runs.
		strictEqual(scope.seesRoot(root("fleet-c", ["r-here"]), getRun), true);
		strictEqual(scope.seesRoot(root("fleet-d", ["evicted"]), getRun), false);
		strictEqual(scope.seesRoot(root("fleet-f", []), getRun), false);
	});
});

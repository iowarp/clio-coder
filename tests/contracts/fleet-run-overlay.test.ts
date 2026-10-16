import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import type { AgentsContract } from "../../src/domains/agents/contract.js";
import type { DispatchContract } from "../../src/domains/dispatch/contract.js";
import type { FleetRunOutcome } from "../../src/domains/dispatch/fleet-run.js";
import {
	createOverlayGeneralOpeners,
	type OverlayGeneralOpenersDeps,
} from "../../src/interactive/overlay-general-openers.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

const noop = () => {};

test("a running fleet refuses a second /fleet run until it settles", async () => {
	const scratch = await isolateClioEnv("clio-coder-fleet-overlay-");
	try {
		const root = realpathSync(scratch.dir);
		const agents = dispatchStubContext({ settings: DEFAULT_SETTINGS }).getContract<AgentsContract>("agents");
		ok(agents);
		const notices: Array<[string, string]> = [];
		let opened = 0;
		let accept: (() => void) | undefined;
		let finish: (() => void) | undefined;
		const transitions = { state: "closed", handle: null, showPermission: () => false, close: noop };
		const deps: Partial<OverlayGeneralOpenersDeps> = {
			dispatch: {} as DispatchContract,
			agents,
			transitions: transitions as unknown as OverlayGeneralOpenersDeps["transitions"],
			getSessionMeta: () => ({ cwd: root }) as ReturnType<OverlayGeneralOpenersDeps["getSessionMeta"]>,
			terminal: { columns: 100 } as OverlayGeneralOpenersDeps["terminal"],
			requestRender: noop,
			stderr: noop,
			closeOverlay: () => {
				transitions.state = "closed";
			},
			notify: (_level, text, key) => notices.push([key ?? "", text]),
			loadFleetSources: () => ({
				commands: null,
				playbook: {
					version: 3,
					name: "survey",
					description: "Survey fixture",
					path: join(root, "survey.md"),
					body: "Survey.",
					maxWorkers: 1,
					budgetUsd: null,
					onFailure: "stop",
					steps: [{ kind: "agent", id: "survey", agent: "coder", scope: "readonly", dependencies: [] }],
				} as never,
			}),
			openFleetRunApprovalOverlay: (_tui, options) => {
				opened += 1;
				ok(options.subject.ok, JSON.stringify(options.subject));
				accept = options.onAccept;
				return {} as ReturnType<NonNullable<OverlayGeneralOpenersDeps["openFleetRunApprovalOverlay"]>>;
			},
			runFleet: () =>
				new Promise<FleetRunOutcome>((resolve) => {
					finish = () =>
						resolve({
							cleanRun: true,
							succeededStepCount: 1,
							requiredStepCount: 1,
							totalCost: { knownUsd: 0, hasEstimated: false, hasUnknown: false, allKnownFree: true, calls: 0 },
						} as unknown as FleetRunOutcome);
				}),
		};
		const openers = createOverlayGeneralOpeners(deps as OverlayGeneralOpenersDeps);
		openers.startFleetRun("survey", {});
		ok(accept);
		accept();
		strictEqual(notices.at(-1)?.[0], "fleet-run:started");
		openers.startFleetRun("survey", {});
		strictEqual(opened, 1, "no second approval while the first fleet runs");
		strictEqual(notices.at(-1)?.[0], "fleet-run:in-flight");
		ok(notices.at(-1)?.[1].includes("is still running"));
		ok(finish);
		finish();
		await new Promise((settle) => setImmediate(settle));
		strictEqual(notices.at(-1)?.[0], "fleet-run:settled");
		openers.startFleetRun("survey", {});
		strictEqual(opened, 2);
		deepStrictEqual(
			notices.map(([key]) => key),
			["fleet-run:started", "fleet-run:in-flight", "fleet-run:settled"],
		);
	} finally {
		scratch.restore();
	}
});

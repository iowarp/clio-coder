import { deepStrictEqual, ok, strictEqual, throws } from "node:assert/strict";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { sumPricing } from "../../src/core/telemetry/pricing.js";
import type { DispatchContract, DispatchRequest } from "../../src/domains/dispatch/contract.js";
import type { FleetRunOutcome } from "../../src/domains/dispatch/fleet-run.js";
import { createFleetPlanRuns } from "../../src/interactive/fleet-plan-runs.js";
import {
	createOverlayGeneralOpeners,
	type OverlayGeneralOpenersDeps,
} from "../../src/interactive/overlay-general-openers.js";
import { parseSlashCommand } from "../../src/session-control/slash-commands.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

const noop = () => {};

test("a running fleet refuses a second /fleet run until it settles", async () => {
	const scratch = await isolateClioEnv("clio-coder-fleet-overlay-");
	try {
		const root = realpathSync(scratch.dir);
		const agents = dispatchStubContext({ settings: DEFAULT_SETTINGS }).getContract("agents");
		ok(agents);
		const notices: Array<[string, string]> = [];
		let opened = 0;
		let expectedPlanHash = "";
		let accept: (() => void) | undefined;
		let finish: (() => void) | undefined;
		let settingsReadable = false;
		const runLimits: unknown[] = [];
		const transitions = { state: "closed", handle: null, showPermission: () => false, close: noop };
		const deps: Partial<OverlayGeneralOpenersDeps> = {
			dispatch: {} as DispatchContract,
			agents,
			transitions: transitions as unknown as OverlayGeneralOpenersDeps["transitions"],
			getSessionMeta: () => ({ cwd: root }) as ReturnType<OverlayGeneralOpenersDeps["getSessionMeta"]>,
			terminal: { columns: 100 } as OverlayGeneralOpenersDeps["terminal"],
			requestRender: noop,
			stderr: noop,
			getSettings: () => {
				if (!settingsReadable) throw new Error("fixture: settings unreadable");
				return DEFAULT_SETTINGS;
			},
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
				expectedPlanHash = options.subject.preview.plan.hash.slice(0, 12);
				accept = options.onAccept;
				return {} as ReturnType<NonNullable<OverlayGeneralOpenersDeps["openFleetRunApprovalOverlay"]>>;
			},
			// The session's --delegate-tools limit reaches every worker the run starts.
			standingTurnConstraints: () => ({ delegatedTools: ["read"] }),
			runFleet: (input) => {
				input.onStarted?.();
				runLimits.push(input.turnConstraints);
				return new Promise<FleetRunOutcome>((resolve) => {
					finish = () =>
						resolve({
							cleanRun: true,
							succeededStepCount: 1,
							requiredStepCount: 1,
							totalCost: sumPricing([]),
						} as unknown as FleetRunOutcome);
				});
			},
		};
		const openers = createOverlayGeneralOpeners(deps as OverlayGeneralOpenersDeps);
		// A run whose arguments throw before it starts must not leave the
		// single-run guard set, or every later /fleet run reads as in flight.
		openers.startFleetRun("survey", {});
		ok(accept);
		throws(accept, /settings unreadable/);
		settingsReadable = true;
		openers.startFleetRun("survey", {});
		strictEqual(opened, 2, "the failed start left no run in flight");
		accept();
		strictEqual(notices.at(-1)?.[0], "fleet-run:started");
		// The started notice names the plan by the steps its waves run; the plan hash stays with the approval card.
		ok(notices.at(-1)?.[1].includes("plan survey started · 1 step running"));
		ok(!notices.at(-1)?.[1].includes(expectedPlanHash));
		deepStrictEqual(runLimits, [{ delegatedTools: ["read"] }]);
		openers.startFleetRun("survey", {});
		strictEqual(opened, 2, "no second approval while the first fleet runs");
		strictEqual(notices.at(-1)?.[0], "fleet-run:in-flight");
		ok(notices.at(-1)?.[1].includes("is still running"));
		ok(finish);
		finish();
		await new Promise((settle) => setImmediate(settle));
		strictEqual(notices.at(-1)?.[0], "fleet-run:settled");
		openers.startFleetRun("survey", {});
		strictEqual(opened, 3);
		deepStrictEqual(
			notices.map(([key]) => key),
			["fleet-run:started", "fleet-run:in-flight", "fleet-run:settled"],
		);
	} finally {
		scratch.restore();
	}
});

for (const outside of ["bash", "ledger"]) {
	test(`fleet approval refuses ${outside} outside the standing delegation ceiling`, async () => {
		const scratch = await isolateClioEnv("clio-coder-fleet-preview-scope-");
		try {
			const agents = dispatchStubContext({ settings: DEFAULT_SETTINGS }).getContract("agents");
			ok(agents);
			let refused = false;
			const constraints = { delegatedTools: ["read", "grep"] };
			const deps: Partial<OverlayGeneralOpenersDeps> = {
				agents,
				dispatch: {
					preview: (request: DispatchRequest) => {
						if (
							request.turnConstraints?.delegatedTools !== undefined &&
							(outside === "bash" || request.ledger !== undefined)
						) {
							deepStrictEqual(request.turnConstraints, constraints);
							throw new Error(`dispatch: worker tool surface exceeds the parent task's explicit scope: ${outside}`);
						}
						return undefined;
					},
				} as unknown as DispatchContract,
				standingTurnConstraints: () => constraints,
				transitions: { state: "closed", handle: null } as unknown as OverlayGeneralOpenersDeps["transitions"],
				getSessionMeta: () => ({ cwd: scratch.dir }) as ReturnType<OverlayGeneralOpenersDeps["getSessionMeta"]>,
				terminal: { columns: 100 } as OverlayGeneralOpenersDeps["terminal"],
				requestRender: noop,
				loadFleetSources: () => ({
					commands: null,
					playbook: {
						version: 3,
						name: "build",
						description: "Build",
						path: join(scratch.dir, "build.md"),
						body: "Build.",
						maxWorkers: 2,
						budgetUsd: null,
						onFailure: "stop",
						steps: ["build", "check"].map((id) => ({
							kind: "agent",
							id,
							agent: "coder",
							scope: "readonly",
							dependencies: [],
						})),
					} as never,
				}),
				openFleetRunApprovalOverlay: (_tui, options) => {
					strictEqual(options.subject.ok, false);
					if (!options.subject.ok) {
						ok(options.subject.diagnostics.some((text) => text.includes(`explicit scope: ${outside}`)));
						refused = true;
					}
					return {} as ReturnType<NonNullable<OverlayGeneralOpenersDeps["openFleetRunApprovalOverlay"]>>;
				},
			};
			createOverlayGeneralOpeners(deps as OverlayGeneralOpenersDeps).startFleetRun("build", {});
			ok(refused);
		} finally {
			scratch.restore();
		}
	});
}

test("a settled fleet names its loops, and a loop checkpoint reads as progress rather than an error", async () => {
	const scratch = await isolateClioEnv("clio-coder-fleet-overlay-loops-");
	try {
		const root = realpathSync(scratch.dir);
		const agents = dispatchStubContext({ settings: DEFAULT_SETTINGS }).getContract("agents");
		ok(agents);
		const notices: Array<[string, string, string]> = [];
		const errors: string[] = [];
		const infos: string[] = [];
		const cards: string[] = [];
		let accept: (() => void) | undefined;
		const transitions = { state: "closed", handle: null, showPermission: () => false, close: noop };
		const deps: Partial<OverlayGeneralOpenersDeps> = {
			dispatch: {} as DispatchContract,
			agents,
			transitions: transitions as unknown as OverlayGeneralOpenersDeps["transitions"],
			getSessionMeta: () => ({ cwd: root }) as ReturnType<OverlayGeneralOpenersDeps["getSessionMeta"]>,
			terminal: { columns: 100 } as OverlayGeneralOpenersDeps["terminal"],
			requestRender: noop,
			stderr: (text) => errors.push(text),
			stdout: (text) => infos.push(text),
			appendBlock: (render) => cards.push(render(100).join("\n")),
			fleetPlans: createFleetPlanRuns(),
			getSettings: () => DEFAULT_SETTINGS,
			closeOverlay: () => {
				transitions.state = "closed";
			},
			notify: (level, text, key) => notices.push([level, key ?? "", text]),
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
				accept = options.onAccept;
				return {} as ReturnType<NonNullable<OverlayGeneralOpenersDeps["openFleetRunApprovalOverlay"]>>;
			},
			runFleet: async (input) => {
				input.onStarted?.();
				input.onNotice?.("loop suite cycle 1 checkpoint=refs/clio-coder/loop/abc", "gate");
				input.onNotice?.("write boundary w0: outside writes", "write-boundary");
				return {
					cleanRun: true,
					succeededStepCount: 1,
					requiredStepCount: 1,
					resolvedLoopCount: 1,
					result: { loops: [{ loopId: "suite", resolved: true }] },
					totalCost: sumPricing([]),
				} as unknown as FleetRunOutcome;
			},
		};
		const openers = createOverlayGeneralOpeners(deps as OverlayGeneralOpenersDeps);
		openers.startFleetRun("survey", {});
		ok(accept);
		accept();
		await new Promise((settle) => setImmediate(settle));
		deepStrictEqual(infos, ["plan survey: loop suite cycle 1 checkpoint=refs/clio-coder/loop/abc\n"]);
		deepStrictEqual(errors, ["plan survey: write boundary w0: outside writes\n"]);
		const settled = notices.find(([, key]) => key === "fleet-run:settled");
		ok(settled);
		ok(settled[2].includes("1/1 steps succeeded, 1/1 loop resolved"), settled[2]);
		ok(cards.at(-1)?.includes("1/1 steps · 1/1 loop resolved"), cards.at(-1));
	} finally {
		scratch.restore();
	}
});

test("a task typed after the playbook name points at --var task", () => {
	deepStrictEqual(parseSlashCommand("/fleet run build-test Add clamp to calc.py"), {
		kind: "usage-error",
		command: "fleet",
		reason: 'Unexpected argument: Add; a playbook takes its task as --var task="<text>"',
		subcommand: "run",
	});
});

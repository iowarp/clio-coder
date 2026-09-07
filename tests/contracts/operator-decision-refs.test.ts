import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { clioStateDir } from "../../src/core/xdg.js";
import type { AgentsContract } from "../../src/domains/agents/contract.js";
import type { DispatchContract, DispatchRequest } from "../../src/domains/dispatch/contract.js";
import { verifyReceiptIntegrity } from "../../src/domains/dispatch/receipt-integrity.js";
import type { RunEnvelope, RunReceipt } from "../../src/domains/dispatch/types.js";
import { activeDecisionRefs } from "../../src/domains/session/decision-board.js";
import type { DecisionLedgerEntry } from "../../src/domains/session/entries.js";
import {
	createInteractiveSlashRuntime,
	type InteractiveSlashRuntimeDeps,
} from "../../src/interactive/interactive-slash-runtime.js";
import {
	createOverlayGeneralOpeners,
	type OverlayGeneralOpenersDeps,
} from "../../src/interactive/overlay-general-openers.js";
import type { OverlayTransitions } from "../../src/interactive/overlay-transitions.js";
import { createDispatchTool } from "../../src/tools/dispatch.js";
import { agentDecision } from "../harness/decision.js";
import { isolateDispatchState, makeDispatchBundle, restoreDispatchState } from "../harness/dispatch.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";

const TASK = "Report the available provenance evidence.";
const noop = () => {};

describe("active decisions on actual operator dispatch paths", () => {
	beforeEach(async () => isolateDispatchState());
	afterEach(() => restoreDispatchState());

	for (const empty of [false, true]) {
		for (const path of ["tool", "run", "fleet"] as const) {
			it(`${path} seals the ${empty ? "empty" : "active"} board captured before admission`, {
				timeout: 15_000,
			}, async () => {
				const initial = await agentDecision();
				const retired: DecisionLedgerEntry = {
					...initial,
					interviewId: "retired",
					decisions: initial.decisions.map((record) => ({ ...record, status: "superseded", revisedAt: initial.endedAt })),
				};
				const admittedBoard = empty ? [] : [initial, retired];
				const expected = empty ? undefined : activeDecisionRefs(admittedBoard);
				// A late decision must never be reconstructed onto an already admitted run.
				const late = await agentDecision("root", "late-choice");
				let board: ReadonlyArray<DecisionLedgerEntry> = admittedBoard;
				let reads = 0;
				const getDecisionBoard = () => {
					reads += 1;
					return board;
				};
				const settings = structuredClone(DEFAULT_SETTINGS);
				settings.safety.autonomy = "full-auto";
				settings.fleet.retry.maxRetries = 0;
				const context = dispatchStubContext({ settings });
				const agents = context.getContract<AgentsContract>("agents");
				ok(agents);
				const project = join(clioStateDir(), "project");
				mkdirSync(project, { recursive: true });
				const bundle = makeDispatchBundle(context, {
					spawnWorker: () => ({
						pid: null,
						promise: Promise.resolve({ exitCode: 0, signal: null }),
						heartbeatAt: { current: Date.now(), monotonic: 0 },
						events: (async function* () {
							yield {
								type: "message_end",
								message: {
									role: "assistant",
									stopReason: "stop",
									content: JSON.stringify({
										mutatedPaths: [],
										validations: [{ name: "fixture", passed: true, evidence: "deterministic worker fixture" }],
									}),
								},
							};
						})(),
						abort: noop,
					}),
				});
				await bundle.extension.start();
				const requests: DispatchRequest[] = [];
				const receipts: RunReceipt[] = [];
				let resolveSettled!: () => void;
				let rejectSettled!: (reason: unknown) => void;
				const settled = new Promise<void>((resolve, reject) => {
					resolveSettled = resolve;
					rejectSettled = reject;
				});
				// Observe real admission and real sealed outputs; the wrapper never adds refs.
				const dispatch: DispatchContract = {
					...bundle.contract,
					dispatch: async (request, ...args) => {
						requests.push(structuredClone(request));
						board = [late];
						try {
							const handle = await bundle.contract.dispatch(request, ...args);
							void handle.finalPromise.then((receipt) => receipts.push(receipt), rejectSettled);
							return handle;
						} catch (error) {
							rejectSettled(error);
							throw error;
						}
					},
				};
				try {
					if (path === "tool") {
						const result = await createDispatchTool({
							dispatch,
							getAgentSpecs: () => agents.listSpecs(),
							getAutonomy: () => "full-auto",
							getDecisionBoard,
						}).run({ agent: "coder", task: TASK });
						strictEqual(result.kind, "ok", JSON.stringify(result));
					} else {
						let accept: (() => void) | undefined;
						const transitions: OverlayTransitions = {
							state: "closed",
							handle: null,
							showPermission: () => false,
							close: noop,
						};
						const openerDeps: Partial<OverlayGeneralOpenersDeps> = {
							dispatch,
							agents,
							getDecisionBoard,
							transitions,
							getSessionMeta: () => ({ cwd: project }) as ReturnType<OverlayGeneralOpenersDeps["getSessionMeta"]>,
							terminal: { columns: 100 },
							getSettings: () => settings,
							requestRender: noop,
							stderr: noop,
							closeOverlay: () => {
								transitions.state = "closed";
							},
							notify: (_level, text, key) => {
								if (key === "fleet-run:settled") resolveSettled();
								if (key === "fleet-run:failed") rejectSettled(new Error(text));
							},
							loadFleetSources: () => ({
								commands: null,
								contract: {
									version: 3,
									name: "decision-fixture",
									description: "Decision provenance regression",
									path: join(project, "fleet.md"),
									body: TASK,
									maxWorkers: 1,
									budgetUsd: null,
									onFailure: "stop",
									steps: ["first", "second"].map((id, index) => ({
										kind: "agent",
										id,
										agent: "coder",
										scope: "readonly",
										dependencies: index === 0 ? [] : ["first"],
									})),
								},
							}),
							openFleetRunApprovalOverlay: (_tui, options) => {
								ok(options.subject.ok, JSON.stringify(options.subject));
								accept = options.onAccept;
								return {
									hide: noop,
									setHidden: noop,
									isHidden: () => false,
									focus: noop,
									unfocus: noop,
									isFocused: () => true,
									getBounds: () => undefined,
								};
							},
						};
						// Only fleet-open methods run; unrelated overlay dependencies are intentionally absent.
						const openers = createOverlayGeneralOpeners(openerDeps as OverlayGeneralOpenersDeps);
						const runtimeDeps: Partial<InteractiveSlashRuntimeDeps> = {
							dispatch,
							bus: context.bus,
							agents,
							getDecisionBoard,
							io: { stdout: noop, stderr: noop },
							chatPanel: { appendReplayBlock: noop, appendUser: noop, clearFoldOverrides: noop },
							requestRender: () => {
								if (receipts.length > 0 && path === "run") resolveSettled();
							},
							startFleetRun: openers.startFleetRun,
						};
						const runtime = createInteractiveSlashRuntime(runtimeDeps as InteractiveSlashRuntimeDeps);
						if (path === "fleet") board = [late];
						strictEqual(
							runtime.dispatchCommand(path === "run" ? `/run coder ${TASK}` : "/fleet run decision-fixture"),
							"accepted",
						);
						if (path === "fleet") {
							strictEqual(requests.length, 0, "preview must not dispatch");
							strictEqual(reads, 0, "capture the active board when the operator accepts");
							board = admittedBoard;
							ok(accept);
							accept();
						}
						await settled;
					}
					strictEqual(requests.length, path === "fleet" ? 2 : 1);
					strictEqual(receipts.length, requests.length);
					for (const request of requests) deepStrictEqual(request.decisionRefs, expected);
					strictEqual(reads, 1, "one invocation snapshot, even across sequential fleet steps");
					for (const receipt of receipts) {
						strictEqual(receipt.outcome, "succeeded", JSON.stringify(receipt));
						const envelope = bundle.contract.getRun(receipt.runId);
						ok(envelope);
						deepStrictEqual(envelope.decisionRefs, expected);
						deepStrictEqual(receipt.decisionRefs, expected);
						const persisted = JSON.parse(
							readFileSync(join(clioStateDir(), "receipts", `${receipt.runId}.json`), "utf8"),
						) as RunReceipt;
						const ledger = JSON.parse(readFileSync(join(clioStateDir(), "runs.json"), "utf8")) as RunEnvelope[];
						const persistedEnvelope = ledger.find((run) => run.id === receipt.runId);
						ok(persistedEnvelope);
						deepStrictEqual(persistedEnvelope.decisionRefs, expected);
						deepStrictEqual(persisted.decisionRefs, expected);
						ok(verifyReceiptIntegrity(persisted, persistedEnvelope).ok);
						strictEqual(
							verifyReceiptIntegrity({ ...persisted, decisionRefs: activeDecisionRefs([late]) }, persistedEnvelope).ok,
							false,
						);
					}
				} finally {
					await bundle.extension.stop?.();
				}
			});
		}
	}
});

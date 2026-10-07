import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { BusChannels } from "../core/bus-events.js";
import type { ClioSettings } from "../core/config.js";
import type { SafeEventBus } from "../core/event-bus.js";
import { ToolNames } from "../core/tool-names.js";
import type { TurnConstraints } from "../core/turn-constraints.js";
import { turnAllowsTool } from "../core/turn-constraints.js";
import type { AgentsContract } from "../domains/agents/index.js";
import { parseScoutResult } from "../domains/agents/index.js";
import type { DispatchContract } from "../domains/dispatch/contract.js";
import type { AgentRoleFactsResolver } from "../domains/dispatch/execution-role.js";
import { requestExecutionRole } from "../domains/dispatch/execution-role.js";
import { normalizeDispatchIntent } from "../domains/dispatch/intent.js";
import { dispatchOwnerOf, dispatchOwnership } from "../domains/dispatch/ownership.js";
import { verifyReceiptIntegrity } from "../domains/dispatch/receipt-integrity.js";
import { defaultRoutingIntent } from "../domains/dispatch/routing-intent.js";
import type { RunReceipt } from "../domains/dispatch/types.js";
import type {
	OrientationBlockInput,
	TurnControlRecord,
	TurnFacts,
	TurnInterpretation,
} from "../domains/turn-control/index.js";
import {
	decide,
	decisionHash,
	factsDigest,
	renderCollectedBlock,
	renderDirectionBlock,
	renderOrientationBlock,
	renderOrientationUnavailable,
} from "../domains/turn-control/index.js";
import { loadVerifiedScoutSource, prepareScoutContinuation } from "../tools/dispatch-scout-admission.js";
import type { MonitorToolDeps } from "../tools/monitor.js";
import { collectDetachedBatch } from "../tools/monitor-collect.js";
import type { ToolInvokeOptions, ToolRegistry } from "../tools/registry.js";
import { receiptHelperResult } from "../tools/worker-evidence.js";
import { observeWorkspace } from "./direction-observations.js";
import { workspaceFingerprint } from "./workspace-fingerprint.js";

type OrientationSnapshot = NonNullable<TurnControlRecord["orientation"]>;
export interface TurnControlInput {
	operatorText: string;
	userTurnId: string;
	signal: AbortSignal;
	continuation?: boolean;
}
export interface TurnControlRunner {
	run(input: TurnControlInput): Promise<{ block: string | null; record: TurnControlRecord }>;
	seedOrientation(snapshot: OrientationSnapshot | null): void;
	controllerActed(): boolean;
}
export interface TurnControlRunnerDeps {
	getSettings(): Readonly<ClioSettings>;
	getAutonomy(): "default" | "yolo";
	dispatch: DispatchContract | undefined;
	agents: AgentsContract | undefined;
	toolRegistry: Pick<ToolRegistry, "get" | "invoke"> | undefined;
	getInvokeOptions?: () => ToolInvokeOptions;
	monitorDeps?: MonitorToolDeps;
	getTurnConstraints(): TurnConstraints | undefined;
	isContinuation(): boolean;
	/**
	 * The turn site's fitted reading of this request, or undefined. Without
	 * `wait` it is taken as it stands. With `wait` the host may hold for a
	 * reading still in flight, bounded by the site's deadline and cancelled by
	 * `wait.signal`. The host forgets the reading at settle, so it is this
	 * turn's reading and never the previous one's.
	 */
	readInterpretation(wait?: { signal: AbortSignal }): Promise<TurnInterpretation | undefined>;
	facts: {
		turnIndex(): number;
		taskEstablished(): boolean;
		clarificationStreak(): number;
		finishedDetachedBatchIds(): ReadonlyArray<string>;
	};
	cwd: string;
	bus?: SafeEventBus;
	emitNotice(text: string): void;
	getAgentRoleFacts?: AgentRoleFactsResolver;
	rememberOrientation?: (turnId: string, runId: string, succeeded: boolean) => void;
}

function receiptFindings(
	receipt: RunReceipt,
	dispatch: DispatchContract,
): Pick<OrientationBlockInput, "findings" | "ungrounded"> {
	const strict = parseScoutResult(receipt.output?.text ?? "");
	if (strict) return { findings: strict.findings, ungrounded: [] };
	const envelope = dispatch.getRun(receipt.runId);
	const helper = envelope === null ? null : receiptHelperResult(receipt, verifyReceiptIntegrity(receipt, envelope));
	const data =
		helper?.kind === "scout-report"
			? helper.data
			: receipt.output?.structured?.kind === "scout-report"
				? receipt.output.structured.data
				: null;
	const findings: Array<{ claim: string; path: string; line?: number }> = [];
	const ungrounded: string[] = [];
	if (Array.isArray(data?.findings))
		for (const value of data.findings) {
			if (value === null || typeof value !== "object" || typeof value.claim !== "string") continue;
			if (typeof value.path === "string")
				findings.push({
					claim: value.claim,
					path: value.path,
					...(typeof value.line === "number" ? { line: value.line } : {}),
				});
			else ungrounded.push(value.claim);
		}
	if (Array.isArray(data?.ungroundedClaims))
		for (const claim of data.ungroundedClaims) if (typeof claim === "string") ungrounded.push(claim);
	return { findings, ungrounded };
}

export function createTurnControlRunner(deps: TurnControlRunnerDeps): TurnControlRunner {
	let prior: OrientationSnapshot | null = null;
	let acted = false;
	return {
		seedOrientation(snapshot) {
			prior = snapshot;
			acted = false;
		},
		controllerActed: () => acted,
		async run(input) {
			acted = false;
			const started = performance.now();
			const settings = deps.getSettings().turnControl;
			const constraints = deps.getTurnConstraints();
			const specs = deps.agents?.listSpecs() ?? [];
			const scouts = specs.filter(
				(spec) => spec.resultContract.kind === "scout-report" && spec.capabilityClass === "read-only",
			);
			const scoutRecipeId = scouts.find((spec) => spec.id === "scout")?.id ?? scouts[0]?.id ?? null;
			const continuation = input.continuation ?? deps.isContinuation();
			// The turn site is asked at submit, just before this runs, so a reading
			// taken at once was never there yet and orientation and direction could
			// not act. Wait for it, bounded, only when a reading could change the
			// decision: decide() never reads it under explicit constraints, on a
			// continuation, without orientation or direction enabled, or when a
			// finished batch makes collect win.
			const workflows = settings.workflows;
			const readingCanAct =
				!continuation &&
				constraints === undefined &&
				(workflows.includes("orientation") || workflows.includes("direction")) &&
				!(workflows.includes("detached-collection") && deps.facts.finishedDetachedBatchIds().length > 0);
			// A continuation carries the nudge, not the operator's request, so this
			// turn's verdict is not about it and the record must not claim it was.
			const interpretation = continuation
				? null
				: ((await deps.readInterpretation(readingCanAct ? { signal: input.signal } : undefined)) ?? null);
			// Without an interpretation the controller can only collect a finished
			// batch or do nothing, and neither reads the workspace or the turn's place
			// in the session. Two git subprocesses, a codemap read and a ledger parse
			// are spent only when a reading could act on them, so a turn with no
			// System One reading pays none of it.
			const observed = interpretation !== null;
			const facts: TurnFacts = {
				operatorText: Array.from(input.operatorText.replace(/\s+/gu, " ").trim()).slice(0, 300).join(""),
				turnIndex: observed ? deps.facts.turnIndex() : null,
				continuation,
				explicitConstraints: constraints !== undefined,
				taskEstablished: deps.facts.taskEstablished(),
				clarificationStreak: deps.facts.clarificationStreak(),
				workspace: observed
					? await workspaceFingerprint(deps.cwd)
					: { cwd: deps.cwd, gitHead: null, dirtyTreeHash: null, codemapHash: null },
				capabilities: {
					dispatch:
						deps.dispatch !== undefined &&
						deps.toolRegistry?.get(ToolNames.Dispatch) !== undefined &&
						turnAllowsTool(constraints, ToolNames.Dispatch),
					scoutRecipeId,
					readOnlyGit: deps.toolRegistry?.get(ToolNames.Git) !== undefined && turnAllowsTool(constraints, ToolNames.Git),
					monitor: deps.toolRegistry?.get(ToolNames.Monitor) !== undefined,
				},
				priorOrientation: prior,
				finishedDetachedBatchIds: deps.facts.finishedDetachedBatchIds(),
				autonomy: deps.getAutonomy(),
			};
			const producer: TurnControlRecord["producer"] = interpretation === null ? null : "system-one";
			const decision = decide(interpretation, facts, settings);
			let record: TurnControlRecord = {
				version: 1,
				turnId: input.userTurnId,
				producer,
				interpretation,
				factsDigest: factsDigest(facts),
				decision,
				decisionHash: decisionHash(decision),
				executed: null,
			};
			if (input.signal.aborted) return { block: null, record: { ...record, executed: { refused: "canceled" } } };
			if (decision.kind === "collect") {
				try {
					const monitorDeps = deps.monitorDeps ?? (deps.dispatch ? { dispatch: deps.dispatch } : null);
					if (monitorDeps === null) throw new Error("detached collection is unavailable");
					const ownership = dispatchOwnership(dispatchOwnerOf(monitorDeps.dispatch, deps.getInvokeOptions?.().sessionId));
					const rendered: string[] = [];
					const runIds: string[] = [];
					let collectedCount = 0;
					const failures: string[] = [];
					for (const batchId of decision.batchIds) {
						if (input.signal.aborted) throw new Error("canceled");
						try {
							const outcome = await collectDetachedBatch(monitorDeps, batchId, ownership);
							if (outcome.kind !== "ok") throw new Error(outcome.message);
							if (outcome.details?.complete !== true || outcome.details.collected !== true)
								throw new Error(`batch ${batchId} is not durably collected`);
							rendered.push(outcome.output);
							collectedCount += 1;
							if (Array.isArray(outcome.details.runs))
								for (const run of outcome.details.runs) {
									if (run !== null && typeof run === "object" && typeof run.runId === "string") runIds.push(run.runId);
								}
						} catch (error) {
							// S9: a later failure must not discard results from an already marked batch.
							failures.push(`batch ${batchId}: ${error instanceof Error ? error.message : String(error)}`);
						}
					}
					if (input.signal.aborted) throw new Error("canceled");
					if (collectedCount === 0) throw new Error(failures.join("; "));
					const block = renderCollectedBlock(
						[...rendered, ...failures.map((failure) => `Collection unavailable for ${failure}`)].join("\n\n"),
					);
					deps.emitNotice(`[Collected] ${collectedCount} batch(es)`);
					acted = true;
					return {
						block,
						record: { ...record, executed: { runIds, blockChars: block.length, durationMs: performance.now() - started } },
					};
				} catch (error) {
					const message = input.signal.aborted ? "canceled" : error instanceof Error ? error.message : String(error);
					if (!input.signal.aborted) deps.emitNotice(`[Collected] unavailable: ${message}`);
					return { block: null, record: { ...record, executed: { refused: message } } };
				}
			}
			if (decision.kind === "direction" && deps.toolRegistry) {
				const observations = await observeWorkspace({
					registry: deps.toolRegistry,
					cwd: deps.cwd,
					invokeOptions: { ...deps.getInvokeOptions?.(), signal: input.signal, turnId: input.userTurnId },
					observations: decision.observations,
				});
				if (input.signal.aborted) return { block: null, record: { ...record, executed: { refused: "canceled" } } };
				const block = renderDirectionBlock(observations);
				const count =
					Number(observations.git !== null) + Number(observations.tree !== null) + Number(observations.codemap !== null);
				deps.emitNotice(`[Direction] observed ${count} read-only facts`);
				acted = true;
				return {
					block,
					record: { ...record, executed: { runIds: [], blockChars: block.length, durationMs: performance.now() - started } },
				};
			}
			if (decision.kind !== "orientation") return { block: null, record };
			if (decision.reuse && prior) {
				acted = true;
				deps.rememberOrientation?.(input.userTurnId, prior.runId, !prior.block.includes("orientation is unavailable"));
				return {
					block: prior.block,
					record: {
						...record,
						orientation: prior,
						executed: { runIds: [prior.runId], blockChars: prior.block.length, durationMs: performance.now() - started },
					},
				};
			}
			const dispatch = deps.dispatch;
			const inFlight = new Set<string>();
			// Every run this act admitted, settled or not, so a refusal still reports the tokens they spent.
			const startedRuns = new Set<string>();
			const onAbort = () => {
				for (const id of inFlight) dispatch?.abort(id);
			};
			let rejectAbort: (() => void) | undefined;
			const canceled = new Promise<never>((_, reject) => {
				rejectAbort = () => {
					onAbort();
					reject(new Error("canceled"));
				};
			});
			// S6: attach the rejection handler before any admission can observe cancellation.
			void canceled.catch(() => undefined);
			input.signal.addEventListener("abort", rejectAbort as () => void, { once: true });
			const rememberRun = (id: string) => {
				inFlight.add(id);
				startedRuns.add(id);
				if (input.signal.aborted) dispatch?.abort(id);
			};
			const progressBus = dispatch?.ownsProgressBus?.(deps.bus) === true ? undefined : deps.bus;
			const forward = async (events: AsyncIterableIterator<unknown>, runId: string) => {
				for await (const event of events) {
					const typed = event as { type?: string; runId?: string };
					if (typed.runId) rememberRun(typed.runId);
					if (!typed.type || typed.type === "heartbeat") continue;
					progressBus?.emit(BusChannels.DispatchProgress, {
						runId: typed.runId ?? runId,
						agentId: scoutRecipeId ?? "scout",
						event,
					});
				}
			};
			try {
				if (!dispatch || scoutRecipeId === null) throw new Error("Scout dispatch is unavailable");
				const declaredIntent = normalizeDispatchIntent(
					{ read_roots: [], write_roots: [], relevant_paths: [], expected_outputs: [], verification: [] },
					new Map(),
				);
				if (!declaredIntent.ok) throw new Error(declaredIntent.message);
				const codemap = await readFile(join(deps.cwd, ".clio-coder", "codemap.json"), "utf8").catch(() => null);
				let briefing: string | undefined;
				if (codemap !== null) {
					try {
						const data = JSON.parse(codemap) as { summary?: unknown };
						if (typeof data.summary === "string") briefing = data.summary;
					} catch {
						/* S6: a malformed codemap supplies no optional briefing. */
					}
				}
				const admission = dispatch
					.dispatch(
						{
							agentId: scoutRecipeId,
							task: decision.question,
							...(briefing ? { briefing } : {}),
							executionRole: requestExecutionRole({
								agentId: scoutRecipeId,
								...(deps.getAgentRoleFacts ? { resolveFacts: deps.getAgentRoleFacts } : {}),
							}),
							requestOrigin: "harness",
							intent: declaredIntent.intent,
							readOnly: true,
							cwd: deps.cwd,
							routingIntent: {
								...defaultRoutingIntent({}),
								posture: "balanced",
								maxCostUsd: settings.orientation.maxCostUsdPerTurn,
								deadlineMs: null,
								minimumQuality: null,
								requiredCapabilities: [],
								failover: "approved",
							},
						},
						undefined,
						{ signal: input.signal },
					)
					.then((handle) => {
						rememberRun(handle.runId);
						return handle;
					});
				const handle = await Promise.race([admission, canceled]);
				deps.emitNotice(`[Orientation] Scout run ${handle.runId} started`);
				const [, receipt] = await Promise.race([
					Promise.all([forward(handle.events, handle.runId), handle.finalPromise]),
					canceled,
				]);
				inFlight.delete(handle.runId);
				const runIds = [handle.runId];
				const succeeded = receipt.outcome === "succeeded" || (receipt.outcome === undefined && receipt.exitCode === 0);
				let block: string;
				let cited = 0;
				if (!succeeded) block = renderOrientationUnavailable(handle.runId, receipt.outcome ?? "failed");
				else {
					const results = [receipt];
					const strict = parseScoutResult(receipt.output?.text ?? "");
					let split: number | null = null;
					let splitRefusal: string | undefined;
					if (strict?.needsSplit && decision.budget.maxScouts > 1) {
						try {
							if (strict.proposedSubtasks.length > decision.budget.maxScouts)
								throw new Error("split refused: Scout exceeded the orientation scout budget");
							if (strict.proposedSubtasks.some((task) => task.requestedAuthority !== "read-only"))
								throw new Error("split refused: harness orientation permits read-only subtasks only");
							const source = loadVerifiedScoutSource({
								dispatch,
								ref: { runId: handle.runId, receiptDigest: receipt.integrity.digest },
								agentSpecs: specs,
							});
							const ceiling = settings.orientation.maxCostUsdPerTurn ?? dispatch.costCeilingUsd?.();
							if (ceiling === undefined || !Number.isFinite(ceiling) || ceiling < 0)
								throw new Error("dispatch scheduling cost ceiling is unavailable");
							const continuation = prepareScoutContinuation({
								source,
								authorization: "harness-read-only",
								planAgentSelection: dispatch.planAgentSelection.bind(dispatch),
								costCeilingUsd: ceiling,
								maxWorkers: decision.budget.maxScouts,
							});
							const batchAdmission = dispatch.dispatchBatch(continuation.requests, { signal: input.signal }).then((batch) => {
								for (const id of batch.assignmentIds) rememberRun(id);
								return batch;
							});
							const batch = await Promise.race([batchAdmission, canceled]);
							const [, receipts] = await Promise.race([
								Promise.all([forward(batch.events, batch.batchId), batch.finalPromise]),
								canceled,
							]);
							for (const id of batch.assignmentIds) inFlight.delete(id);
							for (const item of receipts) {
								inFlight.delete(item.runId);
								runIds.push(item.runId);
								if (item.outcome === "succeeded") results.push(item);
							}
							split = receipts.length;
						} catch (error) {
							if (input.signal.aborted) throw error;
							const message = error instanceof Error ? error.message : String(error);
							if (!message.startsWith("split refused:")) throw error;
							splitRefusal = message;
						}
					}
					const findings = results.flatMap((item) => receiptFindings(item, dispatch).findings);
					const ungrounded = results.flatMap((item) => receiptFindings(item, dispatch).ungrounded);
					const grounding = results.flatMap((item) =>
						item.validationGrounding
							? [
									`validation grounding: ${item.validationGrounding.grounded}/${item.validationGrounding.claimed} claims; ${item.validationGrounding.basis}; ungrounded: ${item.validationGrounding.ungrounded.join(", ") || "none"}`,
								]
							: [],
					);
					if (splitRefusal) grounding.push(splitRefusal);
					cited = findings.length;
					block = renderOrientationBlock({
						runId: handle.runId,
						receiptDigest: receipt.integrity.digest,
						findings,
						ungrounded,
						toolCalls: results.reduce((sum, item) => sum + item.toolCalls, 0),
						budget: decision.budget.toolCallsPerScout * results.length,
						split,
						...(grounding.length ? { groundingLine: grounding.join("; ") } : {}),
					});
				}
				if (input.signal.aborted) throw new Error("canceled");
				deps.emitNotice(
					`[Orientation] Scout run ${handle.runId} settled: ${succeeded ? `${cited} cited findings` : (receipt.outcome ?? "failed")}`,
				);
				prior = { runId: handle.runId, receiptDigest: receipt.integrity.digest, fingerprint: facts.workspace, block };
				acted = true;
				deps.rememberOrientation?.(input.userTurnId, handle.runId, succeeded);
				record = {
					...record,
					orientation: prior,
					executed: { runIds, blockChars: block.length, durationMs: performance.now() - started },
				};
				return { block, record };
			} catch (error) {
				const message = input.signal.aborted ? "canceled" : error instanceof Error ? error.message : String(error);
				if (!input.signal.aborted) deps.emitNotice(`[Orientation] not started: ${message}`);
				return {
					block: null,
					record: {
						...record,
						executed: { refused: message, ...(startedRuns.size > 0 ? { startedRunIds: [...startedRuns] } : {}) },
					},
				};
			} finally {
				input.signal.removeEventListener("abort", rejectAbort as () => void);
			}
		},
	};
}

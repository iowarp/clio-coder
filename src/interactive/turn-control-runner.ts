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
	renderOrientationBlock,
	renderOrientationUnavailable,
} from "../domains/turn-control/index.js";
import { loadVerifiedScoutSource, prepareScoutContinuation } from "../tools/dispatch-scout-admission.js";
import type { ToolRegistry } from "../tools/registry.js";
import { receiptHelperResult } from "../tools/worker-evidence.js";
import { workspaceFingerprint } from "./workspace-fingerprint.js";

type OrientationSnapshot = NonNullable<TurnControlRecord["orientation"]>;
export interface TurnControlInput {
	operatorText: string;
	previous: string;
	userTurnId: string;
	signal: AbortSignal;
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
	toolRegistry: Pick<ToolRegistry, "get"> | undefined;
	getTurnConstraints(): TurnConstraints | undefined;
	isContinuation(): boolean;
	readInterpretation(): TurnInterpretation | undefined;
	fallback(input: {
		task: string;
		previous: string;
		signal: AbortSignal;
	}): Promise<{ interpretation: TurnInterpretation | null }>;
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
			const facts: TurnFacts = {
				operatorText: Array.from(input.operatorText.replace(/\s+/gu, " ").trim()).slice(0, 300).join(""),
				turnIndex: deps.facts.turnIndex(),
				continuation: deps.isContinuation(),
				explicitConstraints: constraints !== undefined,
				taskEstablished: deps.facts.taskEstablished(),
				clarificationStreak: deps.facts.clarificationStreak(),
				workspace: await workspaceFingerprint(deps.cwd),
				capabilities: {
					dispatch:
						deps.dispatch !== undefined &&
						deps.toolRegistry?.get(ToolNames.Dispatch) !== undefined &&
						turnAllowsTool(constraints, ToolNames.Dispatch),
					scoutRecipeId,
					readOnlyGit: deps.toolRegistry?.get(ToolNames.Git) !== undefined,
					monitor: deps.toolRegistry?.get(ToolNames.Monitor) !== undefined,
				},
				priorOrientation: prior,
				finishedDetachedBatchIds: deps.facts.finishedDetachedBatchIds(),
				autonomy: deps.getAutonomy(),
			};
			let interpretation = deps.readInterpretation() ?? null;
			let producer: TurnControlRecord["producer"] = interpretation === null ? null : "decision-site";
			if (
				interpretation === null &&
				settings.interpretation.fallback === "main-model" &&
				!input.signal.aborted &&
				!facts.continuation &&
				!facts.explicitConstraints &&
				settings.workflows.length > 0
			) {
				try {
					interpretation = (
						await deps.fallback({ task: input.operatorText, previous: input.previous, signal: input.signal })
					).interpretation;
				} catch {
					/* S6: an unavailable fallback leaves no interpretation. */
				}
				if (interpretation !== null) producer = "main-model";
			}
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
							if (ceiling === undefined || !Number.isFinite(ceiling) || ceiling <= 0)
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
				return { block: null, record: { ...record, executed: { refused: message } } };
			} finally {
				input.signal.removeEventListener("abort", rejectAbort as () => void);
			}
		},
	};
}

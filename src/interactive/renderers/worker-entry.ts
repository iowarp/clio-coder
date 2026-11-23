import { formatCount, formatElapsed } from "../../core/format-time.js";
import { type TierPolicy, tierPolicy } from "../../core/presentation-tier.js";
import {
	type RunApprovalFacts,
	type RunCell,
	type RunFacts,
	type RunIntegrity,
	type RunRowLayout,
	type RunStateKind,
	type RunTelemetryFacts,
	type RunValidation,
	runIdentityWidth,
	runRow,
} from "../../core/run-row.js";
import type { RunTelemetryV1 } from "../../core/telemetry/dto.js";
import { isCouncilSeatNotRun, parseCouncilReport } from "../../domains/agents/index.js";
import {
	plainOutcomeLabel,
	refusedCallsWords,
	STALLED_RUN_HEADLINE,
	settledRunCaveat,
	workerFailureHeadline,
} from "../../domains/dispatch/failure-headline.js";
import { fleetNodeTaskBrief } from "../../domains/dispatch/fleet-node-prompt.js";
import { trustStateWord, trustVerdict, validationClause } from "../../domains/evidence/trust-projection.js";
import { sanitizeCallTargetText } from "../../domains/safety/call-target.js";
import { redactSecretString } from "../../domains/safety/redaction.js";
import type { WorkerAction } from "../../domains/telemetry/worker-progress.js";
import { stripDeadToolCallMarkup } from "../../engine/loop-guard.js";
import { truncateToWidth, visibleWidth } from "../../engine/tui.js";
import { COUNCIL_SEALED_REPORT_AGENT_ID, COUNCIL_SYNTHESIS_LABEL } from "../../session-control/council.js";
import {
	type WorkerEntryState as StreamWorkerEntryState,
	type WorkerRunResultSummary,
	workerAskedByModel,
} from "../../session-control/worker-stream.js";
import { cardRail, cardRows } from "../card.js";
import { councilLabelText } from "../council-grid.js";
import type { RouteFirstOutput } from "../footer/silence-note.js";
import { actionKeyLabel } from "../keybinding-manager.js";
import {
	clioTheme,
	fitUnits,
	functionText,
	GLYPH,
	joinFacts,
	type SemanticRole,
	toolFunction,
} from "../theme/index.js";
import type { TranscriptDetailPolicy } from "../transcript-detail.js";
import { transcriptDetail } from "../transcript-detail.js";
import {
	approvalWaitWords,
	compactQuantity,
	dockedWorkerApprovalRun,
	finishedActionFault,
	workerActionParts,
	workerPhaseActivity,
	workerQuietWords,
	workerSilenceWords,
} from "../worker-activity.js";
import { previewBudget } from "./preview.js";
import {
	commitPlacementOf,
	councilAnswerGist,
	councilCollectedWords,
	councilMemberAnswerLines,
	exactWorkerAnswerObject,
	mutationReportLines,
	type PresentedContractAnswer,
	presentCouncilReport,
	presentWorkerContractAnswer,
	WorkerAnswerProjection,
} from "./worker-answer.js";

const theme = clioTheme();
const meta = (text: string): string => theme.fg("toolMetadata", text);

/**
 * A render reads the worker through a per-call copy carrying its telemetry. `cacheOwner` names the reducer's own
 * state object, the one identity that outlives a frame, so the caches below survive from delta to delta (#428).
 */
type WorkerEntryState = StreamWorkerEntryState & {
	telemetry?: RunTelemetryV1 | null;
	/** This session's worker calls on the run's route, for saying whether a silent wait is unusual. */
	routeFirstOutput?: RouteFirstOutput | null;
	cacheOwner?: StreamWorkerEntryState;
};

const workerTextCache = new WeakMap<StreamWorkerEntryState, Map<string, { source: string; text: string }>>();
const workerAnswers = new WeakMap<StreamWorkerEntryState, WorkerAnswerProjection>();

/** A clipped row's redaction marker can outgrow what it replaced, and the TUI throws on a row past the terminal's width. */
function redactedRow(row: string, width: number): string {
	const redacted = redactSecretString(row);
	return redacted === row ? row : truncateToWidth(redacted, width, GLYPH.ellipsis, false);
}

function displayText(entry: WorkerEntryState, key: string, source: string): string {
	const owner = entry.cacheOwner ?? entry;
	const fields = workerTextCache.get(owner) ?? new Map();
	const cached = fields.get(key);
	if (cached?.source === source) return cached.text;
	const text = sanitizeCallTargetText(redactSecretString(source));
	fields.set(key, { source, text });
	workerTextCache.set(owner, fields);
	return text;
}

function answerText(entry: WorkerEntryState, source: string): string {
	const owner = entry.cacheOwner ?? entry;
	let projection = workerAnswers.get(owner);
	if (projection === undefined) {
		projection = new WorkerAnswerProjection();
		workerAnswers.set(owner, projection);
	}
	// Only a run that succeeded ended its text on purpose; a failed, stalled or cancelled one can stop inside a URL (#446).
	return projection.project(source, !entry.pending && !isPending(entry) && entry.result?.outcome === "succeeded");
}

/**
 * Every telemetry value a card can print. Two views with the same string render the same card, so a batch that moved
 * nothing this card shows keeps its cached rows and the frozen transcript prefix holding them.
 */
export function workerTelemetryDisplay(telemetry: RunTelemetryV1 | null): string {
	if (telemetry === null) return "";
	const { activity, row } = telemetry;
	return [
		activity.elapsed.display,
		row.tokens.display,
		activity.toolCalls.display,
		activity.contextTokens?.display,
	].join("\0");
}

const RAIL_WIDTH = visibleWidth(cardRail());
/** A worker row under a dispatch header nests two cells in; its sub-lines then hang on a rail at column 4. */
const NEST = "  ";
const ATTEMPT = "↻ ";
const SEPARATOR = ` ${GLYPH.sep} `;

export interface WorkerEntryRenderOptions {
	telemetry?: RunTelemetryV1 | null;
	routeFirstOutput?: RouteFirstOutput | null;
	nowMs?: number;
	detail?: TranscriptDetailPolicy;
	terminalRows?: number;
	/**
	 * Inspect the card whole, as `/view` and `/export` do: the detailed card with
	 * every budget lifted and the answer exactly as the run returned it.
	 */
	unbounded?: boolean;
	/**
	 * `continues` when this card follows a card of the same council round, so
	 * the round's header row is not repeated above it.
	 */
	group?: "leads" | "continues";
	/**
	 * Workers admitted by the same dispatch call, including settled siblings. With them the card is a run row nested
	 * under the dispatch header, its identity column as wide as the widest sibling's.
	 */
	siblings?: ReadonlyArray<WorkerEntryState>;
	/** The first card of its group. The dispatch tool row is the group's header, so no worker card draws one. */
	showGroupHeader?: boolean;
}

/**
 * Who started the run, in the gutter of a council round's header: `◆` the model, `◇` the operator, `↳` CLIO Coder's
 * own helper work.
 */
function originGlyph(entry: WorkerEntryState): string {
	if (entry.helper) return functionText(theme, "shadowDispatch", GLYPH.subProcess);
	return functionText(theme, "dispatch", workerAskedByModel(entry) ? GLYPH.workerAgent : GLYPH.workerHuman);
}

/**
 * The route that ran the worker as `<target> · <model>`. A model id that already starts with its target's name
 * (`mock` serving `mock/judge-model`) is not repeated. An ACP peer runs behind someone else's process and names none.
 */
function workerRoute(entry: WorkerEntryState): string | undefined {
	if (entry.runtime.kind === "acp") return undefined;
	const { targetId, wireModelId } = entry.runtime;
	if (targetId !== undefined && wireModelId !== undefined)
		return wireModelId.startsWith(`${targetId}/`) ? wireModelId : `${targetId}${SEPARATOR}${wireModelId}`;
	return targetId ?? wireModelId;
}

/**
 * The gutter mark and the row a council round opens with. Its members follow
 * in the content column, each under its roster label, so the round reads as
 * one question put to several voices rather than as unrelated cards.
 */
function councilHeader(entry: WorkerEntryState, width: number, hint: string | null = null): string {
	const round = entry.council?.round ?? 1;
	return fitUnits(
		theme,
		`${originGlyph(entry)} `,
		[functionText(theme, "dispatch", "council"), meta(`round ${round}`), ...(hint === null ? [] : [meta(hint)])],
		width,
	);
}

/**
 * Compact gives each council member one row, so an answer longer than that row was cut with nothing saying so
 * (FX-14). The round's header names the key that shows the answers whole once a settled member of that round said
 * more than its first line, or its row cut that line. A lone card shows no answer at all.
 */
function compactCouncilHint(
	entry: WorkerEntryState,
	policy: TierPolicy,
	width: number,
	nowMs: number,
	siblings: ReadonlyArray<WorkerEntryState> | undefined,
): string | null {
	const council = entry.council;
	if (!outcomesOnly(policy) || council === undefined) return null;
	const round = (siblings ?? [entry]).filter(
		(member) => member.council?.group === council.group && member.council.round === council.round,
	);
	const cut = round.some((member) => {
		if (isSynthesis(member) || isPending(member)) return false;
		const text = member.text.trim();
		if (text.length === 0) return false;
		if (siblings === undefined) return true;
		if (councilAnswerGist(member.text) !== text) return true;
		const layout = runRow(runFactsOf(member, nowMs, taskText(member)), {
			width: width - NEST.length,
			identityWidth: identityWidthOf(siblings),
			measure: visibleWidth,
		});
		return layout.cells.some((cell) => cell.slot === "ellipsis");
	});
	if (!cut) return null;
	return `${actionKeyLabel("clio-coder.output.cycle") ?? "/view"} shows the answers`;
}

/**
 * A tier that previews no answer shows outcomes only: a worker row under a dispatch header appears only when the
 * operator has something to read in it, and a `/run` card is its one run row.
 */
function outcomesOnly(policy: TierPolicy): boolean {
	return policy.workerRows === 0;
}

/**
 * A cancel CLIO Coder has asked for and the worker has not answered yet. The abort marks the card first, and the
 * sealed result replaces it once the process exits, so until then the card says stopping, as the board and the strip do.
 */
function isStopping(result: WorkerRunResultSummary | undefined): boolean {
	return result?.outcome === "canceled" && result.provisional === true;
}

function isSynthesis(entry: WorkerEntryState): boolean {
	return entry.council?.label === COUNCIL_SYNTHESIS_LABEL;
}

/**
 * A council or poll answers a question in prose by design, members and synthesis alike, so a run that used no tool and
 * no check did nothing it was asked to: neither fact marks its card.
 */
function answersByDesign(entry: WorkerEntryState): boolean {
	return entry.council !== undefined;
}

/**
 * A council synthesis that settled with some members unanswered: its own run succeeded, the council did not in full.
 * A seat whose target was down never ran; the card names it in its body but does not read partial for it (FX-20).
 */
function councilUnanswered(entry: WorkerEntryState): number {
	if (!isSynthesis(entry) || entry.result?.outcome !== "succeeded") return 0;
	return (
		parseCouncilReport(entry.text)?.members.filter(
			(member) => member.failed !== undefined && !isCouncilSeatNotRun(member),
		).length ?? 0
	);
}

/** How many seats sat on the council: distinct roster labels that ran, as the approval card counted them. */
function councilSeatsRan(report: {
	members: ReadonlyArray<{ label: string; runId: string; failed?: unknown }>;
}): number {
	return new Set(report.members.filter((member) => !isCouncilSeatNotRun(member)).map((member) => member.label)).size;
}

/**
 * A settled worker whose answer is a question for the operator.
 *
 * Materio and WTF-P workers return `needs_input: checkpoint:decision` (or
 * `task_blocked`, or a `## CHECKPOINT REACHED` heading) followed by the
 * questions the orchestrator has to relay. That is a prose convention, not a
 * result field, so the transcript reads the first line of the answer.
 */
const CHECKPOINT_PREFIX = /^\s*(?:needs_input\b|task_blocked\b|##\s*CHECKPOINT REACHED\b|##\s*BLOCKED\b)/iu;
/** Rows a checkpoint's body keeps at every tier: the questions are the point of the entry. */
const CHECKPOINT_PREVIEW_ROWS = 16;

export function workerNeedsInput(entry: Pick<WorkerEntryState, "text" | "result">): boolean {
	return (
		entry.result !== undefined &&
		entry.result.stillRunning !== true &&
		CHECKPOINT_PREFIX.test(entry.text.trim().replace(/^```[A-Za-z0-9_-]*[^\S\r\n]*\r?\n/u, ""))
	);
}

/**
 * Whether a block should render as still going rather than settled: live,
 * never yet received a result (`entry.result === undefined`), or replayed
 * from a `runs.json` row with no `endedAt` (`stillRunning`) because its
 * process is still executing in another instance of CLIO Coder.
 */
function isPending(entry: WorkerEntryState): boolean {
	return entry.result === undefined || entry.result.stillRunning === true;
}

/** Wrap one annotation onto the rail, prefixed on its first row and hanging under it after. */
function railLines(text: string, token: SemanticRole, width: number): string[] {
	return cardRows(text, width, token === "error", token);
}

function presentedContractAnswer(entry: WorkerEntryState): PresentedContractAnswer | null {
	if (entry.result?.trust?.artifactIntegrity.state !== "verified") return null;
	// A council's synthesis seals the whole council as one report; the card reads it as answers, not as JSON.
	if (entry.council?.label === COUNCIL_SYNTHESIS_LABEL && !isPending(entry)) {
		const report = parseCouncilReport(entry.text);
		// A council that only collected has no answer of its own, and each member's answer is on its row just above.
		if (report !== null && report.synthesis.kind === "none") return { lines: [], footer: councilCollectedWords(report) };
		if (report !== null) return presentCouncilReport(report);
	}
	const kind = entry.result?.contractKind;
	const conformance = entry.result?.contract;
	return presentWorkerContractAnswer(
		entry.text,
		kind && conformance ? { kind, conformance } : undefined,
		entry.droppedLines === 0 && (entry.progress?.droppedBytes ?? 0) === 0,
		!entry.pending && !isPending(entry),
	);
}

/**
 * The body's source lines. A structured answer (a result-contract JSON object)
 * uses its result identity for a readable preview. Unknown objects retain
 * their original numeric source tokens instead of being parsed and reserialized.
 * Truncated text is not one object and passes through as the prose it is. A mutation report leaves out
 * `changed nothing` when the facts row above it already says so.
 */
function bodySourceLines(entry: WorkerEntryState, changeOnFacts: boolean): string[] {
	// A settled council member's answer reads as words even when its record is unverified; the row says so.
	if (
		entry.council !== undefined &&
		!isSynthesis(entry) &&
		!entry.pending &&
		!isPending(entry) &&
		entry.droppedLines === 0
	) {
		const lines = presentedContractAnswer(entry)?.lines ?? councilMemberAnswerLines(entry.text);
		if (lines !== null) return lines;
	}
	if (
		entry.pending ||
		entry.result?.trust?.artifactIntegrity.state !== "verified" ||
		entry.droppedLines !== 0 ||
		(entry.progress?.droppedBytes ?? 0) !== 0
	)
		return answerText(entry, entry.pending ? stripDeadToolCallMarkup(entry.text) : entry.text).split("\n");
	const structured = entry.droppedLines === 0 ? exactWorkerAnswerObject(entry.text) : null;
	if (structured === null) return answerText(entry, entry.text).split("\n");
	const presented = presentedContractAnswer(entry);
	if (presented !== null) return presented.lines;
	return (
		mutationReportLines(structured, commitPlacementOf(entry.result ?? {}).branch, !changeOnFacts) ??
		answerText(entry, entry.text).split("\n")
	);
}

/** Tool names only, coalesced onto one line. Arguments never cross into the transcript. */
function toolLine(entry: WorkerEntryState, width: number): string | null {
	if (entry.tools.length === 0) return null;
	const contentWidth = Math.max(1, width - RAIL_WIDTH);
	return `${cardRail()}${theme.fg(
		"body",
		fitUnits(
			theme,
			`${theme.fg("toolGlyph", GLYPH.phaseTool)} `,
			entry.tools.map((tool) => functionText(theme, toolFunction(tool), tool)),
			contentWidth,
		),
	)}`;
}

/** One rail line per failover, naming the attempt and the route it moved to. */
function attemptLines(entry: WorkerEntryState, width: number): string[] {
	return (entry.attempts ?? []).flatMap((attempt, index) =>
		index === 0
			? []
			: railLines(
					`${ATTEMPT}failed over → attempt ${index + 1} on ${attempt.targetLabel}${attempt.moveReason ? `: ${sanitizeCallTargetText(attempt.moveReason)}` : ""}`,
					"warning",
					width,
				),
	);
}

/** The failure's receipt words, for `/view`: the run row already leads with the reason a person acts on. */
function inspectFailureLines(entry: WorkerEntryState, width: number): string[] {
	const first = (entry.result?.failureMessage?.split("\n", 1)[0] ?? "").trim();
	return first.length === 0 ? [] : railLines(`${GLYPH.error} ${first}`, "error", width);
}

/** `/view` keeps the record's own validation wording and its claimant, which the transcript rows put in plain words. */
function inspectQualityLines(entry: WorkerEntryState, width: number): string[] {
	const result = entry.result;
	if (result === undefined || isPending(entry) || isStopping(result)) return [];
	const grounding = result.trust?.validationGrounding;
	if (grounding === undefined) return railLines("quality validation unknown", "body", width);
	const why =
		grounding.state === "failed" && result.validationFailure !== undefined
			? `: ${result.validationFailure} · /view dispatch:${entry.runId}`
			: "";
	return railLines(`quality ${validationClause({ validationGrounding: grounding })}${why}`, "body", width);
}

/**
 * Where a finished run's changes are when CLIO Coder did not merge them: a `changed` row alone reads as the checkout,
 * and the change sits on the worktree's branch until the operator takes it.
 */
function keptWorktreeLines(entry: WorkerEntryState, width: number): string[] {
	const result = entry.result;
	const task = result?.taskWorktree;
	if (result === undefined || result.outcome === "canceled" || result.mergeDetail !== undefined) return [];
	if (task === undefined || !task.kept || task.changedPaths === 0) return [];
	const files = `${task.changedPaths} changed ${task.changedPaths === 1 ? "file" : "files"}`;
	// The change waits on the operator, so the card names the two git commands that read it and take it.
	return [
		...railLines(
			sanitizeCallTargetText(`${files} on branch ${task.branch} in its worktree, not in your checkout`),
			"toolMetadata",
			width,
		),
		...branchCommandLines(task.branch, width),
	];
}

/** The two git commands that read a kept branch and take it, for a card whose change waits on the operator. */
function branchCommandLines(branch: string, width: number): string[] {
	return railLines(
		sanitizeCallTargetText(`git diff HEAD...${branch} to review it · git merge ${branch} to take it`),
		"annotation",
		width,
	);
}

/**
 * Who stopped a cancelled run, and what became of its worktree, which nothing else on the card says: a cancel
 * removes a worktree with no work in it and keeps one holding changes, on its branch.
 */
function cancelLines(entry: WorkerEntryState, width: number): string[] {
	// What became of the worktree is known only once the process has exited.
	if (entry.result?.outcome !== "canceled" || isStopping(entry.result)) return [];
	// The process's own signal note says how it was stopped, not who stopped it, so the card says only that it was.
	const headline = workerFailureHeadline(entry.result.failureMessage);
	// So does the worker's own note that its control channel closed, which is how a stop reaches a worker.
	const why = headline === null || /\bSIG[A-Z]+\b|control channel closed/u.test(headline) ? "cancelled" : headline;
	const task = entry.result.taskWorktree;
	const placement = entry.result.placement;
	const worktree =
		task !== undefined
			? task.kept
				? task.changedPaths > 0
					? `${task.changedPaths} changed ${task.changedPaths === 1 ? "file stays" : "files stay"} in its worktree on branch ${task.branch}`
					: `its worktree stays on branch ${task.branch}`
				: "its worktree held no changes and was removed"
			: placement?.mode === "worktree"
				? `its worktree stays on branch ${placement.branch}`
				: null;
	// The row already says cancelled; this is only for who stopped it and what became of its worktree.
	if (why === "cancelled" && worktree === null) return [];
	const text = `${GLYPH.cancelled} ${why.startsWith("cancelled") ? why : `cancelled: ${why}`}${worktree === null ? "" : `${SEPARATOR}${worktree}`}`;
	return [
		...railLines(sanitizeCallTargetText(text), "toolMetadata", width),
		...(task?.kept === true && task.changedPaths > 0 ? branchCommandLines(task.branch, width) : []),
	];
}

/** A finished call as `verb object` in the past tense, or its tool name when the runtime sent no descriptor. */
function finishedAction(action: WorkerAction): string {
	const parts = workerActionParts(action, "finished");
	const verb = functionText(theme, toolFunction(action.tool), sanitizeCallTargetText(parts.verb));
	const actionText =
		parts.object.length === 0 ? verb : `${verb}${theme.fg("toolTarget", ` ${sanitizeCallTargetText(parts.object)}`)}`;
	const fault = finishedActionFault(action);
	return fault === null ? actionText : `${actionText} ${theme.fg(fault.tone, `${GLYPH.error} ${fault.words}`)}`;
}

/** The same call in plain words, for a telemetry sub-line whose role paints it. */
function finishedActionWords(action: WorkerAction): string {
	const parts = workerActionParts(action, "finished");
	const text = sanitizeCallTargetText(parts.object.length === 0 ? parts.verb : `${parts.verb} ${parts.object}`);
	const fault = finishedActionFault(action);
	return fault === null ? text : `${text} ${fault.words}`;
}

/**
 * A settled card's calls, oldest first, with a run of one repeated call stated
 * once and counted (`read docs/retry.md ×3`): a worker going round in a loop is
 * a fact worth one row, not four identical ones.
 */
function trailCalls(recent: ReadonlyArray<WorkerAction>): Array<{ text: string; count: number }> {
	const calls: Array<{ text: string; count: number }> = [];
	for (const action of [...recent].reverse()) {
		const text = finishedAction(action);
		const last = calls[calls.length - 1];
		if (last?.text === text) last.count += 1;
		else calls.push({ text, count: 1 });
	}
	return calls;
}

function workerName(entry: WorkerEntryState): string {
	// The synthesis run carries the council's result, judged, voted or only collected, so it goes by the council.
	const label = isSynthesis(entry) ? synthesisName(entry) : entry.council?.label;
	// A plan's steps can share one agent and one task, so a step's worker goes by its step as the board row does.
	const step = entry.planStep === undefined ? "" : ` · ${entry.planStep}`;
	const acp = entry.runtime.kind === "acp" ? " (acp)" : "";
	return displayText(entry, "name", `${label ?? entry.agentId}${acp}${step}`);
}

/** The council's own row goes by the council's size once its report says how many seats ran. */
function synthesisName(entry: WorkerEntryState): string {
	const report = isPending(entry) ? null : parseCouncilReport(entry.text);
	return report !== null && councilSeatsRan(report) > 0 ? `council of ${councilSeatsRan(report)}` : "council";
}

/** A council member's name carries the route that answered, since members differ mainly by route. */
function identityName(entry: WorkerEntryState): string {
	const name = workerName(entry);
	if (entry.council === undefined || isSynthesis(entry) || entry.agentId === COUNCIL_SEALED_REPORT_AGENT_ID) return name;
	const route = workerRoute(entry);
	return route === undefined ? name : `${name} · ${displayText(entry, "route", route)}`;
}

/** The one identity column of a dispatch's rows: origin, `↳` for a helper, the widest name among the siblings. */
function identityWidthOf(entries: ReadonlyArray<WorkerEntryState>): number {
	return runIdentityWidth(
		entries.map((entry) => ({
			agent: identityName(entry),
			origin: "model",
			outcome: "running",
			...(entry.helper ? { helper: true } : {}),
		})),
		visibleWidth,
	);
}

/** The task a row carries: a council member was asked the question its round shows, so its row gives its answer. */
function taskText(entry: WorkerEntryState): string | undefined {
	const source =
		entry.council !== undefined && !isSynthesis(entry)
			? isPending(entry) || entry.text.trim().length === 0
				? ""
				: ((presentedContractAnswer(entry)?.lines ?? [councilAnswerGist(entry.text)])
						.find((line) => line.trim().length > 0)
						?.replace(/^\s*-\s*/u, "")
						.trim() ?? "")
			: fleetNodeTaskBrief(entry.task ?? "");
	const flat = displayText(entry, "task", source).replace(/\s+/gu, " ").trim();
	return flat.length === 0 ? undefined : flat;
}

/**
 * Elapsed time from the read model's DTO only: a local clock would tick on a run whose journal says nothing, so a
 * row without the DTO leaves its time slot blank.
 */
function elapsedMs(entry: WorkerEntryState): number | undefined {
	const fact = entry.telemetry?.activity.elapsed.fact;
	return fact !== undefined && (fact.kind === "measured" || fact.kind === "estimated") ? fact.value : undefined;
}

/**
 * A read-model count in the shared row form, its qualifier kept: `≥10,810` reads `≥10.8k`. A wholly unknown figure is
 * null, because `unknown tokens` tells a reader nothing they can act on.
 */
function countFigure(display: string | undefined): string | null {
	if (display === undefined) return null;
	const figure = compactQuantity(display);
	if (figure === null) return null;
	const match = /^(≥|≈|~|>=)?\s*(\d[\d,]*(?:\.\d+)?)$/u.exec(figure);
	const value = Number(match?.[2]?.replaceAll(",", ""));
	return match === null || !Number.isFinite(value) ? figure : `${match[1] ?? ""}${formatCount(value)}`;
}

function tokensWords(entry: WorkerEntryState): string | undefined {
	const figure = countFigure(entry.telemetry?.row.tokens.display);
	return figure === null ? undefined : `${figure} tokens`;
}

function callCount(entry: WorkerEntryState): number | undefined {
	const fact = entry.telemetry?.activity.toolCalls.fact;
	if (fact !== undefined && (fact.kind === "measured" || fact.kind === "estimated")) return fact.value;
	return entry.result?.toolCalls ?? entry.progress?.toolCalls;
}

function callsWords(count: number | undefined): string | undefined {
	return count === undefined ? undefined : `${count} ${count === 1 ? "call" : "calls"}`;
}

/** What a live worker is doing, by the evidence that outranks the rest: a stopped heartbeat, its call, silence, phase. */
function livePhase(entry: WorkerEntryState, nowMs: number): string {
	const progress = entry.progress;
	if (progress === undefined) return entry.result?.stillRunning === true ? "still running" : "starting";
	const quiet = workerQuietWords(progress, nowMs, 48);
	if (quiet !== null) return quiet;
	const action = progress.currentAction;
	if (action !== null && action !== undefined) {
		const parts = workerActionParts(action, "running");
		return parts.object.length === 0 ? parts.verb : `${parts.verb} ${parts.object}`;
	}
	const silence =
		progress.verification === undefined
			? workerSilenceWords(progress, { now: nowMs, room: 48, history: entry.routeFirstOutput ?? null })
			: null;
	return silence ?? workerPhaseActivity(progress)[1];
}

/**
 * The live ask, read from the one deadline record the approval card reads. The key is named only when this session
 * has the ask's card docked, because only then does Enter answer it.
 */
function approvalFacts(entry: WorkerEntryState, nowMs: number): RunApprovalFacts | undefined {
	const progress = entry.progress;
	if (progress?.awaitingApproval !== true) return undefined;
	const window = progress.approvalWindow;
	return {
		decider: window?.decider ?? "operator",
		...(window?.owner !== undefined ? { owner: window.owner } : {}),
		words: (room) => approvalWaitWords(progress, { now: nowMs, room, ownerFirst: true }),
		...(dockedWorkerApprovalRun() === entry.runId ? { cardDocked: true } : {}),
	};
}

/**
 * The first validation the worker itself reported as passing, by name, or null when the card lists none. An unnamed
 * passing row still counts, so the check fact can name whose word it is.
 */
function reportedPassingCheck(entry: WorkerEntryState): string | null {
	const structured = entry.droppedLines === 0 ? exactWorkerAnswerObject(entry.text) : null;
	const validations = structured?.validations;
	if (!Array.isArray(validations)) return null;
	for (const check of validations) {
		if (typeof check !== "object" || check === null || check.passed !== true) continue;
		const name = typeof check.name === "string" ? check.name.replace(/\s+/gu, " ").trim() : "";
		return name.length > 0 ? name : "the check";
	}
	return null;
}

/** The validation verdict for the run row: a check that passed only on the worker's word is `self-reported`. */
function validationOf(entry: WorkerEntryState): RunValidation {
	const grounding = entry.result?.trust?.validationGrounding;
	switch (grounding?.state) {
		case "validated":
			return "passed";
		case "failed":
			return "failed";
		case "ungrounded":
			return "self-reported";
		case "absent":
			return reportedPassingCheck(entry) !== null ? "self-reported" : "none";
		default:
			return "unknown";
	}
}

/** The record's integrity: verified by its seal, compromised when the seal broke, else unverified. */
function integrityOf(result: WorkerRunResultSummary): RunIntegrity {
	const state = result.trust?.artifactIntegrity?.state;
	return state === "verified" ? "verified" : state === "failed" ? "compromised" : "unverified";
}

/** Why a run that did not succeed stopped, in the words a person acts on. */
function failureReason(entry: WorkerEntryState): string {
	const result = entry.result as WorkerRunResultSummary;
	if (result.outcome === "stalled") return STALLED_RUN_HEADLINE;
	const headline = workerFailureHeadline(result.failureMessage);
	if (headline !== null) return headline;
	if (result.validationFailure !== undefined) return result.validationFailure;
	if (result.abandonedDetail !== undefined) return "abandoned";
	return plainOutcomeLabel(result.outcomeCode ?? result.outcome);
}

/** Outcome, validation and integrity of the entry as run facts; the run row computes the state from them. */
function runFactsOf(
	entry: WorkerEntryState,
	nowMs: number,
	task: string | undefined,
	telemetry?: RunTelemetryFacts,
): RunFacts {
	const elapsed = elapsedMs(entry);
	const base = {
		agent: identityName(entry),
		origin: workerAskedByModel(entry) ? ("model" as const) : ("operator" as const),
		...(entry.helper ? { helper: true } : {}),
		runId: entry.runId,
		...(elapsed === undefined ? {} : { elapsed: formatElapsed(elapsed) }),
		...(task === undefined ? {} : { task }),
		...(telemetry === undefined ? {} : { telemetry }),
	};
	// A checkpoint is a question the operator answers next, so the row waits on them as an ask does.
	if (workerNeedsInput(entry))
		return { ...base, outcome: "running", approval: { decider: "operator", words: () => "needs input" } };
	if (isPending(entry)) {
		const approval = approvalFacts(entry, nowMs);
		return { ...base, outcome: "running", phase: livePhase(entry, nowMs), ...(approval ? { approval } : {}) };
	}
	const result = entry.result as WorkerRunResultSummary;
	if (isStopping(result)) return { ...base, outcome: "cancelled", reason: "stopping" };
	if (result.outcome === "canceled") return { ...base, outcome: "cancelled" };
	if (result.outcome !== "succeeded") return { ...base, outcome: "failed", reason: failureReason(entry) };
	const unanswered = councilUnanswered(entry);
	if (unanswered > 0)
		return {
			...base,
			outcome: "succeeded",
			validation: "failed",
			reason: `partial: ${unanswered} ${unanswered === 1 ? "member" : "members"} gave no answer`,
		};
	const caveat = settledRunCaveat(result, answersByDesign(entry));
	if (caveat?.kind === "against")
		return {
			...base,
			outcome: "succeeded",
			validation: "failed",
			reason: result.validationFailure === undefined ? caveat.words : `${caveat.words}: ${result.validationFailure}`,
		};
	return { ...base, outcome: "succeeded", validation: validationOf(entry), integrity: integrityOf(result) };
}

/** The axes a whole trust record carries; a partial one is graded from what it has. */
const TRUST_AXES = [
	"artifactIntegrity",
	"validationGrounding",
	"independentReview",
	"contextProvenance",
	"completionEvidence",
] as const;

/** The trust record in one word for detailed rows: what a reader may lean on. */
function recordWord(result: WorkerRunResultSummary | undefined): string {
	const trust = result?.trust;
	const integrity = trust?.artifactIntegrity?.state;
	if (integrity === "failed") return "not trusted";
	if (trust === undefined || integrity !== "verified") return "unverified; raw output, not admitted as evidence";
	// A record that leaves an axis out cannot be graded whole; its validation still says what it can.
	const complete = TRUST_AXES.every((axis) => trust[axis] !== undefined);
	const verdict = complete
		? trustVerdict(trust)
		: trust.validationGrounding?.state === "validated"
			? "grounded"
			: "unverified";
	if (verdict === "compromised") return "not trusted";
	// A sealed record that nothing checked is not adverse; the check fact beside it says no check ran.
	return verdict === "unverified" ? trustStateWord("artifactIntegrity", "verified") : verdict;
}

/** What the run changed, from its sealed facts or its own report: `changed nothing`, `changed 3 files`. */
function changeWords(entry: WorkerEntryState): string | null {
	const result = entry.result;
	if (result === undefined || result.outcome === "canceled") return null;
	const structured = entry.droppedLines === 0 ? exactWorkerAnswerObject(entry.text) : null;
	const reported = structured?.mutatedPaths;
	const count =
		result.changedPaths?.length ??
		result.placement?.changedPaths?.length ??
		result.taskWorktree?.changedPaths ??
		(Array.isArray(reported) ? reported.length : undefined);
	if (count === undefined) return null;
	return count === 0 ? "changed nothing" : `changed ${count} ${count === 1 ? "file" : "files"}`;
}

/**
 * Whether anything checked the work, in plain words. A worker's own passing check names whose word it is instead
 * of denying it ran; no check ran is a fact, not an adverse verdict.
 */
function checkWords(entry: WorkerEntryState): string | null {
	const result = entry.result;
	if (result === undefined || result.outcome === "canceled") return null;
	const trust = result.trust;
	const grounding = trust?.validationGrounding;
	if (trust === undefined || grounding === undefined)
		return result.outcome === "succeeded" ? "validation unknown" : null;
	if (grounding.state === "absent") {
		if (result.outcome !== "succeeded") return null;
		if (answersByDesign(entry)) return null;
		const passing = reportedPassingCheck(entry);
		return passing !== null ? `${passing} passed on the worker's own report` : "no check ran";
	}
	// A failed validation is the row's own reason; the facts row does not say it twice.
	if (grounding.state === "failed") return null;
	return validationClause(trust);
}

/**
 * The settled facts row: what changed, whether a check ran, the calls and the tokens. `/view` adds the exit status,
 * the context and the result contract the transcript states by presenting a conforming answer.
 */
function factsRow(entry: WorkerEntryState, inspect: boolean): string[] {
	const result = entry.result;
	const refused = result?.refusedCalls ?? 0;
	const exitCode = result?.exitCode;
	const context = entry.telemetry?.activity.contextTokens;
	return [
		changeWords(entry),
		checkWords(entry),
		...(inspect && exitCode !== undefined && exitCode !== 0 ? [`exit ${exitCode}`] : []),
		callsWords(callCount(entry)),
		refused > 0 ? refusedCallsWords(refused, result?.guardedCalls ?? 0) : null,
		tokensWords(entry),
		inspect && context ? `context ${context.display}` : null,
		inspect && result?.contract !== undefined ? `contract ${result.contract}` : null,
	].filter((fact): fact is string => typeof fact === "string" && fact.length > 0);
}

/** The route, run id, attempt and trust record of a settled card, on their own row at detailed. */
function routeRow(entry: WorkerEntryState): string[] {
	const route = workerRoute(entry);
	return [
		...(route === undefined ? [] : [displayText(entry, "route", route)]),
		`run ${entry.runId}`,
		...(entry.attempts.length > 1 ? [`attempt ${entry.attempts.length}`] : []),
		`record: ${recordWord(entry.result)}`,
	];
}

/** The telemetry sub-line under a run: route, calls, tokens, then its last call live or its trust record settled. */
function telemetryFacts(entry: WorkerEntryState): RunTelemetryFacts {
	const route = workerRoute(entry);
	const calls = callCount(entry);
	const tokens = tokensWords(entry);
	const last = (entry.progress?.recentActions ?? entry.recentActions)?.[0];
	const pending = isPending(entry);
	return {
		...(route === undefined ? {} : { route: displayText(entry, "route", route) }),
		...(calls === undefined ? {} : { calls }),
		...(tokens === undefined ? {} : { tokens }),
		...(pending && last !== undefined ? { lastAction: finishedActionWords(last) } : {}),
		...(pending ? {} : { record: recordWord(entry.result) }),
	};
}

/** Paint the run row's cells: each cell's lead, then its glyph and text in its role. */
function paintCells(cells: readonly RunCell[], agentPaint?: (text: string) => string): string {
	let out = "";
	for (const cell of cells) {
		const glyph = cell.glyph === undefined ? "" : GLYPH[cell.glyph];
		const body =
			cell.slot === "agent" && agentPaint !== undefined
				? agentPaint(cell.text)
				: `${glyph}${cell.text}`.length === 0
					? ""
					: theme.fg(cell.role, `${glyph}${cell.text}`);
		out += `${cell.lead}${body}`;
	}
	return out;
}

/** Up to `limit` rows, then one fold row naming how many more there are and where they are. */
function foldRows(rows: readonly string[], limit: number, width: number, reference: string): string[] {
	if (rows.length <= limit) return [...rows];
	if (limit <= 0) return [];
	const hidden = rows.length - limit;
	const hint = `${GLYPH.ellipsis} ${hidden} ${hidden === 1 ? "row" : "rows"}${SEPARATOR}${reference}`;
	return [
		...rows.slice(0, limit),
		`${cardRail()}${meta(truncateToWidth(hint, Math.max(1, width - RAIL_WIDTH), GLYPH.ellipsis, false))}`,
	];
}

/**
 * A settled card's last calls, oldest first, then how many came before them. The row budget includes that
 * count's row.
 */
function trailRows(entry: WorkerEntryState, limit: number, width: number): string[] {
	const recent = entry.progress?.recentActions ?? entry.recentActions ?? [];
	const calls = trailCalls(recent);
	const total = Math.max(entry.result?.toolCalls ?? entry.progress?.toolCalls ?? 0, recent.length);
	const fits = calls.length <= limit && total <= recent.length;
	const shown = fits ? calls : calls.slice(Math.max(0, calls.length - Math.max(0, limit - 1)));
	const earlier = total - shown.reduce((sum, call) => sum + call.count, 0);
	const rows = shown.map(({ text, count }) => (count > 1 ? `${text} ${GLYPH.times}${count}` : text));
	if (earlier > 0)
		rows.push(
			`${GLYPH.ellipsis} ${earlier} earlier ${earlier === 1 ? "call" : "calls"}${SEPARATOR}/view dispatch:${entry.runId}`,
		);
	return rows.flatMap((row) => railLines(`${GLYPH.phaseTool} ${row}`, "body", width));
}

/** Run states a worker row under a dispatch header keeps at a tier that shows outcomes only. */
const NOTICED_STATES: ReadonlySet<RunStateKind> = new Set(["error", "warning", "pending"]);

interface CardContext {
	width: number;
	policy: TierPolicy;
	nowMs: number;
	inspect: boolean;
	terminalRows: number | undefined;
	/** The identity column when the card is a row of a dispatch or a council round; absent for a lone card. */
	identityWidth: number | undefined;
}

/**
 * A worker as its run row and the rows its tier adds. Under a dispatch header the row nests two cells in and states
 * the run; the header above it carries the counts. A lone card (`/run`, a helper under another call, `/view`)
 * adds its settled facts row, route row, answer and trail by tier.
 */
function workerCardRows(entry: WorkerEntryState, ctx: CardContext): string[] {
	const { policy, inspect, nowMs } = ctx;
	const nested = ctx.identityWidth !== undefined;
	// A helper the model runs reads as a run row wherever it lands; only a card of its own adds facts, route and trail.
	const rowOnly = (nested || entry.helper === true) && !inspect;
	const width = Math.max(1, nested ? ctx.width - NEST.length : ctx.width);
	const pending = isPending(entry);
	const needsInput = workerNeedsInput(entry);
	const outcomes = outcomesOnly(policy) && !inspect;
	const detailed = policy.runSubRows > 0;
	const facts = !rowOnly && !pending ? factsRow(entry, inspect) : [];
	// A lone settled card at compact is one row: its facts take the task's place.
	const compactFacts =
		outcomes && !rowOnly && !pending ? [changeWords(entry), checkWords(entry)].filter((fact) => fact !== null) : [];
	const task = compactFacts.length > 0 ? compactFacts.join(SEPARATOR) : taskText(entry);
	const subLine = detailed && (rowOnly || pending) ? telemetryFacts(entry) : undefined;
	const layout: RunRowLayout = runRow(runFactsOf(entry, nowMs, task, subLine), {
		width,
		identityWidth: ctx.identityWidth ?? identityWidthOf([entry]),
		measure: visibleWidth,
		continueReason: true,
		rail: true,
	});
	// Councils are their own round, not a dispatch card's tally, so every member keeps its row.
	if (nested && outcomes && entry.council === undefined && !NOTICED_STATES.has(layout.state.kind)) return [];
	const agentPaint =
		entry.council !== undefined ? (text: string) => councilLabelText(theme, text, entry.council?.color) : undefined;
	const budget = (limit: number) => (inspect ? Number.POSITIVE_INFINITY : previewBudget(limit, ctx.terminalRows));
	const reference = detailed ? `/view dispatch:${entry.runId}` : "/view";
	const answerRows =
		(!pending || inspect) && (needsInput || policy.workerRows > 0) && entry.text.length > 0 && (!rowOnly || detailed);
	const answer = answerRows
		? foldRows(
				(inspect
					? answerText(entry, pending ? stripDeadToolCallMarkup(entry.text) : entry.text).split("\n")
					: bodySourceLines(entry, facts.length > 0)
				).flatMap((line) => railLines(redactSecretString(line), needsInput ? "warning" : "assistantProse", width)),
				needsInput && !inspect ? CHECKPOINT_PREVIEW_ROWS : budget(policy.workerRows),
				width,
				reference,
			)
		: [];
	const trail =
		!rowOnly && !pending && (inspect || policy.runTrail > 0) ? trailRows(entry, budget(policy.runTrail), width) : [];
	const tools = !rowOnly && !pending && detailed && trail.length === 0 ? toolLine(entry, width) : null;
	const presented = !pending && (!rowOnly || detailed) ? presentedContractAnswer(entry)?.footer : undefined;
	const rows = [
		paintCells(layout.cells, agentPaint),
		...(layout.continuation === null ? [] : [paintCells(layout.continuation)]),
		...(layout.telemetry === null ? [] : [paintCells(layout.telemetry)]),
		...(!outcomes && facts.length > 0 ? railLines(joinFacts(facts), "toolMetadata", width) : []),
		...(!rowOnly && !pending && detailed ? railLines(joinFacts(routeRow(entry)), "metadata", width) : []),
		...(inspect ? [...inspectFailureLines(entry, width), ...inspectQualityLines(entry, width)] : []),
		...answer,
		...(outcomes ? [] : attemptLines(entry, width)),
		...trail,
		...(tools === null ? [] : [tools]),
		...cancelLines(entry, width),
		...(!outcomes && entry.result?.mergeDetail ? railLines(entry.result.mergeDetail, "success", width) : []),
		...keptWorktreeLines(entry, width),
		...(presented ? railLines(presented, "body", width) : []),
		...(entry.result?.abandonedDetail ? railLines(entry.result.abandonedDetail, "warning", width) : []),
		...(entry.result?.resultUnavailable ? railLines("result unavailable", "warning", width) : []),
		...(!outcomes && entry.droppedLines
			? railLines(`… ${entry.droppedLines} earlier lines unavailable here · /view dispatch:${entry.runId}`, "body", width)
			: []),
	];
	return nested ? rows.map((row) => `${NEST}${row}`) : rows;
}

export function renderWorkerEntryLines(
	entry: WorkerEntryState,
	width: number,
	options: WorkerEntryRenderOptions,
): string[] {
	entry = {
		...entry,
		telemetry: options.telemetry ?? null,
		routeFirstOutput: options.routeFirstOutput ?? null,
		cacheOwner: entry.cacheOwner ?? entry,
	};
	const safeWidth = Math.max(1, Math.floor(width));
	const inspect = options.unbounded === true;
	const detail = inspect ? transcriptDetail("detailed") : (options.detail ?? transcriptDetail());
	// The transcript slice the caller passed governs its own budgets; the tier table supplies the run budgets beside it.
	const policy: TierPolicy = { ...tierPolicy(detail.style), ...detail };
	const nowMs = options.nowMs ?? Date.now();
	// The first card of a council round carries the round's header row.
	const council =
		entry.council !== undefined && options.group !== "continues"
			? [councilHeader(entry, safeWidth, compactCouncilHint(entry, policy, safeWidth, nowMs, options.siblings))]
			: [];
	const siblings = inspect ? undefined : (options.siblings ?? (entry.council !== undefined ? [entry] : undefined));
	const rows = workerCardRows(entry, {
		width: safeWidth,
		policy,
		nowMs,
		inspect,
		terminalRows: options.terminalRows,
		identityWidth: siblings === undefined ? undefined : identityWidthOf(siblings.length > 0 ? siblings : [entry]),
	});
	return [...council, ...rows].map((row) => redactedRow(row, safeWidth));
}

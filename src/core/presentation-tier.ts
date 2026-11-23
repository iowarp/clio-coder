/**
 * The presentation tier contract: one table of named budgets per tier, the process-wide current tier and its change
 * signal. Surfaces read budgets from here and never compare the tier to a literal. The tier bounds how much evidence a
 * surface shows inline; it never changes what is true, what is blocked, which keys work or where focus starts.
 */
import type { OutputStyle } from "./defaults.js";

/** Which tool rows state their duration: none, those of one second and longer, or every one. */
export type ToolDurationBudget = "never" | "long" | "always";
/** A call this long or longer shows its duration under the `long` budget. */
export const LONG_TOOL_DURATION_MS = 1_000;
export type ReceiptBudget = "outcome" | "summary" | "full";
export type BoardColumn = "state" | "agent" | "time" | "text" | "in" | "out" | "cost" | "node" | "account";
export type BoardFact = "doing" | "task" | "slots" | "started";
export type NoticeFloor = "warning" | "info";
export type PickerDetail = "status" | "facts" | "pane";
export type ListDescriptions = "focused" | "all";
export type UsageSections = "totals" | "breakdown" | "provenance";

export interface TierPolicy {
	tier: OutputStyle;
	/**
	 * Whether a surface adds the bounded evidence a reader needs to trust an outcome without opening anything: the facts
	 * beside each state and short previews of what changed (section 3, standard and up). Without it a surface shows
	 * outcomes only.
	 */
	evidence: boolean;
	/** Whether a surface adds provenance and telemetry: routes, ids, accounting, trust records (section 3, detailed). */
	provenance: boolean;
	/** Rows of reasoning shown before CLIO Coder's words and while reasoning streams; 0 folds it to a marker. */
	reasoningRows: number;
	/** Rows of reasoning shown before an action; 0 folds it to a marker, 1 keeps one line of its last paragraph. */
	reasoningBeforeActionRows: number;
	invocationRows: number;
	resultRows: number;
	liveResultRows: number;
	bashRows: number;
	operatorBashRows: number;
	diffRows: number;
	errorRows: number;
	receipt: ReceiptBudget;
	toolDurations: ToolDurationBudget;
	/** Whether a tool card adds a row for the arguments its header does not consume. */
	toolArgRow: boolean;
	/** Answer preview rows of a worker card. */
	workerRows: number;
	workerActivity: boolean;
	/** Telemetry rows under a run on the dispatch card, worker card, dock and pane. */
	runSubRows: number;
	/** Worker tool trail rows on the worker card and pane detail. */
	runTrail: number;
	/** Run rows of the fleet dock; 0 keeps only its summary row. */
	dockRuns: number;
	/** Fleet Runs and `/usage` Workers columns; node and account show only when the data has them. */
	boardColumns: readonly BoardColumn[];
	/** Facts of the selected Fleet Runs run; `all` shows every fact the run has. */
	boardFacts: readonly BoardFact[] | "all";
	/** Physical rows per run card in the workers dock pane. */
	paneCardRows: number;
	statusRows: number;
	hintRow: boolean;
	tips: boolean;
	/** Lowest notice level the footer notice row shows; alerts ignore it. */
	noticeFloor: NoticeFloor;
	dashboardRows: number;
	/** Launchpad fact rows, brand excluded. */
	welcomeRows: number;
	/** Physical rows of the exit summary for a terminal this many rows tall. */
	exitRows: (terminalRows: number) => number;
	pickerDetail: PickerDetail;
	listDescriptions: ListDescriptions;
	decisionPreviewRows: number;
	usageSections: UsageSections;
	/** Message rows of the steering queue island; 0 keeps its one summary row. */
	queueRows: number;
	/** Whether each queued message row states its mode (steer or later) and its age. */
	queueRowDetail: boolean;
	/** Whether a transcript notice keeps its subsystem tag (`[model]`, `[context engine]`). */
	noticeSourceTag: boolean;
	/** Whether a settled compaction card lists its measured facts (the entry count) as body rows. */
	contextBodyFacts: boolean;
	/** Whether a settled context operation card adds its summary notice text as a body row. */
	contextBodyDetail: boolean;
}

const BASE_COLUMNS: readonly BoardColumn[] = ["state", "agent", "time", "text"];
const TOKEN_COLUMNS: readonly BoardColumn[] = [...BASE_COLUMNS, "in", "out"];

const POLICIES: Readonly<Record<OutputStyle, TierPolicy>> = {
	compact: {
		tier: "compact",
		evidence: false,
		provenance: false,
		reasoningRows: 0,
		reasoningBeforeActionRows: 0,
		invocationRows: 4,
		resultRows: 0,
		liveResultRows: 0,
		bashRows: 0,
		operatorBashRows: 3,
		diffRows: 0,
		errorRows: 4,
		receipt: "outcome",
		toolDurations: "never",
		toolArgRow: false,
		workerRows: 0,
		workerActivity: false,
		runSubRows: 0,
		runTrail: 0,
		dockRuns: 0,
		boardColumns: BASE_COLUMNS,
		boardFacts: ["doing", "task"],
		paneCardRows: 1,
		statusRows: 1,
		hintRow: false,
		tips: false,
		noticeFloor: "warning",
		dashboardRows: 2,
		welcomeRows: 1,
		exitRows: () => 5,
		pickerDetail: "status",
		listDescriptions: "focused",
		decisionPreviewRows: 2,
		usageSections: "totals",
		queueRows: 0,
		queueRowDetail: false,
		noticeSourceTag: false,
		contextBodyFacts: false,
		contextBodyDetail: false,
	},
	standard: {
		tier: "standard",
		evidence: true,
		provenance: false,
		reasoningRows: 3,
		reasoningBeforeActionRows: 1,
		invocationRows: 8,
		resultRows: 0,
		liveResultRows: 6,
		bashRows: 3,
		operatorBashRows: 6,
		diffRows: 8,
		errorRows: 4,
		receipt: "summary",
		toolDurations: "long",
		toolArgRow: false,
		workerRows: 3,
		workerActivity: false,
		runSubRows: 0,
		runTrail: 0,
		dockRuns: 3,
		boardColumns: TOKEN_COLUMNS,
		boardFacts: ["doing", "task", "slots", "started"],
		paneCardRows: 2,
		statusRows: 1,
		hintRow: true,
		tips: true,
		noticeFloor: "info",
		dashboardRows: 4,
		welcomeRows: 5,
		exitRows: () => 12,
		pickerDetail: "facts",
		listDescriptions: "all",
		decisionPreviewRows: 6,
		usageSections: "breakdown",
		queueRows: 3,
		queueRowDetail: false,
		noticeSourceTag: false,
		contextBodyFacts: true,
		contextBodyDetail: false,
	},
	detailed: {
		tier: "detailed",
		evidence: true,
		provenance: true,
		reasoningRows: 12,
		reasoningBeforeActionRows: 12,
		invocationRows: 18,
		resultRows: 8,
		liveResultRows: 16,
		bashRows: 12,
		operatorBashRows: 12,
		diffRows: 20,
		errorRows: 12,
		receipt: "full",
		toolDurations: "always",
		toolArgRow: true,
		workerRows: 8,
		workerActivity: true,
		runSubRows: 1,
		runTrail: 3,
		dockRuns: 5,
		boardColumns: [...TOKEN_COLUMNS, "cost", "node", "account"],
		boardFacts: "all",
		paneCardRows: 3,
		statusRows: 2,
		hintRow: true,
		tips: true,
		noticeFloor: "info",
		dashboardRows: 6,
		welcomeRows: 8,
		exitRows: (terminalRows) => Math.max(1, Math.min(terminalRows - 2, 24)),
		pickerDetail: "pane",
		listDescriptions: "all",
		decisionPreviewRows: 12,
		usageSections: "provenance",
		queueRows: 3,
		queueRowDetail: true,
		noticeSourceTag: true,
		contextBodyFacts: true,
		contextBodyDetail: true,
	},
};

let current: OutputStyle = "standard";
let revision = 0;
const listeners = new Set<(tier: OutputStyle) => void>();

/** The tier the operator chose for this process. */
export function presentationTier(): OutputStyle {
	return current;
}

/** The budgets of `tier`, or of the current tier when none is named. */
export function tierPolicy(tier: OutputStyle = current): TierPolicy {
	return POLICIES[tier];
}

/** A counter that rises on every tier change; a renderer that memoizes lines puts it in its key. */
export function tierRevision(): number {
	return revision;
}

/** Calls `listener` after every tier change; the returned function unsubscribes it. */
export function onPresentationTierChange(listener: (tier: OutputStyle) => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

/**
 * Makes `tier` current. A change bumps the revision and notifies each listener once; setting the tier already current
 * changes nothing, so a caller may sync after any settings commit without invalidating memos.
 */
export function setPresentationTier(tier: OutputStyle): void {
	if (tier === current) return;
	current = tier;
	revision += 1;
	for (const listener of [...listeners]) listener(tier);
}

import {
	describeTaskMemoryActivity,
	formatTaskMemorySpend,
	type MemoryProposalResult,
	type MemoryRecord,
	type TaskMemoryActivityEvent,
	type TaskMemoryEntry,
	type TaskMemoryOperatorStatus,
	type TaskMemorySnapshot,
	type TaskMemoryTelemetryDecision,
} from "../domains/memory/index.js";
import type { Component, OverlayHandle, TUI } from "../engine/tui.js";
import { clockLocal } from "./format-time.js";
import { showClioOverlayFrame } from "./overlay-frame.js";
import { type ListOverlayItem, ListOverlayView } from "./overlays/list-overlay.js";
import { clioTheme, fitUnits, rule } from "./theme/index.js";

const DEFAULT_CONTENT_WIDTH = 96;
const REFRESH_MS = 1_000;

export const MEMORY_OVERLAY_WIDTH = DEFAULT_CONTENT_WIDTH + 4;

const EMPTY_MESSAGE = "no durable lessons, task-bank entries, or memory steps captured yet.";

/**
 * The one-line header that stays above the list.
 *
 * `step running` rides here rather than in a row because a detached step has no
 * row of its own until it finishes, and an operator who cannot see it in flight
 * reads an unchanged bank as an idle memory agent.
 */
function formatMemoryStatusLine(status: TaskMemoryOperatorStatus, contentWidth: number): string {
	const theme = clioTheme();
	const width = Math.max(1, Math.floor(contentWidth));
	const units = [
		theme.fg(status.enabled ? "success" : "annotation", `memory ${status.enabled ? "on" : "off"}`),
		theme.fg("fieldValue", `tier ${status.tier === "llm" ? "LLM" : "rules"}`),
		theme.fg("counter", `bank ${status.size}`),
		theme.fg("fieldValue", `last ${status.lastDecision ?? "none"}`),
	];
	if (status.stepInFlight) units.push(theme.fg("activity", "step running"));
	// Lifetime cost of the background plane, beside the state of the current
	// session. The tier spent 137,205 tokens over 14 days on the operator's own
	// machine before any surface said so (#229), and a hit rate is the one figure
	// that says whether that spend is buying anything.
	const spend = status.spend === null || status.spend === undefined ? "" : formatTaskMemorySpend(status.spend);
	if (spend.length > 0) units.push(theme.fg("annotation", spend));
	return fitUnits(theme, "", units, width);
}

function bankEntries(snapshot: TaskMemorySnapshot): TaskMemoryEntry[] {
	return [...(snapshot.status === null ? [] : [snapshot.status]), ...snapshot.knowledge, ...snapshot.procedural];
}

function firstLine(content: string): string {
	return content.replace(/\s+/gu, " ").trim();
}

function entryClassLabel(entry: TaskMemoryEntry): string {
	return entry.kind === "status" ? "status (private)" : entry.kind;
}

function lessonItems(records: ReadonlyArray<MemoryRecord>, group: string): ListOverlayItem[] {
	const theme = clioTheme();
	return records.map((record) => ({
		id: `lesson:${record.id}`,
		label: firstLine(record.lesson),
		meta: theme.fg("annotation", `${record.scope}:${record.key}`),
		group,
		detail: () => [
			`# ${record.id}`,
			`**Scope:** ${record.scope}:${record.key}`,
			`**Confidence:** ${record.confidence}`,
			`**Created:** ${record.createdAt}`,
			...(record.evidenceRefs.length > 0 ? [`**Evidence:** ${record.evidenceRefs.join(", ")}`] : []),
			...(record.appliesWhen.length > 0 ? [`**Applies when:** ${record.appliesWhen.join("; ")}`] : []),
			...(record.avoidWhen.length > 0 ? [`**Avoid when:** ${record.avoidWhen.join("; ")}`] : []),
			"",
			"---",
			"",
			record.lesson,
		],
	}));
}

function bankItems(entries: ReadonlyArray<TaskMemoryEntry>, group: string): ListOverlayItem[] {
	const theme = clioTheme();
	return entries.map((entry) => ({
		id: `bank:${entry.id}`,
		label: firstLine(entry.content),
		meta: theme.fg("annotation", `${entryClassLabel(entry)} · injected ${entry.injectionCount}`),
		group,
		detail: () => [
			`# ${entry.id}`,
			`**Class:** ${entryClassLabel(entry)}`,
			`**Injected:** ${entry.injectionCount}`,
			`**Created:** ${entry.createdAt}`,
			`**Last touched:** ${entry.lastTouchedAt}`,
			"",
			"---",
			"",
			entry.content,
		],
	}));
}

/**
 * The row clock, in the timezone the operator's own clock is in.
 *
 * `event.at` is an ISO-8601 UTC instant, so slicing `HH:MM:SS` out of it
 * printed a UTC clock with no marker saying so: a step captured at 06:18 CDT
 * rendered as 11:18 and read as five hours stale. The detail pane keeps the
 * ISO string, so converting here is what makes the two surfaces agree.
 */
function rowClock(at: string): string {
	return Number.isFinite(Date.parse(at)) ? clockLocal(at) : at;
}

function activityItems(events: ReadonlyArray<TaskMemoryActivityEvent>, group: string): ListOverlayItem[] {
	const theme = clioTheme();
	return events.map((event, index) => ({
		id: `step:${index}:${event.at}`,
		label: `${theme.fg("annotation", rowClock(event.at))} ${theme.fg(
			decisionToken(event.decision),
			describeTaskMemoryActivity(event),
		)}`,
		meta: theme.fg("annotation", `${event.tier} ${Math.round(event.latencyMs)}ms`),
		group,
		detail: () => [
			`# ${event.at}`,
			`**Decision:** ${event.decision} (${event.reason})`,
			`**Triggers:** ${event.triggerReasons.join(", ")}`,
			`**Tier:** ${event.tier}`,
			`**Latency:** ${Math.round(event.latencyMs)}ms`,
			`**Bank writes:** ${event.bankWrites}`,
			`**Cited entries:** ${event.citedEntries}`,
		],
	}));
}

/**
 * Every memory row the operator can reach, as one grouped list.
 *
 * The counts live in the group headers because the static dump printed them as
 * section titles and they are the only place a reader learns that a class is
 * empty: a group with no rows renders no header at all.
 */
function buildMemoryOverlayItems(
	status: TaskMemoryOperatorStatus,
	records: ReadonlyArray<MemoryRecord>,
): ListOverlayItem[] {
	const approved = records.filter((record) => recordReviewState(record) === "approved");
	const pending = records.filter((record) => recordReviewState(record) === "pending");
	const rejected = records.filter((record) => recordReviewState(record) === "rejected");
	const entries = bankEntries(status.bank);
	return [
		...lessonItems(approved, `approved lessons (${approved.length})`),
		...lessonItems(pending, `pending review (${pending.length})`),
		...lessonItems(rejected, `rejected (${rejected.length})`),
		...bankItems(entries, `task bank (${status.size})`),
		...activityItems(status.activity, `recent steps (${status.activity.length})`),
	];
}

type RecordReviewState = "approved" | "pending" | "rejected";

/** Rejection is stamped, so an unapproved record without the stamp still awaits review. */
function recordReviewState(record: MemoryRecord): RecordReviewState {
	if (record.rejectedAt !== undefined) return "rejected";
	return record.approved ? "approved" : "pending";
}

function decisionToken(decision: TaskMemoryTelemetryDecision): "success" | "warning" | "annotation" {
	if (decision === "injected") return "success";
	return decision === "silent" ? "annotation" : "warning";
}

/**
 * A signature of everything the rows are built from.
 *
 * The overlay repaints once a second whether or not memory moved. Rebuilding
 * the item array on every one of those frames would hand the list a fresh
 * array each time, which resets nothing by itself but defeats both the list's
 * render memo and the frame's identity cache; keying the rebuild on the data
 * means an idle second costs one string compare.
 */
function memorySignature(status: TaskMemoryOperatorStatus, records: ReadonlyArray<MemoryRecord>): string {
	const parts = [
		status.enabled ? "on" : "off",
		status.tier,
		String(status.size),
		status.lastDecision ?? "none",
		status.stepInFlight ? "running" : "idle",
		`${status.spend?.llmSteps ?? 0}:${status.spend?.injections ?? 0}:${status.spend?.totalTokens ?? 0}`,
	];
	for (const record of records) parts.push(`r:${record.id}:${record.approved}:${record.rejectedAt ?? ""}`);
	for (const entry of bankEntries(status.bank)) {
		parts.push(`e:${entry.id}:${entry.lastTouchedAt}:${entry.injectionCount}`);
	}
	for (const event of status.activity) parts.push(`a:${event.at}:${event.decision}`);
	return parts.join("|");
}

export type MemoryReviewAction = "approve" | "reject";

interface MemoryOverlayActions {
	onPromote?: (entry: TaskMemoryEntry, scope: "repo" | "global") => Promise<MemoryProposalResult>;
	onReview?: (record: MemoryRecord, action: MemoryReviewAction) => Promise<MemoryRecord>;
}

interface OpenMemoryOverlayOptions extends MemoryOverlayActions {
	onClose?: () => void;
}

/** Master-detail memory view: status header, grouped list, scrollable detail pane. */
export class MemoryOverlayView implements Component {
	private readonly list: ListOverlayView;
	private signature: string | null = null;
	private renderMemo: { width: number; status: string; listLines: string[]; lines: string[] } | null = null;
	private pendingGlobalEntryId: string | null = null;
	private promotionMessage: { token: "activity" | "warning" | "success" | "error"; text: string } | null = null;
	private promotionInFlight = false;

	constructor(
		private readonly getStatus: () => TaskMemoryOperatorStatus,
		private readonly getRecords: () => ReadonlyArray<MemoryRecord>,
		onClose: () => void,
		onChange: () => void,
		private readonly handlers: MemoryOverlayActions = {},
	) {
		const actions: Record<string, (item: ListOverlayItem) => void> = {};
		if (handlers.onPromote) {
			actions.p = (item) => this.promote(item, "repo", onChange);
			actions.g = (item) => this.promote(item, "global", onChange);
		}
		if (handlers.onReview) {
			actions.a = (item) => this.review(item, "approve", onChange);
			actions.x = (item) => this.review(item, "reject", onChange);
		}
		this.list = new ListOverlayView(
			{
				title: "Memory",
				items: [],
				filterable: true,
				layout: "split",
				emptyMessage: EMPTY_MESSAGE,
				...(Object.keys(actions).length > 0 ? { hints: (item) => this.hintsFor(item), actions } : {}),
				onClose,
			},
			onChange,
		);
	}

	getHint(): string {
		this.sync();
		return this.list.getHint();
	}

	render(width: number): string[] {
		const status = this.sync();
		const statusLine = formatMemoryStatusLine(status, width);
		const promotionLine =
			this.promotionMessage === null
				? null
				: fitUnits(clioTheme(), "", [clioTheme().fg(this.promotionMessage.token, this.promotionMessage.text)], width);
		const statusKey = promotionLine === null ? statusLine : `${statusLine}\n${promotionLine}`;
		const listLines = this.list.render(width);
		const memo = this.renderMemo;
		if (memo && memo.width === width && memo.status === statusKey && memo.listLines === listLines) return memo.lines;
		const lines = [
			statusLine,
			...(promotionLine === null ? [] : [promotionLine]),
			rule(clioTheme(), width),
			...listLines,
		];
		this.renderMemo = { width, status: statusKey, listLines, lines };
		return lines;
	}

	handleInput(data: string): void {
		// A key that lands between the refresh and the repaint must act on the rows
		// the operator is looking at, so the sync happens before the routing.
		this.sync();
		this.list.handleInput(data);
	}

	invalidate(): void {
		this.renderMemo = null;
		this.list.invalidate();
	}

	private sync(): TaskMemoryOperatorStatus {
		const status = this.getStatus();
		const records = this.getRecords();
		const signature = memorySignature(status, records);
		if (signature !== this.signature) {
			this.signature = signature;
			this.list.setItems(buildMemoryOverlayItems(status, records));
		}
		return status;
	}

	/** Only the keys the selected row answers to, so a lesson row never advertises promotion. */
	private hintsFor(item: ListOverlayItem | undefined): ReadonlyArray<{ key: string; verb: string }> {
		if (item === undefined) return [];
		if (item.id.startsWith("bank:") && this.handlers.onPromote) {
			return [
				{ key: "p", verb: "propose repo" },
				{ key: "g", verb: "propose global" },
			];
		}
		const record = this.handlers.onReview ? this.selectedRecord(item) : null;
		if (record === null) return [];
		const state = recordReviewState(record);
		return [
			...(state === "approved" ? [] : [{ key: "a", verb: "approve" }]),
			...(state === "rejected" ? [] : [{ key: "x", verb: "reject" }]),
		];
	}

	private review(item: ListOverlayItem, action: MemoryReviewAction, onChange: () => void): void {
		const onReview = this.handlers.onReview;
		if (onReview === undefined || this.promotionInFlight) return;
		this.pendingGlobalEntryId = null;
		const record = this.selectedRecord(item);
		const state = record === null ? null : recordReviewState(record);
		if (record === null || state === (action === "approve" ? "approved" : "rejected")) {
			this.promotionMessage = {
				token: "warning",
				text:
					record === null
						? "select a durable memory record"
						: `${record.id} is already ${action === "approve" ? "approved" : "rejected"}`,
			};
			this.invalidate();
			onChange();
			return;
		}
		this.promotionInFlight = true;
		this.promotionMessage = {
			token: "activity",
			text: `${action === "approve" ? "approving" : "rejecting"} ${record.id}`,
		};
		this.invalidate();
		onChange();
		void onReview(record, action)
			.then((updated) => {
				this.promotionMessage = {
					token: "success",
					text: `${action === "approve" ? "approved" : "rejected"} ${updated.id}`,
				};
			})
			.catch((error: unknown) => {
				this.promotionMessage = {
					token: "error",
					text: `${action} failed: ${error instanceof Error ? error.message : String(error)}`,
				};
			})
			.finally(() => {
				this.promotionInFlight = false;
				this.invalidate();
				onChange();
			});
	}

	private selectedRecord(item: ListOverlayItem): MemoryRecord | null {
		if (!item.id.startsWith("lesson:")) return null;
		const recordId = item.id.slice("lesson:".length);
		return this.getRecords().find((record) => record.id === recordId) ?? null;
	}

	private promote(item: ListOverlayItem, scope: "repo" | "global", onChange: () => void): void {
		const onPromote = this.handlers.onPromote;
		if (onPromote === undefined || this.promotionInFlight) return;
		const entry = this.selectedBankEntry(item);
		if (entry === null) {
			this.pendingGlobalEntryId = null;
			this.promotionMessage = { token: "warning", text: "select a knowledge or procedural task-bank entry" };
			this.invalidate();
			onChange();
			return;
		}
		if (scope === "global" && this.pendingGlobalEntryId !== entry.id) {
			this.pendingGlobalEntryId = entry.id;
			this.promotionMessage = {
				token: "warning",
				text: `global scope broadens applicability for ${entry.id}; press g again to acknowledge`,
			};
			this.invalidate();
			onChange();
			return;
		}
		this.pendingGlobalEntryId = null;
		this.promotionInFlight = true;
		this.promotionMessage = { token: "activity", text: `proposing ${entry.id} with ${scope} scope` };
		this.invalidate();
		onChange();
		void onPromote(entry, scope)
			.then((result) => {
				const approval = this.handlers.onReview
					? "review it under pending review, then press a to approve"
					: `review, then run clio-coder memory approve ${result.record.id}`;
				this.promotionMessage = {
					token: "success",
					text: `${result.created ? "proposed" : "found existing"} ${result.record.id}; ${approval}`,
				};
			})
			.catch((error: unknown) => {
				this.promotionMessage = {
					token: "error",
					text: `promotion failed: ${error instanceof Error ? error.message : String(error)}`,
				};
			})
			.finally(() => {
				this.promotionInFlight = false;
				this.invalidate();
				onChange();
			});
	}

	private selectedBankEntry(item: ListOverlayItem): TaskMemoryEntry | null {
		if (!item.id.startsWith("bank:")) return null;
		const entryId = item.id.slice("bank:".length);
		const entry = bankEntries(this.getStatus().bank).find((candidate) => candidate.id === entryId);
		if (entry === undefined || entry.kind === "status") return null;
		return entry;
	}
}

/** Mount durable lessons and the live task bank with promotion and review actions. */
export function openMemoryOverlay(
	tui: TUI,
	getStatus: () => TaskMemoryOperatorStatus,
	getRecords: () => ReadonlyArray<MemoryRecord>,
	options: OpenMemoryOverlayOptions = {},
): OverlayHandle {
	const view = new MemoryOverlayView(
		getStatus,
		getRecords,
		() => options.onClose?.(),
		() => tui.requestRender(),
		{
			...(options.onPromote ? { onPromote: options.onPromote } : {}),
			...(options.onReview ? { onReview: options.onReview } : {}),
		},
	);
	const handle = showClioOverlayFrame(tui, view, {
		anchor: "center",
		width: MEMORY_OVERLAY_WIDTH,
		markerId: "memory",
		title: () => "Memory",
		footerHint: () => view.getHint(),
	});
	const timer = setInterval(() => tui.requestRender(), REFRESH_MS);
	timer.unref?.();
	return {
		...handle,
		hide(): void {
			clearInterval(timer);
			handle.hide();
		},
	};
}

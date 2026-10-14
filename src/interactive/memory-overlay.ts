import {
	describeTaskMemoryActivity,
	eligibleMemoryRecords,
	formatTaskMemorySpend,
	type MemoryAgentIdentity,
	type MemoryPromptSelection,
	type MemoryProposalResult,
	type MemoryRecord,
	type MemoryRepositoryIdentity,
	type MemoryRuntimeIdentity,
	type TaskMemoryActivityEvent,
	type TaskMemoryEntry,
	type TaskMemoryOperatorStatus,
	type TaskMemoryTelemetryDecision,
} from "../domains/memory/index.js";
import type { Component, OverlayHandle, TUI } from "../engine/tui.js";
import { truncateToWidth } from "../engine/tui.js";
import { clockLocal } from "./format-time.js";
import {
	memoryBankEntries,
	memoryLessonDetail,
	memoryReach,
	memoryReviewState,
	memoryTaskDetail,
	memoryViewSignature,
} from "./memory-view-model.js";
import { showClioOverlayFrame } from "./overlay-frame.js";
import { type ListOverlayItem, ListOverlayView } from "./overlays/list-overlay.js";
import { clioTheme, fitUnits, rule } from "./theme/index.js";
import { skinEpoch } from "./theme/tokens.js";

const DEFAULT_CONTENT_WIDTH = 96;
const REFRESH_MS = 1_000;

export const MEMORY_OVERLAY_WIDTH = DEFAULT_CONTENT_WIDTH + 4;

function firstLine(content: string): string {
	return content.replace(/\s+/gu, " ").trim();
}

function lessonItems(
	records: ReadonlyArray<MemoryRecord>,
	eligible: ReadonlySet<string>,
	group: string,
	selection: MemoryPromptSelection | null,
): ListOverlayItem[] {
	const theme = clioTheme();
	return records.map((record) => {
		const reach = memoryReach(record, eligible.has(record.id));
		return {
			id: `lesson:${record.id}`,
			label: firstLine(record.lesson),
			meta: theme.fg(
				"annotation",
				reach !== "none"
					? `${record.scope === "repo" ? "this repo" : record.scope} · ${reach === "prompt" ? "prompt" : "recall only"}`
					: record.rejectedAt
						? "rejected"
						: record.regressions?.length
							? "contradicted"
							: !record.approved
								? "pending"
								: record.scope === "agent"
									? "workers"
									: "excluded",
			),
			group,
			detail: () => memoryLessonDetail(record, eligible.has(record.id), selection),
		};
	});
}

function bankItems(entries: ReadonlyArray<TaskMemoryEntry>): ListOverlayItem[] {
	const theme = clioTheme();
	return entries.map((entry) => ({
		id: `bank:${entry.id}`,
		label: firstLine(entry.content),
		meta: theme.fg("annotation", entry.kind === "status" ? "private · session only" : "session only"),
		group:
			entry.kind === "status"
				? "Private status"
				: entry.kind === "procedural"
					? "Attempts and outcomes"
					: "Task knowledge",
		detail: () => memoryTaskDetail(entry),
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
			...(event.resumeAt === undefined ? [] : [`**Resumes:** ${event.resumeAt}`]),
		],
	}));
}

function decisionToken(decision: TaskMemoryTelemetryDecision): "success" | "warning" | "annotation" {
	if (decision === "injected") return "success";
	return decision === "silent" ? "annotation" : "warning";
}

export type MemoryReviewAction = "approve" | "reject";

interface MemoryOverlayActions {
	activeRepository?: () => MemoryRepositoryIdentity | null;
	activeRuntime?: () => MemoryRuntimeIdentity | null;
	activeAgent?: () => MemoryAgentIdentity | null;
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
	private rows: Record<string, ListOverlayItem[]> = { lessons: [], task: [], review: [], diagnostics: [] };
	private currentRepository: MemoryRepositoryIdentity | null = null;

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
				explicitSearch: true,
				layout: "split",
				tabs: [
					{ id: "lessons", label: "Lessons", items: () => this.rows.lessons ?? [] },
					{ id: "task", label: "This task", items: () => this.rows.task ?? [] },
					{ id: "review", label: "Review", items: () => this.rows.review ?? [] },
					{ id: "diagnostics", label: "Diagnostics", items: () => this.rows.diagnostics ?? [] },
				],
				emptyMessage: () => this.emptyMessage(),
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
		const scope = this.currentRepository ? "this repository" : "repository unknown";
		const header = `Inspect memory · ${scope} · background ${status.enabled ? "on" : "off"}`;
		const statusLine = truncateToWidth(clioTheme().fg("annotation", header), width, "…", false);
		const promotionLine =
			this.promotionMessage === null
				? null
				: fitUnits(clioTheme(), "", [clioTheme().fg(this.promotionMessage.token, this.promotionMessage.text)], width);
		const statusKey = [statusLine, promotionLine].filter((line) => line !== null).join("\n");
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

	private emptyMessage(): string {
		switch (this.list.activeTab()?.id) {
			case "task":
				return "No current task state captured. Private status stays within this session.";
			case "review":
				return "No candidates or excluded lessons to review.";
			case "diagnostics":
				return "No memory diagnostics captured.";
			default:
				return "No eligible lessons for this session. Memory runs in the background; opening this view does not activate it.";
		}
	}

	private sync(): TaskMemoryOperatorStatus {
		const status = this.getStatus();
		const records = this.getRecords();
		const activeRepository = this.handlers.activeRepository?.() ?? null;
		const activeRuntime = this.handlers.activeRuntime?.() ?? null;
		const activeAgent = this.handlers.activeAgent?.() ?? null;
		// The same gates memory_recall applies; the prompt narrows them to its own scopes.
		const eligibility = { activeRepository, activeRuntime, activeAgent };
		const signature = `${skinEpoch()}|${memoryViewSignature(status, records, eligibility)}`;
		if (signature !== this.signature) {
			this.signature = signature;
			this.currentRepository = activeRepository;
			const eligible = eligibleMemoryRecords(records, eligibility).filter((record) => record.rejectedAt === undefined);
			const ids = new Set(eligible.map((record) => record.id));
			const review = records.filter((record) => !ids.has(record.id));
			this.rows = {
				lessons: lessonItems(eligible, ids, "Reusable lessons", status.promptSelection ?? null),
				task: bankItems(memoryBankEntries(status.bank)),
				review: lessonItems(review, ids, "Candidates and excluded lessons", status.promptSelection ?? null),
				diagnostics: this.diagnosticItems(status),
			};
			this.list.refreshTabs();
		}
		return status;
	}

	private diagnosticItems(status: TaskMemoryOperatorStatus): ListOverlayItem[] {
		const row = (id: string, label: string, detail: string[]): ListOverlayItem => ({
			id: `diagnostic:${id}`,
			label,
			group: "Background operation",
			detail: () => detail,
		});
		const observations = status.observations;
		const retention = status.retention;
		return [
			row(
				"route",
				`Background memory ${status.enabled ? "on" : "off"} · ${status.stepInFlight ? "step running" : (status.guardian ?? "idle")}`,
				[
					"## Background memory",
					`Enabled: ${status.enabled}`,
					`Tier: ${status.tier}`,
					`Guardian: ${status.guardian ?? "not recorded"}`,
					`Last decision: ${status.lastDecision ?? "none"}`,
					...(status.route
						? [
								`Route: ${status.route.target ?? "unset"}/${status.route.model ?? "unset"}`,
								`Route source: ${status.route.source}`,
							]
						: []),
					...(status.lastSkip
						? [`Skipped: ${status.lastSkip.reason}`, `Resumes: ${status.lastSkip.resumeAt ?? "on a later wake"}`]
						: []),
					"",
					"This view inspects existing behavior. It does not activate memory or certify that a reminder affected a task.",
				],
			),
			...(retention
				? [
						row("retention", `Lesson retention: ${retention.phase}${retention.reason ? ` · ${retention.reason}` : ""}`, [
							"## Lesson retention",
							`Phase: ${retention.phase}`,
							`Reason: ${retention.reason ?? "none"}`,
							`Extracted candidates: ${retention.extracted}`,
							`Retained entries: ${retention.retained.length}`,
							`Extraction attempts: ${retention.attempts}`,
							...retention.retained.map((record) => `- [${record.id}] ${record.text}`),
						]),
					]
				: []),
			...(observations
				? [
						row(
							"observations",
							`Continuity preparation: ${observations.enabled ? "on" : "off"}${observations.lastReason ? ` · ${observations.lastReason}` : ""}`,
							[
								"## Continuity preparation",
								"Prepared observations help the existing compactor. They are separate from reusable lessons.",
								`Unobserved units: ${observations.unobserved}`,
								`Ready batches: ${observations.ready}`,
								`Offered batches: ${observations.offered}`,
								`Consumed batches: ${observations.consumed}`,
								`Source tokens: ${observations.sourceTokens}`,
								`Note tokens: ${observations.noteTokens}`,
								`Reflection: ${observations.reflection}`,
								`Last reason: ${observations.lastReason ?? "none"}`,
								`Last committed checkpoint: ${observations.lastCommit ?? "none"}`,
							],
						),
					]
				: []),
			...(status.spend
				? [
						row("spend", formatTaskMemorySpend(status.spend), [
							"## Retained telemetry",
							formatTaskMemorySpend(status.spend),
							"Reminder counts measure recorded delivery, not causal usefulness.",
						]),
					]
				: []),
			...activityItems(status.activity, "Recent memory steps"),
		];
	}

	/** Only the keys the selected row answers to, so a lesson row never advertises promotion. */
	private hintsFor(item: ListOverlayItem | undefined): ReadonlyArray<{ key: string; verb: string }> {
		if (item === undefined) return [];
		if (this.selectedBankEntry(item) !== null && this.handlers.onPromote) {
			return [
				{ key: "p", verb: "propose repo" },
				{ key: "g", verb: "propose global" },
			];
		}
		const record = this.handlers.onReview ? this.selectedRecord(item) : null;
		if (record === null) return [];
		const state = memoryReviewState(record);
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
		const state = record === null ? null : memoryReviewState(record);
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
					? "review it in the Review tab, then press a to approve"
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
		const entry = memoryBankEntries(this.getStatus().bank).find((candidate) => candidate.id === entryId);
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
			...(options.activeRepository ? { activeRepository: options.activeRepository } : {}),
			...(options.activeRuntime ? { activeRuntime: options.activeRuntime } : {}),
			...(options.activeAgent ? { activeAgent: options.activeAgent } : {}),
			...(options.onPromote ? { onPromote: options.onPromote } : {}),
			...(options.onReview ? { onReview: options.onReview } : {}),
		},
	);
	const handle = showClioOverlayFrame(tui, view, {
		anchor: "center",
		width: MEMORY_OVERLAY_WIDTH,
		markerId: "memory",
		title: () => "Memory · inspection",
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

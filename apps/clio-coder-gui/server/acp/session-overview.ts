import type { SessionOverviewItem } from "../../contracts/session-overview.js";
import type { SessionSnapshot } from "../../contracts/sessions.js";

type WorkerSummary = { active: number; queued: number; complete: boolean; nodes: string[] };
const NO_WORKERS: WorkerSummary = { active: 0, queued: 0, complete: true, nodes: [] };

/** Live ownership outlives the bounded event feed; a quiet worker must not disappear when that feed rolls over. */
export class SessionWorkers {
	private readonly runs = new Map<string, { state: "active" | "queued"; node: string | null }>();
	private complete = true;
	observe(fact: { type: string; payload: unknown }) {
		if (!fact.payload || typeof fact.payload !== "object") return;
		const payload = fact.payload as Record<string, unknown>;
		if (typeof payload.runId !== "string") return;
		if (fact.type === "fleet.completed" || fact.type === "fleet.failed") {
			this.runs.delete(payload.runId);
			return;
		}
		if (fact.type !== "fleet.enqueued" && fact.type !== "fleet.started" && fact.type !== "fleet.progress") return;
		const previous = this.runs.get(payload.runId);
		if (!previous && this.runs.size >= 4096) {
			// Preserve every known live run and report a lower bound instead of evicting a quiet owner.
			this.complete = false;
			return;
		}
		this.runs.set(payload.runId, {
			state: fact.type === "fleet.enqueued" ? "queued" : "active",
			node: typeof payload.node === "string" && payload.node ? payload.node.slice(0, 256) : (previous?.node ?? null),
		});
	}
	get hasWork() {
		return this.runs.size > 0 || !this.complete;
	}
	summary(): WorkerSummary {
		let active = 0;
		let queued = 0;
		const nodes = new Set<string>();
		for (const run of this.runs.values()) {
			if (run.state === "active") active++;
			else queued++;
			if (run.node && nodes.size < 128) nodes.add(run.node);
		}
		return { active, queued, complete: this.complete, nodes: [...nodes] };
	}
}

export function projectSessionOverview(
	snapshot: SessionSnapshot,
	questions = 0,
	questionAt?: string,
	workers: WorkerSummary = NO_WORKERS,
): SessionOverviewItem {
	const last = snapshot.turns.at(-1);
	const held = snapshot.state === "open" || snapshot.state === "starting";
	const pendingApprovals = held
		? snapshot.permissions.filter((item) => item.status === "pending" || item.status === "escalated").length
		: 0;
	const pendingQuestions = held ? questions : 0;
	const activeJobs = held
		? (snapshot.jobs?.filter((job) => job.running || job.turn || job.delivery?.state === "running").length ?? 0)
		: 0;
	let activity: SessionOverviewItem["activity"];
	if (snapshot.state === "closed" || snapshot.state === "failed" || snapshot.state === "unknown")
		activity = snapshot.state;
	else if (snapshot.state === "parked") activity = "parked";
	else if (pendingApprovals) activity = "approval";
	else if (pendingQuestions) activity = "question";
	else if (snapshot.state === "starting") activity = "starting";
	else if (snapshot.contextWork?.active) activity = "working";
	else if (last?.status === "running") activity = last.queued ? "queued" : "working";
	else if (workers.active || activeJobs) activity = "working";
	else if (workers.queued) activity = "queued";
	else if (!workers.complete) activity = "unknown";
	else if (last?.status === "failed") activity = "failed";
	else activity = "ready";
	const times = [
		last?.finishedAt,
		last?.startedAt,
		snapshot.contextWork?.active?.operation?.startedAt,
		snapshot.contextWork?.latest?.startedAt,
		questionAt,
		snapshot.fleet.at(-1)?.at,
	]
		.filter((value): value is string => typeof value === "string" && Number.isFinite(Date.parse(value)))
		.sort((left, right) => Date.parse(right) - Date.parse(left));
	return {
		id: snapshot.id,
		workspaceId: snapshot.workspaceId,
		revision: snapshot.revision,
		state: snapshot.state,
		activity,
		title: (
			snapshot.label?.trim() ||
			snapshot.turns.find((turn) => turn.prompt.trim())?.prompt.trim() ||
			"Untitled session"
		)
			.replace(/\s+/gu, " ")
			.slice(0, 512),
		model: snapshot.config?.options.find((option) => option.id === "model")?.currentValue ?? null,
		target: snapshot.config?.target ?? null,
		updatedAt: times[0] ?? null,
		turnCount: snapshot.turns.length,
		currentTurnId: held && last?.status === "running" ? last.id : null,
		pendingApprovals,
		pendingQuestions,
		activeWorkers: held ? workers.active : 0,
		queuedWorkers: held ? workers.queued : 0,
		workersComplete: held ? workers.complete : true,
		activeJobs,
		nodes: held ? workers.nodes : [],
		recoveredOrphan: snapshot.recoveredOrphan,
		untouched:
			snapshot.state === "open" &&
			snapshot.turns.length === 0 &&
			snapshot.timeline.length === 0 &&
			!snapshot.contextWork?.active &&
			!snapshot.contextWork?.latest &&
			pendingApprovals === 0 &&
			pendingQuestions === 0 &&
			workers.active === 0 &&
			workers.queued === 0 &&
			workers.complete &&
			activeJobs === 0 &&
			!snapshot.recoveredOrphan,
	};
}

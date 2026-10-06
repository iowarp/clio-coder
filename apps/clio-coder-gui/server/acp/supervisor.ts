import { randomUUID } from "node:crypto";
import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";
import type { ArtifactRead } from "../../contracts/artifacts.js";
import { ArtifactList, ArtifactPage } from "../../contracts/artifacts.js";
import { AsideAnswer, AsideCancelled, AsideDrafts } from "../../contracts/aside.js";
import {
	attachmentWeight,
	TURN_IMAGES_MAX_BASE64,
	type TurnFile,
	type TurnImage,
} from "../../contracts/attachments.js";
import {
	DecisionSuperseded,
	type DecisionSupersedeRequest,
	MemoryProposed,
	type MemoryProposeRequest,
	SessionBoard,
} from "../../contracts/board.js";
import { SessionTree } from "../../contracts/branches.js";
import { Id } from "../../contracts/common.js";
import { ContextLedger } from "../../contracts/context-ledger.js";
import { ContextOperationStatus } from "../../contracts/context-work.js";
import { ExtensionReload, LibraryReload, SessionExtensions } from "../../contracts/extensions.js";
import {
	FleetPreview,
	type FleetPreviewRequest,
	type FleetRunRequest,
	FleetRunResult,
} from "../../contracts/fleet-run.js";
import { HandoffCancelled, HandoffCommitted, HandoffDraft } from "../../contracts/handoff.js";
import {
	INTERVIEW_CANCEL_METHOD,
	INTERVIEW_REQUEST_METHOD,
	type InterviewSubmission,
} from "../../contracts/interviews.js";
import { PERMISSION_WITHDRAW_METHOD, type PermissionDecision } from "../../contracts/permissions.js";
import type { SetConfigOption } from "../../contracts/session-config.js";
import { applySessionDelta, boundedText, emptySession } from "../../contracts/session-projection.js";
import {
	Provenance,
	type SessionDelta,
	type SessionSnapshot,
	type TimelineItem,
	type Turn,
} from "../../contracts/sessions.js";
import {
	CommandCatalog,
	type CommandRequest,
	CommandResult,
	type DispatchSteerRequest,
	DispatchSteerResult,
	InterruptResult,
	QueueChanged,
	QueueCleared,
	type QueueEditRequest,
	QueueEditResult,
	QueueSnapshot,
	ShellOutcome,
	type ShellRequest,
	type SteerRequest,
	SteerResult,
} from "../../contracts/steering.js";
import { SessionTargets, TargetProbe } from "../../contracts/targets.js";
import { SessionUsage } from "../../contracts/usage.js";
import type { AcpSafeSettingsPatch as SafeSettingsPatch } from "../../contracts/wire.js";
import {
	ACP_AGENT_META_KEY,
	ACP_ARTIFACTS_LIST_METHOD,
	ACP_ARTIFACTS_READ_METHOD,
	ACP_ASIDE_ASK_METHOD,
	ACP_ASIDE_CANCEL_METHOD,
	ACP_ASIDE_DRAFT_METHOD,
	ACP_BOARD_METHOD,
	ACP_COMMANDS_INVOKE_METHOD,
	ACP_COMMANDS_LIST_METHOD,
	ACP_CONTEXT_LEDGER_METHOD,
	ACP_DECISION_SUPERSEDE_METHOD,
	ACP_DISPATCH_STEER_METHOD,
	ACP_EVENT_NOTIFICATION,
	ACP_EXTENSIONS_LIST_METHOD,
	ACP_EXTENSIONS_RELOAD_METHOD,
	ACP_FLEET_PREVIEW_METHOD,
	ACP_FLEET_RUN_METHOD,
	ACP_HANDOFF_CANCEL_METHOD,
	ACP_HANDOFF_COMMIT_METHOD,
	ACP_HANDOFF_PREPARE_METHOD,
	ACP_JOBS_LIST_METHOD,
	ACP_LIBRARY_RELOAD_METHOD,
	ACP_MAX_JOBS,
	ACP_MEMORY_PROPOSE_METHOD,
	ACP_NOTICE_META_KEY,
	ACP_QUEUE_CHANGED_NOTIFICATION,
	ACP_REPLAY_META_KEY,
	ACP_SESSION_FORK_METHOD,
	ACP_SESSION_INTERRUPT_METHOD,
	ACP_SESSION_LABEL_METHOD,
	ACP_SESSION_META_KEY,
	ACP_SESSION_QUEUE_CLEAR_METHOD,
	ACP_SESSION_QUEUE_METHOD,
	ACP_SESSION_STEER_METHOD,
	ACP_SESSION_SWITCH_TURN_METHOD,
	ACP_SESSION_TREE_METHOD,
	ACP_SETTINGS_GET_SAFE_METHOD,
	ACP_SETTINGS_PATCH_SAFE_METHOD,
	ACP_SHELL_META_KEY,
	ACP_TARGETS_LIST_METHOD,
	ACP_TARGETS_PROBE_METHOD,
	ACP_TRUNCATED_META_KEY,
	ACP_USAGE_READ_METHOD,
	type AcpJob,
	AcpJobList,
	AcpTargetList,
	type AcpAutonomyLevelSchema as AutonomyLevel,
	AcpSafeSettings as SafeSettings,
} from "../../contracts/wire.js";
import { ACP_CONTEXT_STATUS_METHOD } from "../clio/http-shims.js";
import { childRunning, startAcpChild } from "../process-policy.js";
import type { EventHub } from "../services/event-hub.js";
import { AppProblem } from "../services/problem.js";
import type { WorkspaceService } from "../services/workspaces.js";
import type { AppFiles } from "../state/files.js";
import { type ChildRow, ChildrenFile } from "./children-file.js";
import { AcpClient, acpProblem, record } from "./client.js";
import { fleetEvent } from "./fleet-events.js";
import { Interviews } from "./interviews.js";
import { JOB_QUIET_MS, jobChangeIsStructural, scheduledTurnPrompt } from "./jobs.js";
import { Permissions, type PermissionTimers } from "./permissions.js";
import { projectConfigOptions } from "./session-config.js";
import { sessionResultTelemetry, sessionUpdateTelemetry } from "./telemetry.js";

/**
 * The text of an ACP tool-call content array, or undefined when the frame
 * carries none. Only `{type:"content", content:{type:"text"}}` entries are
 * read: a diff or a terminal entry is structure, not a progress snapshot, and
 * flattening one into a string would show a client something it cannot act on.
 */
function toolProgressText(content: unknown): string | undefined {
	if (!Array.isArray(content)) return undefined;
	const parts = content.flatMap((value) => {
		const entry = record(value);
		if (entry.type !== "content") return [];
		const inner = record(entry.content);
		return inner.type === "text" && typeof inner.text === "string" ? [inner.text] : [];
	});
	return parts.length === 0 ? undefined : parts.join("");
}

type Entry = {
	id: string;
	cwd: string;
	client: AcpClient;
	row: ChildRow;
	turnId: string | null;
	replay: number | null;
	closing: boolean;
	bound: boolean;
	permissions?: Permissions;
	interviews?: Interviews;
	eventSequence: number;
	prompt?: Promise<void>;
	retired?: Promise<void>;
	/**
	 * A branch change in flight. Its replay arrives before its response: a fork's
	 * or a handoff's under the new session's id, which moves this child to that
	 * id, and a switch's under the same id, after the old transcript is cleared.
	 */
	rebase?: { mode: "move"; moved: boolean } | { mode: "switch"; reset: boolean };
	/** A handoff document is being drawn up; a request now would make it describe a moving session. */
	drafting?: boolean;
	/** Context commands run outside the conversation; they still own its context while pending. */
	contextCommand?: Promise<Static<typeof CommandResult>>;
	/** The turn is recorded and waits for a slot: `admit` sends it to the agent, `drop` gives it up. */
	queued?: { admit(): void; drop(): void };
	/** When a request, a turn or a window last touched this child, on the monotonic clock. */
	activeAt: number;
	/** A resume loads a transcript the kept snapshot already holds, so its replay is not projected again. */
	resuming?: boolean;
	/** Retired for idleness: the snapshot stays and reads `parked` once the child is gone. */
	parking?: boolean;
	/** The job whose scheduled turn is this entry's open turn. No `session/prompt` brackets it; `job.changed` does. */
	scheduled?: string;
	/** Job changes held back because they only moved a counter or a clock, newest per job, and when each job last published. */
	jobPending?: Map<string, AcpJob>;
	jobPublished?: Map<string, number>;
	jobTimer?: ReturnType<typeof setTimeout>;
};
/** A branch change reads and replays a whole session, which a long one makes slow. */
const BRANCH_TIMEOUT_MS = 60_000;
/** Four parallel drafts on a slow local target plus a judgment; past this the round is treated as lost. */
const ASIDE_TIMEOUT_MS = 15 * 60_000;
/** The `/loop` flags this app's command form cannot submit as a single token. */
const LOOP_FLAGS_NOT_SUBMITTABLE = new Set(["--until", "--on-match", "--follow-up", "--command"]);
/** Longest a command reply may take; see invokeCommand. */
const COMMAND_TIMEOUT_MS = 10 * 60_000;
/** How long a task with no turn and no window showing it keeps its agent process. */
const PARK_AFTER_MS = 5 * 60_000;
/** Parked snapshots kept in memory. An older one is closed and forgotten, and reloads from its ledger like any saved task. */
const PARKED_KEPT = 32;

export class Supervisor {
	readonly children: ChildrenFile;
	private readonly snapshots = new Map<string, SessionSnapshot>();
	private readonly entries = new Map<string, Entry>();
	private readonly reapers = new Set<Promise<void>>();
	private starting = 0;
	/** Entries whose turn waits for a slot, oldest first. */
	private readonly waiting: Entry[] = [];
	/** Resumes in flight, so two windows showing one parked task start one child. */
	private readonly waking = new Map<string, Promise<void>>();
	/** Parked session ids, oldest first. */
	private parked: string[] = [];
	/** The autonomy each parked task was at, so "Run without asking" comes back with the task. */
	private readonly parkedAutonomy = new Map<string, "default" | "yolo">();
	/** The highest revision any session here has published. A reloaded session starts above it. */
	private floor = 0;
	private readonly opening = new Set<Promise<SessionSnapshot>>();
	private readonly controls = new Set<Promise<void>>();
	private readonly workspaceControls = new Set<AbortController>();
	private readonly loading = new Set<string>();
	private readonly configuring = new Set<string>();
	private stopping = false;
	private readonly monitor: ReturnType<typeof setInterval>;
	constructor(
		private readonly workspaces: WorkspaceService,
		files: AppFiles,
		private readonly hub: EventHub,
		private readonly env: NodeJS.ProcessEnv = process.env,
		/** Turns that may run at once across every session. Open sessions are not limited. */
		readonly turnCapacity = 4,
		private readonly permissionTimers?: PermissionTimers,
		private readonly recover?: (cwd: string, sessionId: string) => Promise<unknown>,
		private readonly parkAfterMs = PARK_AFTER_MS,
	) {
		this.children = new ChildrenFile(files);
		this.monitor = setInterval(() => {
			const now = performance.now();
			for (const entry of this.entries.values()) {
				if (entry.closing) continue;
				if (entry.client.transport.closed) this.retireDetached(entry);
				else if (now - entry.activeAt >= this.parkAfterMs && this.resting(entry)) {
					entry.parking = true;
					this.retireDetached(entry);
				}
			}
		}, 200);
		this.monitor.unref();
	}
	/** Nothing runs in the child, nothing waits on it, and its ledger can be loaded again. */
	private resting(entry: Entry) {
		return (
			entry.bound &&
			!entry.parking &&
			!entry.closing &&
			entry.turnId === null &&
			!entry.contextCommand &&
			!this.snapshot(entry.id).contextWork?.active &&
			!entry.rebase &&
			!entry.drafting &&
			entry.client.pending === 0 &&
			!this.liveJobs(entry.id) &&
			entry.client.capabilities.loadSession &&
			!this.configuring.has(entry.id) &&
			this.snapshots.get(entry.id)?.state === "open"
		);
	}
	/** Turns whose request is with an agent now. A replayed turn and a queued one hold no slot. */
	private get runningTurns() {
		let count = 0;
		for (const entry of this.entries.values())
			if (entry.turnId !== null && entry.replay === null && !entry.queued) count++;
		return count;
	}
	/** The live projection, never handed outside this class: callers that only read a field must not pay for a clone. */
	private snapshot(id: string) {
		const value = this.snapshots.get(id);
		if (!value) throw new AppProblem("not_found", "Session is not open in this server.");
		return value;
	}
	get(id: string) {
		return structuredClone(this.snapshot(id));
	}
	list() {
		return [...this.snapshots.values()].map((value) => structuredClone(value));
	}
	get hasOpenSessions() {
		return this.entries.size > 0;
	}
	get busy() {
		return (
			!!(
				this.starting ||
				this.opening.size ||
				this.controls.size ||
				this.loading.size ||
				this.configuring.size ||
				this.reapers.size
			) ||
			[...this.entries.values()].some(
				(entry) =>
					entry.turnId !== null ||
					!!entry.closing ||
					entry.client.pending > 0 ||
					!!this.snapshot(entry.id).contextWork?.active,
			)
		);
	}
	/** Resting, reloadable conversations survive restart; pending RPCs and unsaved work do not. */
	get restartSafe() {
		return !this.busy && [...this.entries.values()].every((entry) => this.resting(entry));
	}
	private publish(event: SessionDelta) {
		const current = this.snapshots.get(event.payload.resource);
		if (!current) return;
		if (event.payload.revision > this.floor) this.floor = event.payload.revision;
		this.snapshots.set(current.id, applySessionDelta(current, event));
		this.hub.publish(event);
	}
	private revision(id: string) {
		return this.snapshot(id).revision + 1;
	}
	private state(id: string, state: SessionSnapshot["state"], recoveredOrphan = false) {
		this.publish({
			type: "session.changed",
			payload: { resource: id, revision: this.revision(id), state, recoveredOrphan },
		});
	}
	async reconcile() {
		for (const row of await this.children.rows()) {
			if (!this.children.orphan(row)) continue;
			if (row.control) {
				const job = this.children
					.reap(row)
					.then(() => undefined)
					.catch(() => {
						// A control child has no ledger; its ownership row alone remains for the next reconciliation.
					});
				this.reapers.add(job);
				void job.finally(() => this.reapers.delete(job));
				continue;
			}
			this.snapshots.set(row.sessionId, emptySession(row.sessionId, row.workspaceId));
			this.state(row.sessionId, "unknown", true);
			const job = this.children
				.reap(row)
				.then(async (result) => {
					if (result === "unknown" || result === "other-owner") return;
					// A mismatch against a real birth token means the child is gone; without one it proves nothing.
					const dead =
						result === "closed" || (result === "identity-mismatch" && !!row.birthToken && !row.birthToken.startsWith("pid-"));
					if (dead) await this.recoverLedger(row.workspaceId, row.sessionId);
					this.state(row.sessionId, "closed", true);
				})
				.catch(() => {
					/* Retain unknown and its durable ownership row for the next reconciliation. */
				});
			this.reapers.add(job);
			void job.finally(() => this.reapers.delete(job));
		}
	}
	/**
	 * A child confirmed dead cannot close its own record, and ACP refuses an unended record as possibly open, so the
	 * session would be stuck for every interface except a terminal resume. Only this supervisor's own dead children
	 * reach here, which is the proof ACP lacks. Best effort: when it fails the record stays as it was.
	 */
	private async recoverLedger(workspaceId: string, sessionId: string) {
		if (!this.recover) return;
		try {
			await this.recover((await this.workspaces.get(workspaceId)).path, sessionId);
		} catch {
			// The workspace may have vanished or the ledger be unreadable; the record then keeps its terminal-resume path.
		}
	}
	async open(workspaceId: string, existingId?: string) {
		if (existingId && this.snapshots.get(existingId)?.state === "parked") {
			await this.wake(existingId);
			return this.get(existingId);
		}
		return this.track(this.openSession(workspaceId, existingId));
	}
	private async track(pending: Promise<SessionSnapshot>) {
		this.opening.add(pending);
		try {
			return await pending;
		} finally {
			this.opening.delete(pending);
		}
	}
	/**
	 * A resumed child reads autonomy, thinking and its other session controls from settings. The task
	 * was parked with the operator's own choices, kept in its snapshot, so they are set again before
	 * any window is told the task is open. A choice the new child no longer offers is left at its
	 * setting, and a refusal leaves the task open on the settings' values rather than failing the resume.
	 */
	private async restoreChoices(entry: Entry, id: string) {
		const level = this.parkedAutonomy.get(id);
		this.parkedAutonomy.delete(id);
		try {
			if (level !== undefined && (await entry.client.autonomy(id)).level !== level) await entry.client.autonomy(id, level);
			for (const kept of this.snapshots.get(id)?.config?.options ?? []) {
				const offered = entry.client.config?.options.find((option) => option.id === kept.id);
				if (
					!offered ||
					offered.currentValue === kept.currentValue ||
					!offered.options.some((row) => row.value === kept.currentValue)
				)
					continue;
				const result = record(
					await entry.client.request("session/set_config_option", {
						sessionId: id,
						configId: kept.id,
						value: kept.currentValue,
					}),
				);
				const options = projectConfigOptions(result.configOptions);
				if (options !== undefined) entry.client.config = { ...entry.client.config, options };
			}
		} catch (error) {
			console.error(
				`[clio-coder:gui] session ${id} resumed on its settings: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	/** Start a parked session's child again. Its transcript is the kept snapshot, so clients see only the state change. */
	private wake(id: string) {
		let job = this.waking.get(id);
		if (!job) {
			job = this.track(this.openSession(this.snapshot(id).workspaceId, id, true))
				.then(() => undefined)
				.finally(() => this.waking.delete(id));
			this.waking.set(id, job);
		}
		return job;
	}
	/**
	 * A window shows this session. That keeps its child from being parked, and brings a parked one back
	 * before answering, so the caller can treat the session as open.
	 */
	async view(id: string) {
		const entry = this.entries.get(id);
		if (entry?.parking) await entry.retired?.catch(() => undefined);
		else if (entry) {
			entry.activeAt = performance.now();
			if (entry.bound && this.resting(entry) && entry.client.capabilities.trustRefresh) {
				const telemetry = sessionResultTelemetry(
					await entry.client.request(entry.client.capabilities.trustRefresh, { sessionId: id }),
				);
				if (JSON.stringify(telemetry.trust) !== JSON.stringify(this.snapshot(id).telemetry?.trust) && this.resting(entry)) {
					entry.parking = true;
					this.retireDetached(entry);
					await entry.retired;
				}
			}
		}
		if (this.snapshot(id).state === "parked") await this.wake(id);
		return {};
	}
	private async openSession(workspaceId: string, existingId?: string, resume = false) {
		if (this.stopping) throw new AppProblem("unavailable", "The server is shutting down.");
		if (existingId && (this.entries.has(existingId) || this.loading.has(existingId)))
			throw new AppProblem("conflict", "Session is already open in this server.");
		this.starting++;
		if (existingId) this.loading.add(existingId);
		let entry: Entry | undefined;
		try {
			const workspace = await this.workspaces.get(workspaceId),
				transport = await startAcpChild(workspace.path, this.env),
				id = existingId ?? randomUUID();
			if (!transport.pid) {
				await transport.forceTerminate();
				throw new AppProblem("upstream_acp", "ACP child did not start.");
			}
			let row: ChildRow;
			try {
				row = await this.children.record(transport.pid, id, workspaceId);
			} catch (error) {
				await transport.forceTerminate();
				throw error;
			}
			entry = {
				id,
				cwd: workspace.path,
				client: new AcpClient(transport),
				row,
				turnId: null,
				replay: null,
				closing: false,
				bound: false,
				eventSequence: 0,
				activeAt: performance.now(),
				...(resume ? { resuming: true } : {}),
			};
			// A session loaded again starts above every revision this server has published, so a window
			// still holding its earlier snapshot takes the new one instead of ignoring it as older.
			if (!resume)
				this.snapshots.set(
					id,
					existingId ? { ...emptySession(id, workspaceId), revision: this.floor + 1 } : emptySession(id, workspaceId),
				);
			this.entries.set(id, entry);
			this.starting--;
			const owned = entry;
			owned.permissions = new Permissions(
				(type, permission) =>
					this.publish({ type, payload: { resource: owned.id, revision: this.revision(owned.id), permission } }),
				() => this.cancelEntry(owned),
				this.permissionTimers,
			);
			owned.interviews = new Interviews((round) =>
				this.hub.publish({ type: "interview.changed", payload: { resource: owned.id, round } }),
			);
			transport.onRequest(INTERVIEW_REQUEST_METHOD, (params) => {
				if (!owned.client.capabilities.interviews)
					throw new AppProblem("conflict", "This peer has not announced interview support.");
				return owned.interviews?.request(owned.id, owned.turnId, params);
			});
			transport.onNotification(INTERVIEW_CANCEL_METHOD, (params) => {
				if (owned.client.capabilities.interviews?.cancel === INTERVIEW_CANCEL_METHOD)
					owned.interviews?.withdraw(owned.id, params);
			});
			transport.onNotification(PERMISSION_WITHDRAW_METHOD, (params) => {
				const withdrawn = record(params);
				if (withdrawn.sessionId === owned.id) owned.permissions?.withdraw(withdrawn.requestId);
			});
			transport.onNotification(ACP_QUEUE_CHANGED_NOTIFICATION, (params) => {
				const changed = Value.Clean(QueueChanged, structuredClone(params));
				if (Value.Check(QueueChanged, changed) && changed.sessionId === owned.id)
					this.hub.publish({ type: "queue.changed", payload: { resource: owned.id, entries: changed.entries } });
			});
			transport.onNotification("session/update", (params) => {
				try {
					this.update(owned, params);
				} catch (error) {
					this.failTurn(owned, acpProblem(error));
					this.retireDetached(owned);
				}
			});
			transport.onRequest("session/request_permission", (params) => {
				try {
					return owned.permissions?.request(owned.id, owned.turnId, params, this.snapshot(owned.id).timeline);
				} catch (error) {
					this.failTurn(owned, acpProblem(error));
					this.retireDetached(owned);
					throw error;
				}
			});
			transport.onNotification(ACP_EVENT_NOTIFICATION, (params) => {
				// A resume repeats facts the kept snapshot already holds. A new session can report a fact, such
				// as a target that is down, before its response binds the server's id; that frame names an id
				// this entry does not have yet, and failing on it used to end the child before the task opened.
				if (owned.resuming || (!owned.bound && record(params).sessionId !== owned.id)) return;
				try {
					const projected = fleetEvent(params, owned.id, owned.eventSequence);
					// The sequence advances even for a dropped kind, so a later frame
					// is still checked against the newest number this session saw
					// rather than against the last one that happened to project.
					owned.eventSequence = projected.sequence;
					if (projected.type === "context.activity") {
						if (projected.activity.operation?.cwd !== owned.cwd)
							throw new AppProblem("upstream_acp", "ACP context activity identifies another workspace.");
						this.publish({
							type: "context.activity",
							payload: { resource: owned.id, revision: this.revision(owned.id), activity: projected.activity },
						});
						return;
					}
					if (projected.type === "job.changed") {
						this.jobChanged(owned, projected.job);
						return;
					}
					if (projected.type === null) {
						console.error(`[clio-coder:gui] dropped an unrecognized _clio-coder/event kind on session ${owned.id}`);
						return;
					}
					// The type and the schema the item was checked against both come
					// from the same `ACP_TO_WEB_EVENT` row, so the pairing cannot
					// disagree; TypeScript just cannot see that across the call.
					this.publish({
						type: projected.type,
						payload: { resource: owned.id, revision: this.revision(owned.id), item: projected.item },
					} as SessionDelta);
				} catch (error) {
					this.failTurn(owned, acpProblem(error));
					this.retireDetached(owned);
				}
			});
			await entry.client.initialize();
			const boundId = await entry.client.open(workspace.path, existingId, !resume);
			delete entry.resuming;
			if (entry.replay !== null && entry.turnId) this.finish(entry, "end_turn", null, null, null);
			if (resume) await this.restoreChoices(entry, boundId);
			if (boundId !== id) {
				if (this.entries.has(boundId))
					throw new AppProblem("upstream_acp", "ACP returned an already-bound session identity.");
				this.entries.delete(id);
				this.snapshots.delete(id);
				entry.id = boundId;
				this.entries.set(boundId, entry);
				this.snapshots.set(boundId, emptySession(boundId, workspaceId));
			}
			await this.children.bind(row, boundId);
			entry.bound = true;
			this.publish({
				type: "session.telemetry",
				payload: { resource: boundId, revision: this.revision(boundId), telemetry: entry.client.telemetry },
			});
			if (entry.client.config)
				this.publish({
					type: "session.configured",
					payload: { resource: boundId, revision: this.revision(boundId), config: entry.client.config },
				});
			if (this.stopping) {
				await this.retire(entry);
				throw new AppProblem("unavailable", "Server shut down while opening the session.");
			}
			entry.activeAt = performance.now();
			this.state(boundId, "open");
			if (entry.client.capabilities.context?.status === ACP_CONTEXT_STATUS_METHOD) await this.contextStatus(boundId);
			await this.seedJobs(boundId);
			return this.get(boundId);
		} catch (error) {
			if (entry) await this.retire(entry);
			throw acpProblem(error);
		} finally {
			if (!entry) this.starting--;
			if (existingId) this.loading.delete(existingId);
		}
	}
	startTurn(id: string, text: string, images: ReadonlyArray<TurnImage> = [], files: ReadonlyArray<TurnFile> = []) {
		const entry = this.entries.get(id);
		if (!entry || entry.closing || this.snapshot(id).state !== "open")
			throw new AppProblem("conflict", "Session is not available for a turn.");
		if (entry.turnId) throw new AppProblem("conflict", "A turn is already running in this session.");
		if (this.configuring.has(id)) throw new AppProblem("conflict", "Session configuration is being changed.");
		if (entry.rebase) throw new AppProblem("conflict", "The conversation is moving to another branch.");
		if (entry.drafting) throw new AppProblem("conflict", "Clio Coder is drawing up a handoff for this conversation.");
		if (entry.contextCommand || this.snapshot(id).contextWork?.active)
			throw new AppProblem("conflict", "Context work is running in this task. Wait for it or stop it.");
		if (images.length > 0 && !entry.client.capabilities.images)
			throw new AppProblem("conflict", "This Clio Coder build does not accept images with a request.");
		if (files.length > 0 && !entry.client.capabilities.embeddedContext)
			throw new AppProblem("conflict", "This Clio Coder build does not accept files with a request.");
		if (attachmentWeight(images, files) > TURN_IMAGES_MAX_BASE64)
			throw new AppProblem(
				"validation",
				"Attachments exceed what one request can carry. Remove one or attach smaller ones.",
			);
		entry.replay = null;
		entry.activeAt = performance.now();
		// Past the limit the turn is recorded at once, so the request shows in the task, and sent when a slot frees.
		const queued = this.runningTurns >= this.turnCapacity;
		const turnId = this.begin(entry, text, "live", randomUUID(), images.length, files.length, queued);
		const run = () =>
			entry.client
				.prompt(id, text, images, files)
				.then((result) => {
					if (entry.turnId === turnId)
						this.finish(entry, result.stopReason, result.usage, null, new Date().toISOString(), result.details);
				})
				.catch((error) => {
					if (entry.turnId === turnId) this.failTurn(entry, acpProblem(error));
				});
		if (queued)
			entry.prompt = new Promise<void>((resolve) => {
				entry.queued = { admit: () => resolve(run()), drop: () => resolve() };
				this.waiting.push(entry);
			});
		else entry.prompt = run();
		return { turnId };
	}
	/** Send queued turns to their agents, oldest first, while slots are free. */
	private admit() {
		while (this.waiting.length > 0 && this.runningTurns < this.turnCapacity) {
			const entry = this.waiting.shift();
			const queued = entry?.queued;
			if (!entry || !queued || entry.turnId === null) continue;
			delete entry.queued;
			this.publish({
				type: "turn.admitted",
				payload: {
					resource: entry.id,
					revision: this.revision(entry.id),
					turnId: entry.turnId,
					startedAt: new Date().toISOString(),
				},
			});
			queued.admit();
		}
	}
	private begin(
		entry: Entry,
		prompt: string,
		origin: "live" | "replay",
		id: string = randomUUID(),
		images = 0,
		files = 0,
		queued = false,
	) {
		const turn: Turn = {
			id,
			prompt,
			origin,
			status: "running",
			startedAt: origin === "live" && !queued ? new Date().toISOString() : null,
			finishedAt: null,
			stopReason: null,
			usage: null,
			problem: null,
			...(images > 0 ? { images } : {}),
			...(files > 0 ? { files } : {}),
			...(queued ? { queued: true as const } : {}),
		};
		entry.turnId = id;
		this.publish({ type: "turn.started", payload: { resource: entry.id, revision: this.revision(entry.id), turn } });
		return id;
	}
	private finish(
		entry: Entry,
		stopReason: string,
		usage: Turn["usage"],
		problem: Turn["problem"],
		finishedAt: string | null,
		details?: Turn["details"],
	) {
		if (!entry.turnId) return;
		entry.permissions?.cancel();
		entry.interviews?.cancel();
		this.publish({
			type: "turn.finished",
			payload: {
				resource: entry.id,
				revision: this.revision(entry.id),
				turnId: entry.turnId,
				stopReason,
				usage,
				problem,
				finishedAt,
				...(details ? { details } : {}),
			},
		});
		entry.turnId = null;
		delete entry.scheduled;
		entry.activeAt = performance.now();
		const queued = entry.queued;
		if (queued) {
			delete entry.queued;
			const index = this.waiting.indexOf(entry);
			if (index >= 0) this.waiting.splice(index, 1);
			queued.drop();
		}
		// Whatever ended this turn freed its slot.
		this.admit();
	}
	/**
	 * A scheduled main turn streams `session/update` frames with no `session/prompt` around them. The
	 * engine opens its bracket with `job.changed` carrying `turn`, before the first frame, and closes it
	 * the same way after the last, so this entry's turn follows that flag. The job itself then enters the
	 * projection, held back when it only moved a counter or a clock.
	 */
	private jobChanged(entry: Entry, job: AcpJob) {
		if (job.turn && entry.turnId === null && entry.scheduled === undefined && entry.replay === null) {
			entry.scheduled = job.jobId;
			entry.activeAt = performance.now();
			this.begin(entry, scheduledTurnPrompt(job), "live");
		} else if (!job.turn && entry.scheduled === job.jobId) {
			this.finish(entry, "end_turn", null, null, new Date().toISOString());
		}
		const held = this.snapshots.get(entry.id)?.jobs?.find((row) => row.jobId === job.jobId);
		const now = performance.now();
		const due = (entry.jobPublished?.get(job.jobId) ?? Number.NEGATIVE_INFINITY) + JOB_QUIET_MS;
		if (jobChangeIsStructural(held, job) || now >= due) {
			entry.jobPending?.delete(job.jobId);
			this.publishJob(entry, job, now);
			return;
		}
		const pending = entry.jobPending ?? new Map<string, AcpJob>();
		pending.set(job.jobId, job);
		entry.jobPending = pending;
		if (entry.jobTimer === undefined) {
			entry.jobTimer = setTimeout(() => this.flushJobs(entry), Math.max(1, due - now));
			entry.jobTimer.unref();
		}
	}
	private publishJob(entry: Entry, job: AcpJob, now: number) {
		const published = entry.jobPublished ?? new Map<string, number>();
		entry.jobPublished = published;
		published.set(job.jobId, now);
		if (published.size > ACP_MAX_JOBS * 2) published.delete(published.keys().next().value as string);
		this.publish({ type: "job.changed", payload: { resource: entry.id, revision: this.revision(entry.id), job } });
	}
	private flushJobs(entry: Entry) {
		delete entry.jobTimer;
		const pending = [...(entry.jobPending?.values() ?? [])];
		entry.jobPending?.clear();
		if (entry.closing || !this.snapshots.has(entry.id)) return;
		const now = performance.now();
		for (const job of pending) this.publishJob(entry, job, now);
	}
	/** The engine's own list after a bind or resume; events carry only what changes after it. Best effort, since the strip is auxiliary. */
	private async seedJobs(id: string) {
		const entry = this.entries.get(id);
		if (entry?.client.capabilities.jobs?.list !== ACP_JOBS_LIST_METHOD) return;
		try {
			const list = await this.projected(id, ACP_JOBS_LIST_METHOD, { sessionId: id }, AcpJobList);
			this.publish({ type: "job.listed", payload: { resource: id, revision: this.revision(id), jobs: list.jobs } });
		} catch (error) {
			console.error(
				`[clio-coder:gui] session ${id} could not list its jobs: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	/** A job that is running, due again or being delivered lives in this child process, which parking would end. */
	private liveJobs(id: string) {
		return (
			this.snapshots
				.get(id)
				?.jobs?.some(
					(job) =>
						job.state === "active" ||
						(job.state === "terminal" && !job.complete) ||
						job.running ||
						job.turn ||
						job.cancelRequested,
				) === true
		);
	}
	private failTurn(entry: Entry, problem: AppProblem) {
		this.finish(entry, "failed", null, problem.problem, new Date().toISOString());
	}
	private update(entry: Entry, value: unknown) {
		const params = record(value),
			update = record(params.update),
			meta = record(params._meta);
		const metadataUpdate =
			update.sessionUpdate === "usage_update" ||
			update.sessionUpdate === "plan" ||
			update.sessionUpdate === "current_mode_update" ||
			update.sessionUpdate === "config_option_update" ||
			update.sessionUpdate === "session_info_update" ||
			update.sessionUpdate === "available_commands_update";
		// session/new can send metadata before its response binds the server's ID.
		if (metadataUpdate && !entry.bound && params.sessionId !== entry.id) return;
		if (entry.rebase?.mode === "move" && !entry.rebase.moved && params.sessionId !== entry.id)
			this.moveTo(entry, params.sessionId);
		if (params.sessionId !== entry.id)
			throw new AppProblem("upstream_acp", "ACP update has a different session identity.");
		if (entry.rebase?.mode === "switch" && !entry.rebase.reset) this.resetTimeline(entry);
		const telemetry = sessionUpdateTelemetry(update);
		if (telemetry)
			this.publish({
				type: "session.telemetry",
				payload: { resource: entry.id, revision: this.revision(entry.id), telemetry },
			});
		if (update.sessionUpdate === "config_option_update") {
			const options = projectConfigOptions(update.configOptions);
			if (options === undefined) throw new AppProblem("upstream_acp", "Clio Coder omitted session configuration.");
			const target = record(meta[ACP_SESSION_META_KEY]).target;
			const config = {
				...this.snapshot(entry.id).config,
				options,
				...(target === null || (typeof target === "string" && target.length <= 128) ? { target } : {}),
			};
			this.publish({
				type: "session.configured",
				payload: { resource: entry.id, revision: this.revision(entry.id), config },
			});
		}
		if (metadataUpdate || entry.resuming) return;
		const replay = record(meta[ACP_REPLAY_META_KEY]).turn;
		if (typeof replay === "number" && Number.isInteger(replay) && replay > 0 && replay !== entry.replay) {
			if (entry.turnId) this.finish(entry, "end_turn", null, null, null);
			entry.replay = replay;
			this.begin(entry, "", "replay", `replay-${replay}`);
		}
		if (!entry.turnId) throw new AppProblem("upstream_acp", "ACP update arrived without a turn.");
		const origin = entry.replay === null ? ("live" as const) : ("replay" as const);
		const attribution = meta[ACP_AGENT_META_KEY];
		const projected = attribution === undefined ? undefined : Value.Clean(Provenance, attribution);
		if (projected !== undefined && !Value.Check(Provenance, projected))
			throw new AppProblem("upstream_acp", "ACP agent attribution is invalid.");
		const provenance = projected;
		const common = {
			resource: entry.id,
			revision: this.revision(entry.id),
			turnId: entry.turnId,
			origin,
			...(provenance ? { provenance } : {}),
		};
		const kind = update.sessionUpdate;
		if (kind === "agent_message_chunk" || kind === "agent_thought_chunk" || kind === "user_message_chunk") {
			const content = record(update.content);
			if (content.type !== "text" || typeof content.text !== "string")
				throw new AppProblem("upstream_acp", "ACP message is not a text chunk.");
			if (kind === "agent_message_chunk" && meta[ACP_NOTICE_META_KEY] !== undefined) {
				const text = boundedText(content.text, 16384).trim();
				const notices = this.snapshot(entry.id).telemetry?.notices ?? [];
				if (text && !notices.includes(text))
					this.publish({
						type: "session.telemetry",
						payload: { resource: entry.id, revision: common.revision, telemetry: { notices: [...notices, text].slice(-32) } },
					});
				return;
			}
			this.publish({
				type: kind === "agent_message_chunk" ? "turn.text" : kind === "agent_thought_chunk" ? "turn.thought" : "turn.user",
				payload: { ...common, text: boundedText(content.text, 16384) },
			});
			return;
		}
		if (kind === "tool_call" || kind === "tool_call_update") {
			if (typeof update.toolCallId !== "string" || update.toolCallId.length > 128)
				throw new AppProblem("upstream_acp", "ACP tool identity is invalid.");
			const previous = this.snapshot(entry.id).timeline.find(
				(item) => item.turnId === entry.turnId && item.toolCallId === update.toolCallId,
			);
			const item: TimelineItem = {
				...previous,
				id: `${entry.turnId}:tool:${update.toolCallId}`,
				turnId: entry.turnId,
				sequence: previous?.sequence ?? 0,
				kind: "tool",
				text: boundedText(typeof update.title === "string" ? update.title : (previous?.text ?? "Tool")),
				status: typeof update.status === "string" ? update.status : (previous?.status ?? "pending"),
				origin,
				title: boundedText(typeof update.title === "string" ? update.title : (previous?.title ?? "Tool"), 4096),
				toolCallId: update.toolCallId,
				...(typeof update.kind === "string" ? { toolKind: update.kind } : {}),
				...(provenance ? { provenance } : {}),
			};
			if (Array.isArray(update.locations))
				item.locations = update.locations
					.flatMap((value) => {
						const location = record(value);
						return typeof location.path === "string"
							? [
									{
										path: boundedText(location.path, 4096),
										...(typeof location.line === "number" && Number.isInteger(location.line) ? { line: location.line } : {}),
									},
								]
							: [];
					})
					.slice(0, 64);
			if (update.rawInput) item.rawInput = this.raw(update.rawInput);
			// A tool-progress frame is non-terminal and its content is the whole
			// output so far, so it REPLACES the partial text rather than appending.
			// The terminal frame drops it: from then on `rawOutput` is the answer,
			// and leaving a stale snapshot beside it would show two versions of the
			// same output in the same row.
			const settled = item.status === "completed" || item.status === "failed";
			const partial = settled ? undefined : toolProgressText(update.content);
			if (partial !== undefined) item.partialOutput = boundedText(partial, 16384);
			else if (settled) delete item.partialOutput;
			// A shell line's terminal frame has its facts in `rawOutput` and its output only in `content`.
			if (update.rawOutput && settled && update.content && meta[ACP_SHELL_META_KEY] !== undefined)
				item.rawOutput = this.raw({ ...record(update.rawOutput), content: update.content });
			else if (update.rawOutput) item.rawOutput = this.raw(update.rawOutput);
			else if (settled && update.content) item.rawOutput = this.raw({ content: update.content });
			this.publish({ type: "turn.tool", payload: { resource: entry.id, revision: this.revision(entry.id), item } });
			return;
		}
		// A `sessionUpdate` kind this build does not know is a newer engine, not a
		// broken one: the spec's union grows, and the day it does, throwing here
		// would take `failTurn` -> `retireDetached` and kill a live session's
		// child mid-turn over a frame the UI would not have drawn anyway. Drop it
		// and say so. Note the sharp line: a MALFORMED frame of a kind this method
		// does handle (a chunk that is not text, a tool call with no id) still
		// throws above, because there continuing means projecting something no
		// contract describes.
		console.error(`[clio-coder:gui] dropped an unrecognized ACP sessionUpdate kind on session ${entry.id}`);
	}
	private raw(value: unknown) {
		const text = JSON.stringify(value);
		return Buffer.byteLength(text) <= 32768 ? record(value) : { truncated: true, snippet: boundedText(text, 32000) };
	}
	private active(id: string) {
		const entry = this.entries.get(id);
		if (!entry || entry.closing || this.snapshot(id).state !== "open")
			throw new AppProblem("conflict", "Session is not open in this server.");
		entry.activeAt = performance.now();
		return entry;
	}
	interview(id: string) {
		const entry = this.active(id);
		if (!entry.client.capabilities.interviews)
			throw new AppProblem("conflict", "This runtime does not expose operator interviews over ACP.");
		return entry.interviews?.current() ?? null;
	}
	answerInterview(id: string, roundId: string, submission: InterviewSubmission) {
		const entry = this.active(id);
		if (!entry.client.capabilities.interviews || !entry.interviews)
			throw new AppProblem("conflict", "This runtime does not expose operator interviews over ACP.");
		entry.interviews.answer(roundId, submission);
		return {};
	}
	decide(id: string, permissionId: string, decision: PermissionDecision) {
		this.active(id).permissions?.decide(permissionId, decision);
		return {};
	}
	async cancel(id: string, turnId: string) {
		const entry = this.active(id);
		if (entry.turnId !== turnId) {
			if (this.snapshot(id).turns.some((turn) => turn.id === turnId && turn.status !== "running")) return {};
			throw new AppProblem("conflict", "Turn is not active in this session.");
		}
		// A queued turn never reached the agent, so there is nothing to cancel there.
		if (entry.queued) this.finish(entry, "cancelled", null, null, new Date().toISOString());
		else await this.cancelEntry(entry);
		return {};
	}
	private async cancelEntry(entry: Entry) {
		try {
			await entry.client.request("session/cancel", { sessionId: entry.id }, 2000);
			entry.permissions?.cancel();
			entry.interviews?.cancel();
		} catch (error) {
			this.failTurn(entry, acpProblem(error));
			await this.retire(entry);
			throw error;
		}
	}
	private async projected<S extends TSchema>(
		id: string,
		method: string,
		params: unknown,
		schema: S,
		timeoutMs?: number,
	): Promise<Static<S>> {
		const raw = await this.active(id).client.request(method, params, timeoutMs),
			value = Value.Clean(schema, raw);
		if (!Value.Check(schema, value)) throw new AppProblem("upstream_acp", "Clio returned an invalid control response.");
		return value;
	}
	settings(id: string, patch?: SafeSettingsPatch) {
		if (patch)
			for (const key of ["chat.target", "chat.model"] as const) {
				const value = patch[key];
				if (value && Buffer.byteLength(value) > (key === "chat.target" ? 128 : 256))
					throw new AppProblem("validation", "Setting exceeds its UTF-8 byte limit.");
			}
		return this.projected(
			id,
			patch ? ACP_SETTINGS_PATCH_SAFE_METHOD : ACP_SETTINGS_GET_SAFE_METHOD,
			patch ? { patch } : {},
			SafeSettings,
		);
	}
	async setConfig(id: string, body: SetConfigOption) {
		const entry = this.active(id);
		if (entry.turnId || this.configuring.has(id))
			throw new AppProblem("conflict", "Wait for the current turn or configuration change to finish.");
		const config = this.snapshot(id).config;
		const option = config?.options.find((row) => row.id === body.configId);
		if (!option) throw new AppProblem("conflict", "This Clio Coder build does not offer that conversation control.");
		if (Buffer.byteLength(body.value) > 256 || !option.options.some((row) => row.value === body.value))
			throw new AppProblem("validation", "Choose a value Clio Coder reports for this conversation.");
		this.configuring.add(id);
		try {
			const result = record(await entry.client.request("session/set_config_option", { sessionId: id, ...body }));
			const options = projectConfigOptions(result.configOptions);
			if (options === undefined) throw new AppProblem("upstream_acp", "Clio Coder omitted session configuration.");
			const target = record(record(result._meta)[ACP_SESSION_META_KEY]).target;
			const next = {
				...this.snapshot(id).config,
				options,
				...(target === null || typeof target === "string" ? { target } : {}),
			};
			this.publish({ type: "session.configured", payload: { resource: id, revision: this.revision(id), config: next } });
			return next;
		} finally {
			this.configuring.delete(id);
		}
	}
	async targets(id: string) {
		const client = this.active(id).client;
		if (!client.capabilities.targets?.list)
			throw new AppProblem("unsupported", "This Clio build does not expose target inventory.");
		const raw = Value.Clean(AcpTargetList, await client.request(ACP_TARGETS_LIST_METHOD, {}));
		if (!Value.Check(AcpTargetList, raw)) throw new AppProblem("upstream_acp", "Clio returned an invalid target list.");
		const projected = Value.Clean(SessionTargets, {
			targets: raw.targets,
			truncated: record(raw._meta)[ACP_TRUNCATED_META_KEY] === true,
		});
		if (!Value.Check(SessionTargets, projected))
			throw new AppProblem("upstream_acp", "Clio returned an invalid target list.");
		return projected;
	}
	probe(id: string, targetId: string) {
		if (!this.active(id).client.capabilities.targets?.probe)
			throw new AppProblem("unsupported", "This Clio build does not expose target probes.");
		return this.projected(id, ACP_TARGETS_PROBE_METHOD, { targetId }, TargetProbe);
	}
	autonomy(id: string, level?: Static<typeof AutonomyLevel>) {
		return this.active(id).client.autonomy(id, level);
	}
	capabilities(id: string) {
		return this.active(id).client.capabilities;
	}
	/**
	 * A namespaced method an older engine never announced is refused here rather
	 * than sent: an unknown method comes back as a JSON-RPC error that would be
	 * reported as an upstream fault, when the truth is that this peer does not
	 * have the feature.
	 */
	private steering(id: string) {
		const entry = this.active(id);
		if (!entry.client.capabilities.steering)
			throw new AppProblem("conflict", "This Clio build does not expose mid-turn steering.");
		if (entry.queued)
			throw new AppProblem("conflict", "This turn is waiting for a slot. It can take a message once it starts.");
		return entry;
	}
	steer(id: string, body: Static<typeof SteerRequest>) {
		this.steering(id);
		return this.projected(id, ACP_SESSION_STEER_METHOD, { sessionId: id, ...body }, SteerResult);
	}
	queue(id: string) {
		this.steering(id);
		return this.projected(id, ACP_SESSION_QUEUE_METHOD, { sessionId: id }, QueueSnapshot);
	}
	clearQueue(id: string) {
		this.steering(id);
		return this.projected(id, ACP_SESSION_QUEUE_CLEAR_METHOD, { sessionId: id }, QueueCleared);
	}
	editQueue(id: string, body: Static<typeof QueueEditRequest>) {
		const entry = this.steering(id);
		const queue = entry.client.capabilities.queue;
		if (!queue?.ops.includes(body.op))
			throw new AppProblem("conflict", "This Clio Coder build cannot change one waiting message.");
		return this.projected(id, queue.edit, { sessionId: id, ...body }, QueueEditResult);
	}
	/**
	 * The terminal's `!` line. The agent sends its tool frames outside any prompt, and a frame without
	 * a turn ends the child, so the line is recorded as a turn of its own: the frames land in it and
	 * Stop cancels it like any other.
	 */
	shell(id: string, body: Static<typeof ShellRequest>) {
		const entry = this.entries.get(id);
		if (!entry || entry.closing || this.snapshot(id).state !== "open")
			throw new AppProblem("conflict", "Session is not available for a shell line.");
		const shell = entry.client.capabilities.shell;
		if (!shell) throw new AppProblem("conflict", "This Clio Coder build does not run shell lines from this app.");
		if (entry.turnId) throw new AppProblem("conflict", "A shell line runs between turns. Wait for this turn or stop it.");
		if (this.configuring.has(id)) throw new AppProblem("conflict", "Session configuration is being changed.");
		if (entry.rebase) throw new AppProblem("conflict", "The conversation is moving to another branch.");
		if (entry.drafting) throw new AppProblem("conflict", "Clio Coder is drawing up a handoff for this conversation.");
		const command = body.command.trim();
		const excludeFromContext = body.excludeFromContext === true;
		entry.replay = null;
		entry.activeAt = performance.now();
		const turnId = this.begin(entry, `${excludeFromContext ? "!!" : "!"}${command}`, "live");
		entry.prompt = entry.client
			.request<unknown>(
				shell.run,
				{ sessionId: id, command, ...(excludeFromContext ? { excludeFromContext } : {}) },
				// The engine ends the line at its own limit; the margin is for the entry to land.
				shell.timeoutMs + 15_000,
			)
			.then((raw) => {
				if (entry.turnId !== turnId) return;
				const outcome = Value.Clean(ShellOutcome, structuredClone(raw));
				if (!Value.Check(ShellOutcome, outcome))
					throw new AppProblem("upstream_acp", "Clio returned an invalid shell result.");
				const note = outcome.timedOut
					? `The line was stopped at its ${Math.round(shell.timeoutMs / 1000)} s limit.`
					: outcome.unlabeled
						? "The output was kept out of Clio's context because its information-flow label could not be recorded."
						: null;
				if (note !== null)
					this.publish({
						type: "turn.tool",
						payload: {
							resource: entry.id,
							revision: this.revision(entry.id),
							item: {
								id: randomUUID(),
								turnId,
								sequence: 0,
								kind: "notice",
								toolKind: "transcript",
								text: note,
								status: "completed",
								origin: "live",
							},
						},
					});
				this.finish(entry, outcome.cancelled ? "cancelled" : "end_turn", null, null, new Date().toISOString());
			})
			.catch((error) => {
				if (entry.turnId === turnId) this.failTurn(entry, acpProblem(error));
			});
		return { turnId };
	}
	interrupt(id: string, reason?: string) {
		this.steering(id);
		return this.projected(
			id,
			ACP_SESSION_INTERRUPT_METHOD,
			{ sessionId: id, ...(reason ? { reason } : {}) },
			InterruptResult,
		);
	}
	steerDispatchRun(id: string, body: Static<typeof DispatchSteerRequest>) {
		const entry = this.steering(id);
		if (!entry.client.capabilities.steering?.dispatch)
			throw new AppProblem("conflict", "This Clio build has no fleet to steer.");
		// `cancel` carries no operator text and the engine refuses one, so the
		// message is dropped here rather than sent to be refused.
		const { runId, action, message } = body;
		return this.projected(
			id,
			ACP_DISPATCH_STEER_METHOD,
			{ sessionId: id, runId, action, ...(action === "guide" && message ? { message } : {}) },
			DispatchSteerResult,
		);
	}
	board(id: string) {
		const entry = this.active(id);
		if (!entry.client.capabilities.board)
			throw new AppProblem("conflict", "This Clio build does not report tasks and decisions.");
		return this.projected(id, ACP_BOARD_METHOD, { sessionId: id }, SessionBoard);
	}
	private branching(id: string) {
		const entry = this.active(id);
		if (!entry.client.capabilities.branches)
			throw new AppProblem("conflict", "This Clio Coder build cannot show or change conversation branches.");
		return entry;
	}
	tree(id: string) {
		this.branching(id);
		return this.projected(id, ACP_SESSION_TREE_METHOD, { sessionId: id }, SessionTree);
	}
	private beginRebase(id: string, rebase: NonNullable<Entry["rebase"]>) {
		const entry = this.branching(id);
		if (entry.turnId || entry.rebase || entry.drafting || this.configuring.has(id))
			throw new AppProblem("conflict", "Wait for the current turn to finish before changing branches.");
		entry.rebase = rebase;
		return entry;
	}
	/** Everything the old transcript said belongs to the branch that was left. */
	private resetTimeline(entry: Entry) {
		if (entry.rebase?.mode === "switch") entry.rebase.reset = true;
		entry.replay = null;
		entry.turnId = null;
		entry.permissions?.cancel();
		entry.interviews?.cancel();
		this.publish({
			type: "session.reset",
			payload: { resource: entry.id, revision: this.revision(entry.id), reason: "branch" },
		});
	}
	/**
	 * A fork's child process now hosts the new session. The parent is closed in
	 * the ledger, so its snapshot reads closed and the conversation continues
	 * under the new id, which is where a reload or the history finds it.
	 */
	private moveTo(entry: Entry, nextId: unknown) {
		if (typeof nextId !== "string" || !Value.Check(Id, nextId) || this.entries.has(nextId) || this.snapshots.has(nextId))
			throw new AppProblem("upstream_acp", "ACP returned an invalid forked session identity.");
		const previous = this.snapshot(entry.id);
		const parentId = entry.id;
		if (entry.rebase?.mode === "move") entry.rebase.moved = true;
		this.entries.delete(parentId);
		entry.id = nextId;
		entry.replay = null;
		entry.turnId = null;
		this.entries.set(nextId, entry);
		this.snapshots.set(nextId, {
			...emptySession(nextId, previous.workspaceId),
			...(previous.config ? { config: previous.config } : {}),
			telemetry: {
				...(previous.telemetry?.workspace ? { workspace: previous.telemetry.workspace } : {}),
				...(previous.telemetry?.trust ? { trust: previous.telemetry.trust } : {}),
			},
		});
		this.state(nextId, "open");
		this.state(parentId, "closed");
	}
	async switchTurn(id: string, turnId: string) {
		const entry = this.beginRebase(id, { mode: "switch", reset: false });
		try {
			const result = record(
				await entry.client.request(ACP_SESSION_SWITCH_TURN_METHOD, { sessionId: id, turnId }, BRANCH_TIMEOUT_MS),
			);
			if (result.leafId !== turnId) throw new AppProblem("upstream_acp", "Clio Coder moved to a different turn.");
			if (entry.rebase?.mode === "switch" && !entry.rebase.reset) this.resetTimeline(entry);
			if (entry.replay !== null && entry.turnId) this.finish(entry, "end_turn", null, null, null);
			return { leafId: turnId, replayedTurns: this.snapshot(id).turns.length };
		} finally {
			delete entry.rebase;
		}
	}
	/**
	 * The child now hosts the session `result` names, after a fork or a handoff:
	 * move to it if no frame already did, then carry the mode, the children row
	 * and the reported configuration across.
	 */
	private async settleMove(entry: Entry, parentId: string, result: Record<string, unknown>) {
		if (entry.rebase?.mode === "move" && !entry.rebase.moved) this.moveTo(entry, result.sessionId);
		else if (result.sessionId !== entry.id)
			throw new AppProblem("upstream_acp", "ACP returned a different session identity.");
		const nextId = entry.id;
		entry.client.adopt(parentId, nextId, result);
		this.publish({
			type: "session.telemetry",
			payload: { resource: nextId, revision: this.revision(nextId), telemetry: entry.client.telemetry },
		});
		if (entry.replay !== null && entry.turnId) this.finish(entry, "end_turn", null, null, null);
		await this.children.bind(entry.row, nextId);
		const options = projectConfigOptions(result.configOptions);
		if (options !== undefined) {
			const config = { ...this.snapshot(nextId).config, options };
			this.publish({ type: "session.configured", payload: { resource: nextId, revision: this.revision(nextId), config } });
		}
		return nextId;
	}
	async fork(id: string, turnId: string) {
		const entry = this.beginRebase(id, { mode: "move", moved: false });
		try {
			const result = record(
				await entry.client.request(ACP_SESSION_FORK_METHOD, { sessionId: id, turnId }, BRANCH_TIMEOUT_MS),
			);
			const forkedId = await this.settleMove(entry, id, result);
			const sessionMeta = record(record(result._meta)[ACP_SESSION_META_KEY]);
			return {
				sessionId: forkedId,
				parentSessionId: id,
				parentTurnId: turnId,
				replayed: sessionMeta.replayFailed !== true,
			};
		} finally {
			delete entry.rebase;
		}
	}
	artifacts(id: string) {
		const entry = this.active(id);
		if (!entry.client.capabilities.artifacts)
			throw new AppProblem("conflict", "This Clio build does not expose session artifacts.");
		return this.projected(id, ACP_ARTIFACTS_LIST_METHOD, { sessionId: id }, ArtifactList, BRANCH_TIMEOUT_MS);
	}
	artifact(id: string, body: Static<typeof ArtifactRead>) {
		const entry = this.active(id);
		if (!entry.client.capabilities.artifacts)
			throw new AppProblem("conflict", "This Clio build does not expose session artifacts.");
		return this.projected(id, ACP_ARTIFACTS_READ_METHOD, { sessionId: id, ...body }, ArtifactPage, BRANCH_TIMEOUT_MS);
	}
	usage(id: string) {
		const entry = this.active(id);
		if (!entry.client.capabilities.usage)
			throw new AppProblem("conflict", "This Clio Coder build does not report its usage.");
		// A quota read may reach each signed-in provider once its cache has expired.
		return this.projected(id, ACP_USAGE_READ_METHOD, { sessionId: id }, SessionUsage, BRANCH_TIMEOUT_MS);
	}
	private asiding(id: string) {
		const entry = this.active(id);
		if (!entry.client.capabilities.aside)
			throw new AppProblem("conflict", "This Clio Coder build cannot answer beside the conversation.");
		return entry;
	}
	// A round beside the conversation reads the history and bills a model; it waits as long as a turn might.
	askAside(id: string, question: string) {
		this.asiding(id);
		return this.projected(id, ACP_ASIDE_ASK_METHOD, { sessionId: id, question }, AsideAnswer, ASIDE_TIMEOUT_MS);
	}
	draftAside(id: string, body: { request: string; count: number }) {
		this.asiding(id);
		return this.projected(id, ACP_ASIDE_DRAFT_METHOD, { sessionId: id, ...body }, AsideDrafts, ASIDE_TIMEOUT_MS);
	}
	cancelAside(id: string) {
		this.asiding(id);
		return this.projected(id, ACP_ASIDE_CANCEL_METHOD, { sessionId: id }, AsideCancelled);
	}
	private extending(id: string) {
		const entry = this.active(id);
		if (!entry.client.capabilities.extensions)
			throw new AppProblem("conflict", "This Clio Coder build does not report its extensions.");
		return entry;
	}
	extensions(id: string) {
		this.extending(id);
		return this.projected(id, ACP_EXTENSIONS_LIST_METHOD, { sessionId: id }, SessionExtensions);
	}
	reloadExtensions(id: string) {
		const entry = this.extending(id);
		if (entry.turnId)
			throw new AppProblem("conflict", "Wait for the current turn to finish before reloading extensions.");
		return this.projected(id, ACP_EXTENSIONS_RELOAD_METHOD, { sessionId: id }, ExtensionReload, BRANCH_TIMEOUT_MS);
	}
	/**
	 * Ask every open conversation of a workspace to reload its library after a change was applied.
	 * Refreshed only when each one did; a conversation that is mid-turn, too old to reload, or whose
	 * reload failed makes the whole refresh failed, with the count and the first reason.
	 */
	async reloadLibrary(workspaceId: string) {
		const open = [...this.entries.values()].filter(
			(entry) =>
				entry.bound &&
				!entry.closing &&
				this.snapshots.get(entry.id)?.state === "open" &&
				this.snapshots.get(entry.id)?.workspaceId === workspaceId,
		);
		if (open.length === 0)
			return {
				status: "not-applicable" as const,
				reason: "No conversation is open in this project; new conversations read the change when they start.",
			};
		const outcomes = await Promise.all(
			open.map(
				async (entry): Promise<{ ok: true; generation: number; changed: boolean } | { ok: false; error: string }> => {
					if (!entry.client.capabilities.library)
						return { ok: false, error: "an open conversation cannot reload its library; close and reopen it" };
					if (entry.turnId)
						return { ok: false, error: "an open conversation is running a turn; reload it when the turn ends" };
					try {
						const result = await this.projected(
							entry.id,
							ACP_LIBRARY_RELOAD_METHOD,
							{ sessionId: entry.id },
							LibraryReload,
							BRANCH_TIMEOUT_MS,
						);
						return result.status === "refreshed"
							? { ok: true, generation: result.generation, changed: result.changed }
							: { ok: false, error: result.error };
					} catch (error) {
						return { ok: false, error: error instanceof Error ? error.message : String(error) };
					}
				},
			),
		);
		const failures = outcomes.filter((outcome) => !outcome.ok);
		if (failures.length > 0)
			return {
				status: "failed" as const,
				sessions: open.length,
				failedSessions: failures.length,
				error: failures[0] && !failures[0].ok ? failures[0].error.slice(0, 1000) : "reload failed",
			};
		const reloaded = outcomes.filter((outcome) => outcome.ok);
		return {
			status: "refreshed" as const,
			sessions: open.length,
			generation: Math.max(...reloaded.map((outcome) => (outcome.ok ? outcome.generation : 0))),
			changed: reloaded.some((outcome) => outcome.ok && outcome.changed),
		};
	}
	contextLedger(id: string) {
		const entry = this.active(id);
		if (!entry.client.capabilities.context)
			throw new AppProblem("conflict", "This Clio Coder build does not report its context window.");
		return this.projected(id, ACP_CONTEXT_LEDGER_METHOD, { sessionId: id }, ContextLedger);
	}
	async contextStatus(id: string) {
		const entry = this.active(id);
		if (entry.client.capabilities.context?.status !== ACP_CONTEXT_STATUS_METHOD)
			throw new AppProblem("unsupported", "This Clio build does not report context operations.");
		const before = this.snapshot(id).contextWork;
		const status = await this.projected(id, ACP_CONTEXT_STATUS_METHOD, { sessionId: id }, ContextOperationStatus);
		if (status.active && !status.active.operation)
			throw new AppProblem("upstream_acp", "ACP context status has no operation identity.");
		for (const operation of [status.active?.operation, status.latest])
			if (operation && (operation.sessionId !== id || operation.cwd !== entry.cwd))
				throw new AppProblem("upstream_acp", "ACP context status identifies another session or workspace.");
		if (this.entries.get(id) === entry && this.snapshot(id).contextWork === before)
			this.publish({ type: "context.status", payload: { resource: id, revision: this.revision(id), status } });
		return this.snapshot(id).contextWork ?? status;
	}
	async cancelContext(id: string, operationId: string) {
		const entry = this.active(id);
		const operation = this.snapshot(id).contextWork?.active?.operation;
		if (!operation || operation.id !== operationId)
			throw new AppProblem("conflict", "That context operation is no longer active.");
		const response = (await entry.client.request(
			"session/cancel",
			{
				sessionId: entry.id,
				_meta: { "clio-coder/context": { operationId } },
			},
			2000,
		)) as { _meta?: { "clio-coder/context"?: { operationId?: unknown; cancelled?: unknown } } };
		const acknowledgement = response?._meta?.["clio-coder/context"];
		if (acknowledgement?.operationId !== operationId || acknowledgement.cancelled !== true)
			throw new AppProblem("conflict", "That context operation is no longer active.");
		return {};
	}
	private fleeting(id: string) {
		const entry = this.active(id);
		if (!entry.client.capabilities.fleet)
			throw new AppProblem("conflict", "This Clio Coder build cannot preview or start a playbook.");
		return entry;
	}
	fleetPreview(id: string, body: Static<typeof FleetPreviewRequest>) {
		this.fleeting(id);
		// Compiling reads the contract, the agents and every route; a large fleet is not instant.
		return this.projected(id, ACP_FLEET_PREVIEW_METHOD, { sessionId: id, ...body }, FleetPreview, BRANCH_TIMEOUT_MS);
	}
	fleetRun(id: string, body: Static<typeof FleetRunRequest>) {
		const entry = this.fleeting(id);
		if (entry.turnId || entry.rebase || entry.drafting)
			throw new AppProblem("conflict", "Wait for the current turn to finish before starting a fleet run.");
		return this.projected(id, ACP_FLEET_RUN_METHOD, { sessionId: id, ...body }, FleetRunResult, BRANCH_TIMEOUT_MS);
	}
	private handing(id: string) {
		const entry = this.active(id);
		if (!entry.client.capabilities.handoff)
			throw new AppProblem("conflict", "This Clio Coder build cannot hand a conversation off.");
		return entry;
	}
	async prepareHandoff(id: string, goal: string) {
		const entry = this.handing(id);
		if (entry.turnId || entry.rebase || entry.drafting || this.configuring.has(id))
			throw new AppProblem("conflict", "Wait for the current turn to finish before drawing up a handoff.");
		entry.drafting = true;
		try {
			// The extraction is a model round with one repair, as long as a command's.
			return await this.projected(
				id,
				ACP_HANDOFF_PREPARE_METHOD,
				{ sessionId: id, goal },
				HandoffDraft,
				COMMAND_TIMEOUT_MS,
			);
		} finally {
			delete entry.drafting;
		}
	}
	async commitHandoff(id: string, handoffId: string, document: string) {
		const entry = this.handing(id);
		this.beginRebase(id, { mode: "move", moved: false });
		try {
			const raw = record(
				await entry.client.request(ACP_HANDOFF_COMMIT_METHOD, { sessionId: id, handoffId, document }, BRANCH_TIMEOUT_MS),
			);
			if (raw.status === "committed") await this.settleMove(entry, id, raw);
			const value = Value.Clean(HandoffCommitted, raw);
			if (!Value.Check(HandoffCommitted, value))
				throw new AppProblem("upstream_acp", "Clio returned an invalid handoff result.");
			return value;
		} finally {
			delete entry.rebase;
		}
	}
	cancelHandoff(id: string, handoffId: string) {
		this.handing(id);
		return this.projected(id, ACP_HANDOFF_CANCEL_METHOD, { sessionId: id, handoffId }, HandoffCancelled);
	}
	private boardWrites(id: string, method: "supersede" | "proposeMemory") {
		const entry = this.active(id);
		if (!entry.client.capabilities.board?.[method])
			throw new AppProblem("conflict", "This Clio Coder build cannot change decisions or memory from here.");
		return entry;
	}
	supersedeDecision(id: string, body: Static<typeof DecisionSupersedeRequest>) {
		const entry = this.boardWrites(id, "supersede");
		if (entry.turnId || entry.rebase || entry.drafting)
			throw new AppProblem("conflict", "Wait for the current turn to finish before revising a decision.");
		return this.projected(id, ACP_DECISION_SUPERSEDE_METHOD, { sessionId: id, ...body }, DecisionSuperseded);
	}
	proposeMemory(id: string, body: Static<typeof MemoryProposeRequest>) {
		this.boardWrites(id, "proposeMemory");
		return this.projected(id, ACP_MEMORY_PROPOSE_METHOD, { sessionId: id, ...body }, MemoryProposed);
	}
	async commands(id: string) {
		const entry = this.active(id);
		if (!entry.client.capabilities.commands)
			throw new AppProblem("conflict", "This Clio build exposes no operator commands.");
		const catalog = await this.projected(id, ACP_COMMANDS_LIST_METHOD, {}, CommandCatalog);
		// The command form submits single-token flags and one text field. A predicate, a program and its
		// arguments, or a follow-up task need more than that, so they are not offered rather than offered and refused.
		return {
			...catalog,
			commands: catalog.commands.map((row) =>
				row.name === "loop"
					? {
							...row,
							summary: "Run a bounded recurring main-context task, or list and control its jobs",
							usage: "/loop <every> [--count <runs>] [--for <duration>] [--timeout <duration>] <task>",
							args: {
								...row.args,
								...(row.args.flags !== undefined
									? { flags: row.args.flags.filter((flag) => !LOOP_FLAGS_NOT_SUBMITTABLE.has(flag.name)) }
									: {}),
							},
						}
					: row,
			),
		};
	}
	async invokeCommand(id: string, body: Static<typeof CommandRequest>) {
		const entry = this.active(id);
		if (!entry.client.capabilities.commands)
			throw new AppProblem("conflict", "This Clio build exposes no operator commands.");
		const catalog = await this.commands(id);
		const command = catalog.commands.find((row) => row.name === body.command);
		// A command, or one of its subcommands, whose work belongs to a conversation turn is sent as one.
		const subcommand = body.argv?.[0];
		if (
			// `/loop` submits nothing now: its turns come later through `job.changed`, and stopping one must work mid-turn.
			(command?.injectsUserTurn && body.command !== "loop" && (body.command !== "tasks" || subcommand === "hand")) ||
			command?.promptTurn ||
			(subcommand !== undefined && command?.promptTurnSubcommands?.includes(subcommand))
		) {
			if (entry.client.capabilities.commands.promptTurns !== true)
				throw new AppProblem(
					"conflict",
					"This Clio Coder build cannot show a command's injected turn. Update it before sending this command.",
				);
			const argv = body.argv ?? [];
			if (argv.some((arg) => /[\r\n]/u.test(arg)))
				throw new AppProblem("validation", "Command arguments cannot contain line breaks.");
			const { turnId } = this.startTurn(id, `/${body.command}${argv.length ? ` ${argv.join(" ")}` : ""}`);
			await entry.prompt;
			const turn = this.snapshot(id).turns.find((row) => row.id === turnId);
			return {
				level:
					turn?.status === "failed"
						? ("error" as const)
						: turn?.status === "cancelled"
							? ("warn" as const)
							: ("info" as const),
				lines: [
					turn?.status === "failed"
						? "The command's turn failed. See the conversation for its recorded outcome."
						: turn?.status === "cancelled"
							? "The command's turn was stopped. Its activity is recorded in the conversation."
							: "The command's turn finished. Its response is recorded in the conversation.",
				],
			};
		}
		const contextCommand = body.command === "context" || body.command === "compact";
		if (contextCommand && (entry.contextCommand || entry.turnId !== null || this.snapshot(id).contextWork?.active))
			throw new AppProblem("conflict", "Context work runs between turns. Wait for the current work to finish.");
		const request = this.projected(
			id,
			ACP_COMMANDS_INVOKE_METHOD,
			{ sessionId: id, command: body.command, ...(body.argv ? { argv: body.argv } : {}) },
			CommandResult,
			COMMAND_TIMEOUT_MS,
		);
		if (contextCommand) entry.contextCommand = request;
		try {
			return await request;
		} finally {
			if (contextCommand) delete entry.contextCommand;
		}
	}
	/** Workspace reads use an unbound peer so listing never creates or resumes a ledger. */
	async workspaceControl<T>(
		workspaceId: string,
		read: (client: AcpClient, cwd: string) => Promise<T>,
		signal?: AbortSignal,
	): Promise<T> {
		const controller = new AbortController();
		const abort = () => controller.abort(signal?.reason);
		signal?.addEventListener("abort", abort, { once: true });
		if (signal?.aborted) abort();
		this.workspaceControls.add(controller);
		const job = this.readWorkspace(workspaceId, read, controller.signal);
		const settled = job.then(
			() => undefined,
			() => undefined,
		);
		this.controls.add(settled);
		try {
			return await job;
		} finally {
			signal?.removeEventListener("abort", abort);
			this.workspaceControls.delete(controller);
			this.controls.delete(settled);
		}
	}
	private async readWorkspace<T>(
		workspaceId: string,
		read: (client: AcpClient, cwd: string) => Promise<T>,
		signal?: AbortSignal,
	): Promise<T> {
		if (this.stopping) throw new AppProblem("unavailable", "The server is shutting down.");
		signal?.throwIfAborted();
		let client: AcpClient | undefined, row: ChildRow | undefined;
		const abort = () => client?.transport.close();
		try {
			const workspace = await this.workspaces.get(workspaceId);
			if (this.stopping) throw new AppProblem("unavailable", "The server is shutting down.");
			signal?.throwIfAborted();
			client = new AcpClient(await startAcpChild(workspace.path, this.env));
			signal?.addEventListener("abort", abort, { once: true });
			signal?.throwIfAborted();
			if (!client.transport.pid) throw new AppProblem("upstream_acp", "ACP inventory child did not start.");
			row = await this.children.record(client.transport.pid, randomUUID(), workspaceId, true);
			await client.initialize();
			signal?.throwIfAborted();
			return await read(client, workspace.path);
		} finally {
			signal?.removeEventListener("abort", abort);
			try {
				if (client) {
					client.transport.close();
					if (!(await client.transport.waitForExit(500))) await client.transport.forceTerminate();
				}
			} finally {
				if (row && !(await childRunning(row.pid))) await this.children.remove(row);
			}
		}
	}
	async ledgerCommand(workspaceId: string, id: string, action: "label" | "delete", label?: string) {
		if (label !== undefined && Buffer.byteLength(label) > 256)
			throw new AppProblem("validation", "Session label exceeds 256 UTF-8 bytes.");
		const entry = this.entries.get(id);
		const params = { sessionId: id, ...(label === undefined ? {} : { label }) };
		const method = action === "delete" ? "session/delete" : ACP_SESSION_LABEL_METHOD;
		if (entry) {
			if (action === "delete" || entry.closing) throw new AppProblem("conflict", "Close the session before deleting it.");
			await entry.client.request(method, params);
		} else {
			const job = this.control(workspaceId, id, method, params);
			this.controls.add(job);
			try {
				await job;
			} finally {
				this.controls.delete(job);
			}
		}
		if (action === "delete") this.snapshots.delete(id);
		else if (this.snapshots.has(id))
			this.publish({
				type: "session.labelled",
				payload: { resource: id, revision: this.revision(id), label: label || null },
			});
		return {};
	}
	/** A closed ledger needs an initialized, unbound ACP peer; loading it would make deletion inadmissible. */
	private async control(workspaceId: string, id: string, method: string, params: unknown) {
		if (this.stopping) throw new AppProblem("unavailable", "The server is shutting down.");
		if (this.loading.has(id)) throw new AppProblem("conflict", "A session command is already in progress.");
		this.starting++;
		this.loading.add(id);
		try {
			await this.workspaceControl(workspaceId, async (client) => {
				await client.request(method, params);
			});
		} finally {
			this.starting--;
			this.loading.delete(id);
		}
	}
	async close(id: string) {
		const entry = this.entries.get(id);
		if (entry) {
			// An explicit close wins over a parking already under way.
			entry.parking = false;
			await this.retire(entry);
		} else if (this.snapshots.get(id)?.state === "parked") {
			this.state(id, "closed");
			this.prune();
		}
		return this.get(id);
	}
	private retire(entry: Entry) {
		entry.retired ??= this.retireEntry(entry);
		return entry.retired;
	}
	private retireDetached(entry: Entry) {
		void this.retire(entry).catch(() => {
			if (this.snapshots.has(entry.id)) this.state(entry.id, "unknown");
		});
	}
	private async retireEntry(entry: Entry) {
		entry.closing = true;
		clearTimeout(entry.jobTimer);
		try {
			if (
				(entry.turnId || entry.contextCommand || this.snapshot(entry.id).contextWork?.active) &&
				!entry.queued &&
				!entry.client.transport.closed
			) {
				await entry.client.request("session/cancel", { sessionId: entry.id }, 2000);
				entry.permissions?.cancel();
				entry.interviews?.cancel();
				let timer: ReturnType<typeof setTimeout> | undefined;
				await Promise.race([
					entry.contextCommand ?? entry.prompt,
					new Promise<void>((resolve) => {
						timer = setTimeout(resolve, 2000);
					}),
				]);
				if (timer) clearTimeout(timer);
			}
			await entry.client.close(entry.id);
		} catch {
			await entry.client.transport.forceTerminate();
		}
		this.failTurn(entry, new AppProblem("upstream_acp", "ACP session closed during its turn."));
		if (!(await childRunning(entry.row.pid))) {
			await this.recoverLedger(entry.row.workspaceId, entry.id);
			await this.children.remove(entry.row);
			const snapshot = this.snapshots.get(entry.id);
			// A task nobody typed into has nothing to come back to, so it closes like any other.
			const parks =
				entry.parking &&
				!!snapshot &&
				(snapshot.turns.length + snapshot.timeline.length > 0 || !!snapshot.contextWork?.latest);
			if (parks) {
				this.parked.push(entry.id);
				const level = await entry.client.autonomy(entry.id).catch(() => null);
				if (level?.source === "session") this.parkedAutonomy.set(entry.id, level.level);
			}
			this.state(entry.id, parks ? "parked" : "closed");
			if (entry.parking && !parks) this.snapshots.delete(entry.id);
		} else this.state(entry.id, "unknown");
		this.entries.delete(entry.id);
		this.prune();
	}
	/**
	 * Bound what stays in memory. The oldest parked tasks are closed and forgotten here, which leaves each
	 * one as its saved row in the task list, and old closed ones are forgotten.
	 */
	private prune() {
		this.parked = this.parked.filter((id) => this.snapshots.get(id)?.state === "parked");
		for (const id of this.parked.splice(0, Math.max(0, this.parked.length - PARKED_KEPT))) {
			this.state(id, "closed");
			this.snapshots.delete(id);
			this.parkedAutonomy.delete(id);
		}
		const closed = [...this.snapshots.values()].filter(
			(snapshot) => snapshot.state === "closed" && !this.entries.has(snapshot.id),
		);
		for (const snapshot of closed.slice(0, -16)) this.snapshots.delete(snapshot.id);
	}
	async shutdown() {
		this.stopping = true;
		for (const controller of this.workspaceControls) controller.abort();
		clearInterval(this.monitor);
		await Promise.allSettled(this.opening);
		await Promise.allSettled(this.controls);
		await Promise.allSettled([...this.entries.values()].map((entry) => this.retire(entry)));
		await Promise.all(this.reapers);
	}
}

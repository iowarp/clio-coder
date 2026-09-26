import { randomUUID } from "node:crypto";
import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";
import { TURN_IMAGES_MAX_BASE64, type TurnImage } from "../../contracts/attachments.js";
import { SessionBoard } from "../../contracts/board.js";
import { SessionTree } from "../../contracts/branches.js";
import { Id } from "../../contracts/common.js";
import { ContextLedger } from "../../contracts/context-ledger.js";
import {
	FleetPreview,
	type FleetPreviewRequest,
	type FleetRunRequest,
	FleetRunResult,
} from "../../contracts/fleet-run.js";
import { HandoffCancelled, HandoffCommitted, HandoffDraft } from "../../contracts/handoff.js";
import type { PermissionDecision } from "../../contracts/permissions.js";
import type { SetConfigOption } from "../../contracts/session-config.js";
import { applySessionDelta, boundedText, emptySession } from "../../contracts/session-projection.js";
import {
	Provenance,
	type SessionDelta,
	type SessionSnapshot,
	type TimelineItem,
	type Turn,
} from "../../contracts/sessions.js";
import { type AutonomyLevel, SafeSettings, type SafeSettingsPatch } from "../../contracts/settings-safe.js";
import {
	CommandCatalog,
	type CommandRequest,
	CommandResult,
	type DispatchSteerRequest,
	DispatchSteerResult,
	InterruptResult,
	QueueCleared,
	QueueSnapshot,
	type SteerRequest,
	SteerResult,
} from "../../contracts/steering.js";
import { SessionTargets, TargetProbe } from "../../contracts/targets.js";
import { childRunning, startAcpChild } from "../process-policy.js";
import type { EventHub } from "../services/event-hub.js";
import { AppProblem } from "../services/problem.js";
import type { WorkspaceService } from "../services/workspaces.js";
import type { AppFiles } from "../state/files.js";
import { type ChildRow, ChildrenFile } from "./children-file.js";
import { AcpClient, acpProblem, record } from "./client.js";
import { fleetEvent } from "./fleet-events.js";
import { Permissions, type PermissionTimers } from "./permissions.js";
import { projectConfigOptions } from "./session-config.js";

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
	client: AcpClient;
	row: ChildRow;
	turnId: string | null;
	replay: number | null;
	closing: boolean;
	bound: boolean;
	permissions?: Permissions;
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
};
/** A branch change reads and replays a whole session, which a long one makes slow. */
const BRANCH_TIMEOUT_MS = 60_000;
/** Longest a command reply may take; see invokeCommand. */
const COMMAND_TIMEOUT_MS = 10 * 60_000;

export class Supervisor {
	readonly children: ChildrenFile;
	private readonly snapshots = new Map<string, SessionSnapshot>();
	private readonly entries = new Map<string, Entry>();
	private readonly reapers = new Set<Promise<void>>();
	private starting = 0;
	private readonly opening = new Set<Promise<SessionSnapshot>>();
	private readonly controls = new Set<Promise<void>>();
	private readonly loading = new Set<string>();
	private readonly configuring = new Set<string>();
	private stopping = false;
	private readonly monitor: ReturnType<typeof setInterval>;
	constructor(
		private readonly workspaces: WorkspaceService,
		files: AppFiles,
		private readonly hub: EventHub,
		private readonly env: NodeJS.ProcessEnv = process.env,
		readonly capacity = 4,
		private readonly permissionTimers?: PermissionTimers,
	) {
		this.children = new ChildrenFile(files);
		this.monitor = setInterval(() => {
			for (const entry of this.entries.values())
				if (!entry.closing && entry.client.transport.closed) this.retireDetached(entry);
		}, 200);
		this.monitor.unref();
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
	get busy() {
		return (
			!!(
				this.starting ||
				this.opening.size ||
				this.controls.size ||
				this.loading.size ||
				this.configuring.size ||
				this.reapers.size
			) || [...this.entries.values()].some((entry) => entry.turnId !== null || !!entry.closing)
		);
	}
	private publish(event: SessionDelta) {
		const current = this.snapshots.get(event.payload.resource);
		if (!current) return;
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
			this.snapshots.set(row.sessionId, emptySession(row.sessionId, row.workspaceId));
			this.state(row.sessionId, "unknown", true);
			const job = this.children
				.reap(row)
				.then((result) => {
					if (result !== "unknown" && result !== "other-owner") this.state(row.sessionId, "closed", true);
				})
				.catch(() => {
					/* Retain unknown and its durable ownership row for the next reconciliation. */
				});
			this.reapers.add(job);
			void job.finally(() => this.reapers.delete(job));
		}
	}
	async open(workspaceId: string, existingId?: string) {
		const pending = this.openSession(workspaceId, existingId);
		this.opening.add(pending);
		try {
			return await pending;
		} finally {
			this.opening.delete(pending);
		}
	}
	private async openSession(workspaceId: string, existingId?: string) {
		if (this.stopping) throw new AppProblem("unavailable", "The server is shutting down.");
		if (existingId && (this.entries.has(existingId) || this.loading.has(existingId)))
			throw new AppProblem("conflict", "Session is already open in this server.");
		if (this.entries.size + this.starting >= this.capacity)
			throw new AppProblem("conflict", `At most ${this.capacity} sessions can be open at once.`);
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
				client: new AcpClient(transport),
				row,
				turnId: null,
				replay: null,
				closing: false,
				bound: false,
				eventSequence: 0,
			};
			this.snapshots.set(id, emptySession(id, workspaceId));
			this.entries.set(id, entry);
			this.starting--;
			const owned = entry;
			owned.permissions = new Permissions(
				(type, permission) =>
					this.publish({ type, payload: { resource: owned.id, revision: this.revision(owned.id), permission } }),
				() => this.cancelEntry(owned),
				this.permissionTimers,
			);
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
			transport.onNotification("_clio-coder/event", (params) => {
				try {
					const projected = fleetEvent(params, owned.id, owned.eventSequence);
					// The sequence advances even for a dropped kind, so a later frame
					// is still checked against the newest number this session saw
					// rather than against the last one that happened to project.
					owned.eventSequence = projected.sequence;
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
			const boundId = await entry.client.open(workspace.path, existingId);
			if (entry.replay !== null && entry.turnId) this.finish(entry, "end_turn", null, null, null);
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
			if (entry.client.config)
				this.publish({
					type: "session.configured",
					payload: { resource: boundId, revision: this.revision(boundId), config: entry.client.config },
				});
			if (this.stopping) {
				await this.retire(entry);
				throw new AppProblem("unavailable", "Server shut down while opening the session.");
			}
			this.state(boundId, "open");
			return this.get(boundId);
		} catch (error) {
			if (entry) await this.retire(entry);
			throw acpProblem(error);
		} finally {
			if (!entry) this.starting--;
			if (existingId) this.loading.delete(existingId);
		}
	}
	startTurn(id: string, text: string, images: ReadonlyArray<TurnImage> = []) {
		const entry = this.entries.get(id);
		if (!entry || entry.closing || this.snapshot(id).state !== "open")
			throw new AppProblem("conflict", "Session is not available for a turn.");
		if (entry.turnId) throw new AppProblem("conflict", "A turn is already running in this session.");
		if (this.configuring.has(id)) throw new AppProblem("conflict", "Session configuration is being changed.");
		if (entry.rebase) throw new AppProblem("conflict", "The conversation is moving to another branch.");
		if (entry.drafting) throw new AppProblem("conflict", "Clio Coder is drawing up a handoff for this conversation.");
		if (images.length > 0 && !entry.client.capabilities.images)
			throw new AppProblem("conflict", "This Clio Coder build does not accept images with a request.");
		if (images.reduce((total, image) => total + image.data.length, 0) > TURN_IMAGES_MAX_BASE64)
			throw new AppProblem(
				"validation",
				"Attached images exceed what one request can carry. Remove one or use smaller images.",
			);
		entry.replay = null;
		const turnId = this.begin(entry, text, "live", randomUUID(), images.length);
		entry.prompt = entry.client
			.prompt(id, text, images)
			.then((result) => {
				if (entry.turnId === turnId) this.finish(entry, result.stopReason, result.usage, null, new Date().toISOString());
			})
			.catch((error) => {
				if (entry.turnId === turnId) this.failTurn(entry, acpProblem(error));
			});
		return { turnId };
	}
	private begin(entry: Entry, prompt: string, origin: "live" | "replay", id: string = randomUUID(), images = 0) {
		const turn: Turn = {
			id,
			prompt,
			origin,
			status: "running",
			startedAt: origin === "live" ? new Date().toISOString() : null,
			finishedAt: null,
			stopReason: null,
			usage: null,
			problem: null,
			...(images > 0 ? { images } : {}),
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
	) {
		if (!entry.turnId) return;
		entry.permissions?.cancel();
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
			},
		});
		entry.turnId = null;
	}
	private failTurn(entry: Entry, problem: AppProblem) {
		this.finish(entry, "failed", null, problem.problem, new Date().toISOString());
	}
	private update(entry: Entry, value: unknown) {
		const params = record(value),
			update = record(params.update),
			meta = record(params._meta);
		const metadataUpdate =
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
		if (update.sessionUpdate === "config_option_update") {
			const options = projectConfigOptions(update.configOptions);
			if (options === undefined) throw new AppProblem("upstream_acp", "Clio Coder omitted session configuration.");
			const target = record(meta["clio-coder/session"]).target;
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
		if (metadataUpdate) return;
		if (entry.rebase?.mode === "switch" && !entry.rebase.reset) this.resetTimeline(entry);
		const replay = record(meta["clio-coder/replay"]).turn;
		if (typeof replay === "number" && Number.isInteger(replay) && replay > 0 && replay !== entry.replay) {
			if (entry.turnId) this.finish(entry, "end_turn", null, null, null);
			entry.replay = replay;
			this.begin(entry, "", "replay", `replay-${replay}`);
		}
		if (!entry.turnId) throw new AppProblem("upstream_acp", "ACP update arrived without a turn.");
		const origin = entry.replay === null ? ("live" as const) : ("replay" as const);
		const attribution = meta["clio-coder/agent"];
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
			if (update.rawOutput) item.rawOutput = this.raw(update.rawOutput);
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
		return entry;
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
		await this.cancelEntry(entry);
		return {};
	}
	private async cancelEntry(entry: Entry) {
		try {
			await entry.client.request("session/cancel", { sessionId: entry.id }, 2000);
			entry.permissions?.cancel();
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
			patch ? "_clio-coder/settings/patch_safe" : "_clio-coder/settings/get_safe",
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
			const next = { ...this.snapshot(id).config, options };
			this.publish({ type: "session.configured", payload: { resource: id, revision: this.revision(id), config: next } });
			return next;
		} finally {
			this.configuring.delete(id);
		}
	}
	async targets(id: string) {
		const raw = record(await this.active(id).client.request("_clio-coder/targets/list", {}));
		const projected = Value.Clean(SessionTargets, {
			targets: raw.targets,
			truncated: record(raw._meta)["clio-coder/truncated"] === true,
		});
		if (!Value.Check(SessionTargets, projected))
			throw new AppProblem("upstream_acp", "Clio returned an invalid target list.");
		return projected;
	}
	probe(id: string, targetId: string) {
		return this.projected(id, "_clio-coder/targets/probe", { targetId }, TargetProbe);
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
		return entry;
	}
	steer(id: string, body: Static<typeof SteerRequest>) {
		this.steering(id);
		return this.projected(id, "_clio-coder/session/steer", { sessionId: id, ...body }, SteerResult);
	}
	queue(id: string) {
		this.steering(id);
		return this.projected(id, "_clio-coder/session/queue", { sessionId: id }, QueueSnapshot);
	}
	clearQueue(id: string) {
		this.steering(id);
		return this.projected(id, "_clio-coder/session/queue_clear", { sessionId: id }, QueueCleared);
	}
	interrupt(id: string, reason?: string) {
		this.steering(id);
		return this.projected(
			id,
			"_clio-coder/session/interrupt",
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
			"_clio-coder/dispatch/steer",
			{ sessionId: id, runId, action, ...(action === "guide" && message ? { message } : {}) },
			DispatchSteerResult,
		);
	}
	board(id: string) {
		const entry = this.active(id);
		if (!entry.client.capabilities.board)
			throw new AppProblem("conflict", "This Clio build does not report tasks and decisions.");
		return this.projected(id, "_clio-coder/session/board", { sessionId: id }, SessionBoard);
	}
	private branching(id: string) {
		const entry = this.active(id);
		if (!entry.client.capabilities.branches)
			throw new AppProblem("conflict", "This Clio Coder build cannot show or change conversation branches.");
		return entry;
	}
	tree(id: string) {
		this.branching(id);
		return this.projected(id, "_clio-coder/session/tree", { sessionId: id }, SessionTree);
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
		});
		this.state(nextId, "open");
		this.state(parentId, "closed");
	}
	async switchTurn(id: string, turnId: string) {
		const entry = this.beginRebase(id, { mode: "switch", reset: false });
		try {
			const result = record(
				await entry.client.request("_clio-coder/session/switch_turn", { sessionId: id, turnId }, BRANCH_TIMEOUT_MS),
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
				await entry.client.request("_clio-coder/session/fork", { sessionId: id, turnId }, BRANCH_TIMEOUT_MS),
			);
			const forkedId = await this.settleMove(entry, id, result);
			const sessionMeta = record(record(result._meta)["clio-coder/session"]);
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
	contextLedger(id: string) {
		const entry = this.active(id);
		if (!entry.client.capabilities.context)
			throw new AppProblem("conflict", "This Clio Coder build does not report its context window.");
		return this.projected(id, "_clio-coder/context/ledger", { sessionId: id }, ContextLedger);
	}
	private fleeting(id: string) {
		const entry = this.active(id);
		if (!entry.client.capabilities.fleet)
			throw new AppProblem("conflict", "This Clio Coder build cannot preview or start a fleet contract.");
		return entry;
	}
	fleetPreview(id: string, body: Static<typeof FleetPreviewRequest>) {
		this.fleeting(id);
		// Compiling reads the contract, the agents and every route; a large fleet is not instant.
		return this.projected(id, "_clio-coder/fleet/preview", { sessionId: id, ...body }, FleetPreview, BRANCH_TIMEOUT_MS);
	}
	fleetRun(id: string, body: Static<typeof FleetRunRequest>) {
		const entry = this.fleeting(id);
		if (entry.turnId || entry.rebase || entry.drafting)
			throw new AppProblem("conflict", "Wait for the current turn to finish before starting a fleet run.");
		return this.projected(id, "_clio-coder/fleet/run", { sessionId: id, ...body }, FleetRunResult, BRANCH_TIMEOUT_MS);
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
				"_clio-coder/session/handoff/prepare",
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
				await entry.client.request(
					"_clio-coder/session/handoff/commit",
					{ sessionId: id, handoffId, document },
					BRANCH_TIMEOUT_MS,
				),
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
		return this.projected(id, "_clio-coder/session/handoff/cancel", { sessionId: id, handoffId }, HandoffCancelled);
	}
	commands(id: string) {
		const entry = this.active(id);
		if (!entry.client.capabilities.commands)
			throw new AppProblem("conflict", "This Clio build exposes no operator commands.");
		return this.projected(id, "_clio-coder/commands/list", {}, CommandCatalog);
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
			(command?.injectsUserTurn && (body.command !== "tasks" || subcommand === "hand")) ||
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
		return this.projected(
			id,
			"_clio-coder/commands/invoke",
			{ sessionId: id, command: body.command, ...(body.argv ? { argv: body.argv } : {}) },
			CommandResult,
			// A context command answers when its work ends: compaction or a model-written handbook can take minutes.
			COMMAND_TIMEOUT_MS,
		);
	}
	async ledgerCommand(workspaceId: string, id: string, action: "label" | "delete", label?: string) {
		if (label !== undefined && Buffer.byteLength(label) > 256)
			throw new AppProblem("validation", "Session label exceeds 256 UTF-8 bytes.");
		const entry = this.entries.get(id);
		const params = { sessionId: id, ...(label === undefined ? {} : { label }) };
		const method = action === "delete" ? "session/delete" : "_clio-coder/session/label";
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
		if (this.stopping || this.entries.size + this.starting >= this.capacity)
			throw new AppProblem("conflict", "No ACP control capacity is available.");
		if (this.loading.has(id)) throw new AppProblem("conflict", "A session command is already in progress.");
		this.starting++;
		this.loading.add(id);
		let client: AcpClient | undefined, row: ChildRow | undefined;
		try {
			const workspace = await this.workspaces.get(workspaceId);
			client = new AcpClient(await startAcpChild(workspace.path, this.env));
			if (!client.transport.pid) throw new AppProblem("upstream_acp", "ACP control child did not start.");
			row = await this.children.record(client.transport.pid, id, workspaceId);
			await client.initialize();
			await client.request(method, params);
		} finally {
			try {
				if (client) {
					client.transport.close();
					if (!(await client.transport.waitForExit(500))) await client.transport.forceTerminate();
				}
				if (row && !(await childRunning(row.pid))) await this.children.remove(row);
			} finally {
				this.starting--;
				this.loading.delete(id);
			}
		}
	}
	async close(id: string) {
		const entry = this.entries.get(id);
		if (entry) await this.retire(entry);
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
		try {
			if (entry.turnId && !entry.client.transport.closed) {
				await entry.client.request("session/cancel", { sessionId: entry.id }, 2000);
				entry.permissions?.cancel();
				let timer: ReturnType<typeof setTimeout> | undefined;
				await Promise.race([
					entry.prompt,
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
			await this.children.remove(entry.row);
			this.state(entry.id, "closed");
		} else this.state(entry.id, "unknown");
		this.entries.delete(entry.id);
		const closed = [...this.snapshots.values()].filter(
			(snapshot) => snapshot.state === "closed" && !this.entries.has(snapshot.id),
		);
		for (const snapshot of closed.slice(0, -16)) this.snapshots.delete(snapshot.id);
	}
	async shutdown() {
		this.stopping = true;
		clearInterval(this.monitor);
		await Promise.allSettled(this.opening);
		await Promise.allSettled(this.controls);
		await Promise.allSettled([...this.entries.values()].map((entry) => this.retire(entry)));
		await Promise.all(this.reapers);
	}
}

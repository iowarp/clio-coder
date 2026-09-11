import { randomUUID } from "node:crypto";
import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";
import type { PermissionDecision } from "../../contracts/permissions.js";
import { applySessionDelta, boundedText, emptySession } from "../../contracts/session-projection.js";
import {
	Provenance,
	type SessionDelta,
	type SessionSnapshot,
	type TimelineItem,
	type Turn,
} from "../../contracts/sessions.js";
import { Autonomy, type AutonomyLevel, SafeSettings, type SafeSettingsPatch } from "../../contracts/settings-safe.js";
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

type Entry = {
	id: string;
	client: AcpClient;
	row: ChildRow;
	turnId: string | null;
	replay: number | null;
	closing: boolean;
	permissions?: Permissions;
	eventSequence: number;
	prompt?: Promise<void>;
	retired?: Promise<void>;
};
export class Supervisor {
	readonly children: ChildrenFile;
	private readonly snapshots = new Map<string, SessionSnapshot>();
	private readonly entries = new Map<string, Entry>();
	private readonly reapers = new Set<Promise<void>>();
	private starting = 0;
	private readonly opening = new Set<Promise<SessionSnapshot>>();
	private readonly controls = new Set<Promise<void>>();
	private readonly loading = new Set<string>();
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
	get(id: string) {
		const value = this.snapshots.get(id);
		if (!value) throw new AppProblem("not_found", "Session is not open in this server.");
		return structuredClone(value);
	}
	list() {
		return [...this.snapshots.values()].map((value) => structuredClone(value));
	}
	private publish(event: SessionDelta) {
		const current = this.snapshots.get(event.payload.resource);
		if (!current) return;
		this.snapshots.set(current.id, applySessionDelta(current, event));
		this.hub.publish(event);
	}
	private revision(id: string) {
		return this.get(id).revision + 1;
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
			entry = { id, client: new AcpClient(transport), row, turnId: null, replay: null, closing: false, eventSequence: 0 };
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
					return owned.permissions?.request(owned.id, owned.turnId, params, this.get(owned.id).timeline);
				} catch (error) {
					this.failTurn(owned, acpProblem(error));
					this.retireDetached(owned);
					throw error;
				}
			});
			transport.onNotification("clio-coder/event", (params) => {
				try {
					const { type, item } = fleetEvent(params, owned.id, owned.eventSequence);
					owned.eventSequence = item.sourceSequence;
					this.publish({ type, payload: { resource: owned.id, revision: this.revision(owned.id), item } });
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
	startTurn(id: string, text: string) {
		const entry = this.entries.get(id);
		if (!entry || entry.closing || this.get(id).state !== "open")
			throw new AppProblem("conflict", "Session is not available for a turn.");
		if (entry.turnId) throw new AppProblem("conflict", "A turn is already running in this session.");
		entry.replay = null;
		const turnId = this.begin(entry, text, "live");
		entry.prompt = entry.client
			.prompt(id, text)
			.then((result) => {
				if (entry.turnId === turnId) this.finish(entry, result.stopReason, result.usage, null, new Date().toISOString());
			})
			.catch((error) => {
				if (entry.turnId === turnId) this.failTurn(entry, acpProblem(error));
			});
		return { turnId };
	}
	private begin(entry: Entry, prompt: string, origin: "live" | "replay", id: string = randomUUID()) {
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
		if (params.sessionId !== entry.id)
			throw new AppProblem("upstream_acp", "ACP update has a different session identity.");
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
			const previous = this.get(entry.id).timeline.find(
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
			if (update.rawOutput || update.content) item.rawOutput = this.raw(update.rawOutput ?? { content: update.content });
			this.publish({ type: "turn.tool", payload: { resource: entry.id, revision: this.revision(entry.id), item } });
			return;
		}
		throw new AppProblem("upstream_acp", "ACP update type is unsupported.");
	}
	private raw(value: unknown) {
		const text = JSON.stringify(value);
		return Buffer.byteLength(text) <= 32768 ? record(value) : { truncated: true, snippet: boundedText(text, 32000) };
	}
	private active(id: string) {
		const entry = this.entries.get(id);
		if (!entry || entry.closing || this.get(id).state !== "open")
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
			if (this.get(id).turns.some((turn) => turn.id === turnId && turn.status !== "running")) return {};
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
	): Promise<Static<S>> {
		const raw = await this.active(id).client.request(method, params),
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
			patch ? "clio-coder/settings/patch_safe" : "clio-coder/settings/get_safe",
			patch ? { patch } : {},
			SafeSettings,
		);
	}
	async targets(id: string) {
		const raw = record(await this.active(id).client.request("clio-coder/targets/list", {}));
		const projected = Value.Clean(SessionTargets, {
			targets: raw.targets,
			truncated: record(raw._meta)["clio-coder/truncated"] === true,
		});
		if (!Value.Check(SessionTargets, projected))
			throw new AppProblem("upstream_acp", "Clio returned an invalid target list.");
		return projected;
	}
	probe(id: string, targetId: string) {
		return this.projected(id, "clio-coder/targets/probe", { targetId }, TargetProbe);
	}
	autonomy(id: string, level?: Static<typeof AutonomyLevel>) {
		return this.projected(id, "clio-coder/session/autonomy", { sessionId: id, ...(level ? { level } : {}) }, Autonomy);
	}
	async ledgerCommand(workspaceId: string, id: string, action: "label" | "delete", label?: string) {
		if (label !== undefined && Buffer.byteLength(label) > 256)
			throw new AppProblem("validation", "Session label exceeds 256 UTF-8 bytes.");
		const entry = this.entries.get(id);
		const params = { sessionId: id, ...(label === undefined ? {} : { label }) };
		if (entry) {
			if (action === "delete" || entry.closing) throw new AppProblem("conflict", "Close the session before deleting it.");
			await entry.client.request(`clio-coder/session/${action}`, params);
		} else {
			const job = this.control(workspaceId, id, `clio-coder/session/${action}`, params);
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

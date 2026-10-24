import { Value } from "typebox/value";
import { SessionSummary } from "../../contracts/sessions.js";
import { ACP_SESSION_LIST_METHOD, ACP_SESSION_META_KEY, AcpSessionList } from "../../contracts/wire.js";
import type { Supervisor } from "../acp/supervisor.js";
import { AppProblem } from "./problem.js";
import type { WorkspaceService } from "./workspaces.js";
export class SessionService {
	private readonly historyReads = new Map<
		string,
		{ controller: AbortController; readers: Set<symbol>; result: Promise<SessionSummary[]> }
	>();
	constructor(
		readonly supervisor: Supervisor,
		readonly workspaces: WorkspaceService,
	) {}
	async history(workspaceId: string, signal?: AbortSignal): Promise<SessionSummary[]> {
		signal?.throwIfAborted();
		let read = this.historyReads.get(workspaceId);
		if (!read || read.controller.signal.aborted) {
			const controller = new AbortController();
			read = { controller, readers: new Set(), result: this.readHistory(workspaceId, controller.signal) };
			this.historyReads.set(workspaceId, read);
			const current = read;
			const settled = () => {
				if (this.historyReads.get(workspaceId) === current) this.historyReads.delete(workspaceId);
			};
			void read.result.then(settled, settled);
		}
		const shared = read;
		const reader = Symbol();
		shared.readers.add(reader);
		return new Promise((resolve, reject) => {
			const release = () => {
				signal?.removeEventListener("abort", aborted);
				shared.readers.delete(reader);
				if (shared.readers.size === 0) shared.controller.abort();
			};
			const aborted = () => {
				release();
				reject(signal?.reason);
			};
			signal?.addEventListener("abort", aborted, { once: true });
			void shared.result.then(
				(rows) => {
					release();
					if (signal?.aborted) reject(signal.reason);
					else resolve(structuredClone(rows));
				},
				(error: unknown) => {
					release();
					reject(error);
				},
			);
		});
	}
	private async readHistory(workspaceId: string, signal: AbortSignal): Promise<SessionSummary[]> {
		return this.supervisor.workspaceControl(
			workspaceId,
			async (client, cwd) => {
				if (!client.capabilities.session?.list)
					throw new AppProblem("unsupported", "This Clio build does not expose session history.");
				const history: SessionSummary[] = [];
				const cursors = new Set<string>();
				let cursor: string | undefined;
				do {
					const raw = await client.request<unknown>(ACP_SESSION_LIST_METHOD, { cwd, ...(cursor ? { cursor } : {}) });
					const page = Value.Clean(AcpSessionList, raw);
					if (!Value.Check(AcpSessionList, page))
						throw new AppProblem("upstream_acp", "Clio returned invalid session history.");
					for (const row of page.sessions) {
						const meta = row._meta?.[ACP_SESSION_META_KEY];
						if (!meta || row.cwd !== cwd) throw new AppProblem("upstream_acp", "Clio omitted workspace session metadata.");
						const projected = Value.Clean(SessionSummary, {
							...meta,
							id: row.sessionId,
							workspaceId,
							...(row.title !== undefined ? { name: row.title } : {}),
							lastActivityAt: meta.lastActivityAt ?? row.updatedAt,
						});
						if (!Value.Check(SessionSummary, projected))
							throw new AppProblem("upstream_acp", "Clio returned invalid session metadata.");
						history.push(projected);
					}
					cursor = page.nextCursor;
					if (cursor) {
						if (cursors.has(cursor) || page.sessions.length === 0)
							throw new AppProblem("upstream_acp", "Clio returned an invalid history cursor.");
						cursors.add(cursor);
					}
				} while (cursor);
				return history;
			},
			signal,
		);
	}
	async load(workspaceId: string, id: string) {
		if (!(await this.history(workspaceId)).some((row) => row.id === id))
			throw new AppProblem("not_found", "Session was not found in this workspace's ledger.");
		return this.supervisor.open(workspaceId, id);
	}
	async ledgerCommand(id: string, action: "label" | "delete", workspaceId?: string, label?: string) {
		const workspace = workspaceId ?? this.supervisor.get(id).workspaceId;
		const row = (await this.history(workspace)).find((row) => row.id === id);
		if (!row) throw new AppProblem("not_found", "Session was not found in this workspace's ledger.");
		if (action === "delete" && row.endedAt === null)
			throw new AppProblem("conflict", "Close the session before deleting it.");
		return this.supervisor.ledgerCommand(workspace, id, action, label);
	}
}

import { Value } from "typebox/value";
import { SessionSummary } from "../../contracts/sessions.js";
import type { Supervisor } from "../acp/supervisor.js";
import type { WorkerHost } from "../worker/host.js";
import { AppProblem } from "./problem.js";
import type { WorkspaceService } from "./workspaces.js";
export class SessionService {
	constructor(
		readonly supervisor: Supervisor,
		readonly workspaces: WorkspaceService,
		private readonly reads: WorkerHost,
	) {}
	async history(workspaceId: string): Promise<SessionSummary[]> {
		const workspace = await this.workspaces.get(workspaceId),
			raw = await this.reads.call("sessions.list", { cwd: workspace.path });
		if (!Array.isArray(raw)) throw new AppProblem("unavailable", "Session history is unavailable.");
		return raw.flatMap((row) => {
			if (!row || typeof row !== "object") return [];
			const projected = Value.Clean(SessionSummary, { ...row, workspaceId });
			return Value.Check(SessionSummary, projected) ? [projected] : [];
		});
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

import { Value } from "typebox/value";
import { Interop, SystemReport } from "../../contracts/system.js";
import type { WorkerHost } from "../worker/host.js";
import { AppProblem } from "./problem.js";
import type { WorkspaceService } from "./workspaces.js";

export class SystemService {
	constructor(
		private readonly reads: WorkerHost,
		private readonly workspaces: WorkspaceService,
	) {}
	async report() {
		const value = Value.Clean(SystemReport, await this.reads.call("system.read", {}));
		if (!Value.Check(SystemReport, value))
			throw new AppProblem("unavailable", "System inspection returned an invalid projection.");
		return value;
	}
	async interop(workspaceId: string) {
		const workspace = await this.workspaces.get(workspaceId);
		const value = Value.Clean(
			Interop,
			await this.reads.call("interop.read", { cwd: workspace.path }, { deadlineMs: 25_000 }),
		);
		if (!Value.Check(Interop, value))
			throw new AppProblem("unavailable", "External agent inspection returned an invalid projection.");
		return value;
	}
}

import { Value } from "typebox/value";
import { ConfigGraph, SettingsReport } from "../../contracts/settings.js";
import type { WorkerHost } from "../worker/host.js";
import { AppProblem } from "./problem.js";
import type { WorkspaceService } from "./workspaces.js";

export class SettingsService {
	constructor(
		private readonly reads: WorkerHost,
		private readonly workspaces: WorkspaceService,
	) {}
	async settings(workspaceId: string) {
		const workspace = await this.workspaces.get(workspaceId);
		const report = await this.reads.call("settings.read", { cwd: workspace.path });
		if (!Value.Check(SettingsReport, report))
			throw new AppProblem("unavailable", "Settings returned an invalid projection.");
		return report;
	}
	async graph(workspaceId: string) {
		const workspace = await this.workspaces.get(workspaceId);
		const report = await this.reads.call("config.graph", { cwd: workspace.path }, { deadlineMs: 15_000 });
		if (!Value.Check(ConfigGraph, report))
			throw new AppProblem("unavailable", "Configuration inspection returned an invalid projection.");
		return report;
	}
}

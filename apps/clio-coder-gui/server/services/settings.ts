import { Value } from "typebox/value";
import { ConfigGraph, SettingsReport } from "../../contracts/settings.js";
import { SettingsControls, type SettingWrite, SettingWritten } from "../../contracts/settings-controls.js";
import type { WorkerHost } from "../worker/host.js";
import { AppProblem } from "./problem.js";
import type { WorkspaceService } from "./workspaces.js";

export class SettingsService {
	constructor(
		private readonly reads: WorkerHost,
		private readonly workspaces: WorkspaceService,
		private readonly ops?: WorkerHost,
	) {}
	async controls(workspaceId: string) {
		const workspace = await this.workspaces.get(workspaceId);
		const report = await this.reads.call("settings.controls", { cwd: workspace.path });
		if (!Value.Check(SettingsControls, report))
			throw new AppProblem("unavailable", "Settings controls returned an invalid projection.");
		return report;
	}
	/** Writes are serial in the ops lane and land in the user layer only. */
	async write(workspaceId: string, write: SettingWrite) {
		if (!this.ops) throw new AppProblem("unsupported", "This server was started without a settings writer.");
		const workspace = await this.workspaces.get(workspaceId);
		const result = await this.ops.call("settings.write", { cwd: workspace.path, write });
		if (!Value.Check(SettingWritten, result))
			throw new AppProblem("unavailable", "Settings write returned an invalid projection.");
		return result;
	}
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

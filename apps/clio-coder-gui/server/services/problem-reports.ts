import { Value } from "typebox/value";
import {
	ProblemReportBundle,
	type ProblemReportBundleRequest,
	type ProblemReportChoices,
	type ProblemReportEdits,
	ProblemReportOffer,
	type ProblemReportPlanRequest,
	ProblemReportRows,
	ProblemReportSent,
	ProblemReportView,
} from "../../contracts/problem-reports.js";
import type { WorkerHost } from "../worker/host.js";
import { AppProblem } from "./problem.js";
import type { WorkspaceService } from "./workspaces.js";

/** The report dialog's routes: every decision about what is sent is the report domain's, in the ops lane. */
export class ProblemReportsService {
	constructor(
		private readonly ops: Pick<WorkerHost, "call">,
		private readonly workspaces: Pick<WorkspaceService, "get">,
	) {}
	private async cwd(workspaceId: string) {
		return (await this.workspaces.get(workspaceId)).path;
	}
	async plan(workspaceId: string, input: ProblemReportPlanRequest) {
		const cwd = await this.cwd(workspaceId);
		return this.checked(ProblemReportView, await this.ops.call("reports.plan", { cwd, input }, { deadlineMs: 25_000 }));
	}
	async update(workspaceId: string, draftId: string, edits: ProblemReportEdits) {
		const cwd = await this.cwd(workspaceId);
		return this.checked(
			ProblemReportView,
			await this.ops.call("reports.update", { cwd, draftId, edits }, { deadlineMs: 25_000 }),
		);
	}
	async send(workspaceId: string, draftId: string, choices: ProblemReportChoices) {
		const cwd = await this.cwd(workspaceId);
		// Searching, uploading and posting each have their own 30s budget in the domain.
		return this.checked(
			ProblemReportSent,
			await this.ops.call("reports.send", { cwd, draftId, choices }, { deadlineMs: 150_000 }),
		);
	}
	async bundle(workspaceId: string, draftId: string, request: ProblemReportBundleRequest) {
		const cwd = await this.cwd(workspaceId);
		return this.checked(
			ProblemReportBundle,
			await this.ops.call("reports.bundle", { cwd, draftId, request }, { deadlineMs: 60_000 }),
		);
	}
	async offer(workspaceId: string, sessionId: string) {
		const cwd = await this.cwd(workspaceId);
		return this.checked(ProblemReportOffer, await this.ops.call("reports.offer", { cwd, sessionId }));
	}
	async status(workspaceId: string) {
		const cwd = await this.cwd(workspaceId);
		return this.checked(ProblemReportRows, await this.ops.call("reports.status", { cwd }));
	}
	private checked<
		S extends
			| typeof ProblemReportView
			| typeof ProblemReportSent
			| typeof ProblemReportRows
			| typeof ProblemReportBundle
			| typeof ProblemReportOffer,
	>(schema: S, raw: unknown) {
		const value = Value.Clean(schema, structuredClone(raw));
		if (!Value.Check(schema, value))
			throw new AppProblem("unavailable", "The report host returned an invalid projection.");
		return value as import("typebox").Static<S>;
	}
}

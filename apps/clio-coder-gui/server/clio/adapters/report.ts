import { readLayeredSettings } from "../../../../../src/core/settings-layers.js";
import { resolveClioDirs } from "../../../../../src/core/xdg.js";
import {
	createReportDialogHost,
	ReportDialogError,
	type ReportDialogHost,
} from "../../../../../src/domains/report/dialog-flow.js";
import type {
	ProblemReportChoices,
	ProblemReportEdits,
	ProblemReportPlanRequest,
} from "../../../contracts/problem-reports.js";
import { AppProblem } from "../../services/problem.js";

/**
 * The desktop report dialog's host side (R-24): thin calls into the report domain's dialog flow, which plans with
 * the same `planReport` and sends with the same `runReportSend` as the terminal and ACP. Runs in the ops lane, so
 * `gh` and the browser opener run with this process's environment, as other operations do.
 */
const hosts = new Map<string, ReportDialogHost>();
function hostFor(cwd: string): ReportDialogHost {
	let host = hosts.get(cwd);
	if (host === undefined) {
		host = createReportDialogHost({
			stateDir: resolveClioDirs().state,
			cwd: () => cwd,
			session: (id) => (id === undefined ? null : { id }),
			identitySettings: () => {
				try {
					return { targets: readLayeredSettings(cwd).settings.targets };
				} catch {
					// Unreadable settings mask no target names; every other identity value still applies.
					return {};
				}
			},
		});
		hosts.set(cwd, host);
	}
	return host;
}
async function mapped<T>(work: () => Promise<T>): Promise<T> {
	try {
		return await work();
	} catch (error) {
		if (error instanceof ReportDialogError)
			throw new AppProblem(error.code === "not-found" ? "not_found" : "validation", error.message);
		throw error;
	}
}

export const reportDialog = {
	plan: (cwd: string, input: ProblemReportPlanRequest) => mapped(() => hostFor(cwd).plan(input)),
	update: (cwd: string, draftId: string, edits: ProblemReportEdits) => mapped(() => hostFor(cwd).update(draftId, edits)),
	send: (cwd: string, draftId: string, choices: ProblemReportChoices) =>
		mapped(() => hostFor(cwd).send(draftId, choices)),
	status: async (cwd: string) => ({ rows: await hostFor(cwd).status() }),
};

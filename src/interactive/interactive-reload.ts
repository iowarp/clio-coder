import type { OperatorExtensions } from "../domains/extensions/operator-extensions.js";
import { stripTerminalSequences, wrapTextWithAnsi } from "../engine/tui.js";
import type { ReloadClassesController, ReloadReport, ReloadTarget } from "../session-control/reload-report.js";
import type { CommandOutputSink } from "./command-output.js";
import { clioTheme } from "./theme/index.js";

export function appendReloadReport(report: ReloadReport, sink: CommandOutputSink): void {
	const rows = stripTerminalSequences(report.text).split("\n");
	sink.appendReplayBlock((width) =>
		rows.flatMap((row) =>
			wrapTextWithAnsi(clioTheme().fg(report.failed ? "warning" : "annotation", row), Math.max(1, width)),
		),
	);
	sink.requestRender();
}

export function createInteractiveReload(
	controller: ReloadClassesController | undefined,
	operator: OperatorExtensions | undefined,
	notice: (level: "info" | "warn", text: string) => void,
	print: (report: ReloadReport) => void,
): (target: ReloadTarget) => void {
	return (target) => {
		if (!controller) return notice("warn", "Reload is unavailable: reload coordinator is not loaded.");
		void controller
			.run(target, async () => {
				if (!operator)
					return { status: "rejected", message: "extension host is not loaded", failures: [], nextSession: [] };
				const result = await operator.reload();
				const entries = operator.entries();
				const failures = entries
					.filter((entry) => entry.state === "failed")
					.map((entry) => `${entry.id}: ${entry.reason ?? "runtime failed"}`);
				if ((result.degraded === undefined && result.status === "committed") || (result.degraded ?? 0) > 0)
					failures.push(result.message);
				return {
					...result,
					failures,
					nextSession: entries.flatMap((entry) => entry.newSessionReasons.map((reason) => `${entry.id}: ${reason}`)),
				};
			})
			.then(print)
			.catch((error) => notice("warn", `Reload failed: ${error instanceof Error ? error.message : String(error)}`));
	};
}

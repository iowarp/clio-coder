import { basename } from "node:path";
import type { RunBootstrapResult } from "../../domains/context/index.js";

export function formatContextInitSummary(result: RunBootstrapResult): string {
	const { summary } = result;
	const outcome =
		summary.action === "previewed"
			? "Context preview ready; no files written."
			: summary.action === "proposed"
				? `Context proposal written${summary.proposalPath ? ` to ${summary.proposalPath}` : ""}; review it before /context init --apply.`
				: `CLIO-CODER.md ${summary.action === "wrote" ? "written" : summary.action}.`;
	// The historical codewikiEntries field is populated by indexedSourceFileCount,
	// which counts source files and excludes config files, not symbols or edges.
	const indexed = `${summary.codewikiEntries} source file${summary.codewikiEntries === 1 ? "" : "s"}`;
	const lines = [outcome, summary.action === "previewed" ? `Would index ${indexed}.` : `Indexed ${indexed}.`];
	if (summary.contextFileCount > 0) {
		const names = summary.contextFileNames.map((file) => basename(file));
		const shown = names.slice(0, 3).join(", ");
		lines.push(
			`Read ${summary.contextFileCount} context source${summary.contextFileCount === 1 ? "" : "s"} (${shown}${names.length > 3 ? ` +${names.length - 3}` : ""}).`,
		);
	}
	if (summary.adoption.importedRuleCount > 0) {
		const count = summary.adoption.importedRuleCount;
		lines.push(
			`${summary.adoption.mode === "adopt" ? "Imported" : "Found"} ${count} candidate rule${count === 1 ? "" : "s"}.`,
		);
	}
	return lines.join(" ");
}

import type { ArtifactList } from "../../contracts/artifacts.js";
import type { BranchRow } from "./branch-model.js";

export function paneMatches(query: string, values: readonly (string | null | undefined)[]): boolean {
	const text = values.filter(Boolean).join(" ").toLocaleLowerCase();
	return query
		.trim()
		.toLocaleLowerCase()
		.split(/\s+/)
		.filter(Boolean)
		.every((word) => text.includes(word));
}

export function paneBranchRows(rows: readonly BranchRow[], query: string, kind: string): BranchRow[] {
	return rows.filter((row) => (!kind || row.kind === kind) && paneMatches(query, [row.text, row.label, row.word]));
}

export function paneArtifactRows(
	rows: ArtifactList["artifacts"],
	query: string,
	category: string,
): ArtifactList["artifacts"] {
	return rows.filter(
		(row) =>
			(!category || row.category === category) && paneMatches(query, [row.title, row.subtitle, row.id, row.category]),
	);
}

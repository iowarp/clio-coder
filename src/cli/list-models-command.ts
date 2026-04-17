import { listModels } from "./list-models.js";

export function runListModelsCommand(args: readonly string[]): number | null {
	const idx = args.indexOf("--list-models");
	if (idx === -1) return null;
	const next = args[idx + 1];
	const search = next && !next.startsWith("-") ? next : undefined;
	return listModels(search !== undefined ? { search } : {});
}

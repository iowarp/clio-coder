import { Value } from "typebox/value";
import { ConfigOption, type SessionConfig } from "../../contracts/session-config.js";
import { AppProblem } from "../services/problem.js";
import { record } from "./client.js";

/** Only the conversation controls the GUI acts on cross this seam; arbitrary metadata stays in the child. */
export function projectConfigOptions(raw: unknown): SessionConfig["options"] | undefined {
	if (raw === undefined) return undefined;
	if (!Array.isArray(raw) || raw.length > 16)
		throw new AppProblem("upstream_acp", "Clio Coder returned invalid session configuration.");
	const options: SessionConfig["options"] = [];
	for (const value of raw) {
		const row = record(value);
		if (row.id !== "target" && row.id !== "model" && row.id !== "thinkingLevel") continue;
		const projected = Value.Clean(ConfigOption, structuredClone(row));
		if (!Value.Check(ConfigOption, projected) || options.some((option) => option.id === row.id))
			throw new AppProblem("upstream_acp", "Clio Coder returned invalid session configuration.");
		options.push(projected);
	}
	return options;
}

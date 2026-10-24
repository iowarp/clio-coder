import { Type } from "typebox";
import { Value } from "typebox/value";
import { ConfigOption, type SessionConfig } from "../../contracts/session-config.js";

const UnselectedTarget = Type.Object(
	{ ...ConfigOption.properties, id: Type.Literal("target"), currentValue: Type.Null() },
	{ additionalProperties: false },
);

/** Only the conversation controls the GUI acts on cross this seam; arbitrary metadata stays in the child. */
export function projectSessionConfigOptions(raw: unknown): SessionConfig["options"] | undefined | null {
	if (raw === undefined) return undefined;
	if (!Array.isArray(raw) || raw.length > 16) return null;
	const options: SessionConfig["options"] = [];
	const seen = new Set<string>();
	for (const value of raw) {
		const row: Record<string, unknown> = value && typeof value === "object" && !Array.isArray(value) ? value : {};
		if (row.id !== "target" && row.id !== "model" && row.id !== "thinkingLevel") continue;
		if (seen.has(row.id)) return null;
		seen.add(row.id);
		// GUI-03: ACP reports an unconfigured target as null. Its absence stays in SessionConfig.target;
		// omitting this unselected control must not discard the model or thinking controls beside it.
		if (row.id === "target" && row.currentValue === null) {
			if (!Value.Check(UnselectedTarget, Value.Clean(UnselectedTarget, structuredClone(row)))) return null;
			continue;
		}
		const projected = Value.Clean(ConfigOption, structuredClone(row));
		if (!Value.Check(ConfigOption, projected)) return null;
		options.push(projected);
	}
	return options;
}

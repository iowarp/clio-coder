import { defineCommandSpec } from "../kit/help.js";

export const spec = defineCommandSpec({
	path: ["telemetry"],
	summary: "read session and run telemetry (--json for the DTO)",
	hidden: false,
});

/** Nested leaves added in 0.8.5; each is dispatched inside `telemetry` by its own lazy import. */
export const leaves = [
	defineCommandSpec({ path: ["telemetry", "quota"], summary: "provider quota snapshot (--json)", hidden: false }),
	defineCommandSpec({ path: ["telemetry", "health"], summary: "telemetry read-model health (--json)", hidden: false }),
	defineCommandSpec({ path: ["telemetry", "runs"], summary: "the runs a session referenced (--json)", hidden: false }),
	defineCommandSpec({
		path: ["telemetry", "share", "sweep"],
		summary: "revoke this machine's expired telemetry shares through gh",
		hidden: false,
	}),
] as const;

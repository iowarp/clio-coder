import { defineCommandSpec } from "../kit/help.js";

export const spec = defineCommandSpec({
	path: ["schema"],
	summary: "print the JSON Schema of a machine-readable document (run-result, run-events, task, help, fleet-result)",
	hidden: false,
});

/** The schema names `schema <name>` prints, each shipped as `schemas/<name>.json`. */
export const SCHEMA_NAMES = ["run-result", "run-events", "task", "help", "fleet-result"] as const;

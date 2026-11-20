import { defineCommandSpec } from "../kit/help.js";

export const spec = defineCommandSpec({
	path: ["telemetry"],
	summary: "read session and run telemetry (--json for the DTO)",
	hidden: false,
});

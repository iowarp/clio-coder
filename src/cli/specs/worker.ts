import { defineCommandSpec } from "../kit/help.js";

export const spec = defineCommandSpec({
	path: ["worker"],
	summary: "internal worker stream server: WorkerSpec on stdin, NDJSON on stdout",
	hidden: true,
});

import { writeFileSync } from "node:fs";
import { runHeadlessMainAgent } from "../../src/cli/modes/print.js";
import { runtimeFixture } from "../harness/headless-denial-fixture.js";

const eventsPath = process.argv[2];
if (!eventsPath) throw new Error("events output path is required");

const { loop, events } = await runtimeFixture(process.cwd());
try {
	process.exitCode = await runHeadlessMainAgent(loop, {
		prompt: "Run the controlled denial scenario",
		mode: "json",
		shutdown: { onDrain() {}, getExitCode: () => 0, isShuttingDown: () => false },
	});
	writeFileSync(eventsPath, JSON.stringify(events));
} finally {
	loop.dispose();
}

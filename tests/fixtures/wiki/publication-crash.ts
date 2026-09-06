import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { runWikiGenerate } from "../../../src/domains/context/wiki/generate.js";

const cwd = process.argv[2];
if (!cwd) throw new Error("missing fixture workspace");
const step = process.argv[3] ?? "backup";
const rename = fs.renameSync;
fs.renameSync = (source, destination) => {
	rename(source, destination);
	if (
		(step === "backup" &&
			source === join(cwd, ".clio-coder/wiki") &&
			destination === join(cwd, ".clio-coder/wiki-prev")) ||
		(step === "publish" && destination === join(cwd, ".clio-coder/wiki"))
	) {
		process.kill(process.pid, "SIGKILL");
	}
};
syncBuiltinESMExports();
await runWikiGenerate({
	cwd,
	model: "fixture",
	generate(input) {
		fs.appendFileSync(join(input.outputDir, "a.md"), "\nAdditional detail before interruption.\n");
	},
});
throw new Error("expected publication crash");

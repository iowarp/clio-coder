import { existsSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { coordinateCodewikiWrite } from "../../src/domains/context/codewiki/coordinator.js";

const [mode, cwd, readyPath, releasePath, waitingPath, selectedPath] = process.argv.slice(2);
if (!mode || !cwd || !readyPath || !releasePath || !waitingPath || !selectedPath) {
	throw new Error("usage: codewiki-coordinator-child <pause|follow> <cwd> <ready> <release> <waiting> <selected>");
}

const waitingTimer = mode === "follow" ? setTimeout(() => writeFileSync(waitingPath, "waiting\n"), 500) : undefined;
try {
	await coordinateCodewikiWrite(
		cwd,
		() => {
			if (mode === "follow") writeFileSync(selectedPath, "selected\n");
			return { kind: "build", cwd, language: "typescript" };
		},
		mode === "pause"
			? {
					beforeCommit: async () => {
						writeFileSync(readyPath, "ready\n");
						const deadline = Date.now() + 15_000;
						while (!existsSync(releasePath)) {
							if (Date.now() >= deadline) throw new Error("pause child release deadline exceeded");
							await sleep(20);
						}
					},
				}
			: {},
	);
} finally {
	if (waitingTimer) clearTimeout(waitingTimer);
}

import { strictEqual } from "node:assert/strict";
import fs, { mkdtempSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { isolateClioEnv } from "../harness/scratch-env.js";

// path-canonical binds realpath and readlink when it loads, so count them before importing the engine.
let lookups = 0;
const realpath = fs.realpathSync;
const nativeRealpath = fs.realpathSync.native;
const readlink = fs.readlinkSync;
Object.assign(fs, {
	realpathSync: Object.assign((...args: Parameters<typeof realpath>) => realpath(...args), {
		native: (...args: Parameters<typeof nativeRealpath>) => {
			lookups++;
			return nativeRealpath(...args);
		},
	}),
	readlinkSync: (...args: Parameters<typeof readlink>) => {
		lookups++;
		return readlink(...args);
	},
});
syncBuiltinESMExports();
const { createSafetyPolicyEngine } = await import("../../src/domains/safety/policy-engine.js");
const { loadProjectSafetyPolicy } = await import("../../src/domains/safety/project-policy.js");

// x6-7b: every heredoc word is a read candidate, and each repeat walked the filesystem again.
test("bash admission inspects each distinct heredoc word once, however often it repeats", async (t) => {
	const home = await isolateClioEnv("clio-admission-repeats-");
	t.after(() => home.restore());
	const cwd = nativeRealpath(mkdtempSync(join(tmpdir(), "clio-admission-repeats-ws-")));
	writeFileSync(join(cwd, ".env"), "TOKEN=x\n");
	const engine = createSafetyPolicyEngine({ cwd, projectPolicy: loadProjectSafetyPolicy(cwd) });
	const heredoc = (rows: number) =>
		`cat > data.csv <<'EOF'\n${Array.from({ length: rows }, (_, i) => `${i % 10},sensor-${i % 5},ok,alpha beta`).join("\n")}\nEOF`;
	const judge = (command: string, yolo: boolean) => {
		lookups = 0;
		const decision = yolo
			? engine.evaluate({ tool: "bash", args: { command } }, "yolo", { scratchRoots: [] })
			: engine.evaluate({ tool: "bash", args: { command } });
		return { verdict: `${decision.kind}:${decision.reasonCode}`, lookups };
	};
	for (const yolo of [false, true]) {
		const short = judge(heredoc(100), yolo);
		const long = judge(heredoc(1600), yolo);
		strictEqual(long.verdict, short.verdict);
		strictEqual(
			long.lookups,
			short.lookups,
			`yolo=${yolo}: 1600 rows took ${long.lookups} lookups, 100 took ${short.lookups}`,
		);
	}
	// What blocks still blocks when it sits behind thousands of repeats. A body copied into a file is content (C-22); a
	// read after it still names the file.
	strictEqual(judge(`${heredoc(1600)}\ncat .env`, false).verdict, "block:secret_path_bash");
	const store = join(home.dir, "config", "credentials.yaml");
	strictEqual(judge(`${heredoc(1600)}\ncat ${store}`, true).verdict, "block:yolo-floor:yolo-floor-clio-credentials");
});

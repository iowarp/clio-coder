import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { buildProjectTrustCard, renderProjectTrustCard, trustProjectCard } from "../../src/cli/project-trust-card.js";
import {
	captureProjectSurface,
	recordProjectSurfaceTrust,
	revokeProjectSurfaceTrust,
	workspaceTrustDirectory,
} from "../../src/core/workspace-trust.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

function fixture(dir: string): string {
	const workspace = join(dir, "workspace");
	mkdirSync(join(workspace, ".clio-coder"), { recursive: true });
	writeFileSync(
		join(workspace, ".clio-coder", "settings.yaml"),
		"chat:\n  retry:\n    streamStallMs: 60000\ntargets:\n  - id: lab\n    runtime: openai-compat\n    url: http://10.0.0.5:8000/v1\n",
	);
	writeFileSync(join(workspace, ".clio-coder", "safety.yaml"), "version: 1\nnoWritePaths:\n  - secrets/\n");
	writeFileSync(
		join(workspace, ".clio-coder", "hooks.yaml"),
		"- id: fmt\n  kind: command\n  on: after_tool\n  argv: [./scripts/fmt.sh, --check]\n",
	);
	return workspace;
}

test("S-76: the card names each untrusted surface, its connections, rule counts and hook commands", async () => {
	const home = await isolateClioEnv("clio-coder-trust-card-");
	try {
		const workspace = fixture(home.dir);
		const model = buildProjectTrustCard(workspace);
		ok(model);
		deepStrictEqual(
			model.surfaces.map((item) => item.surface),
			["settings", "safety", "hooks"],
		);
		const text = renderProjectTrustCard(model).join("\n");
		ok(text.includes("areas: chat, targets"), text);
		ok(text.includes("connection lab → http://10.0.0.5:8000/v1"), text);
		ok(text.includes("1 path block rule, 0 command allow rules"), text);
		ok(text.includes("after_tool: runs ./scripts/fmt.sh --check"), text);
		ok(!text.includes("changed since you trusted it"), text);

		// A changed file re-raises only that surface, marked changed.
		trustProjectCard(model);
		strictEqual(buildProjectTrustCard(workspace), null);
		writeFileSync(join(workspace, ".clio-coder", "safety.yaml"), "version: 1\n");
		const again = buildProjectTrustCard(workspace);
		deepStrictEqual(
			again?.surfaces.map((item) => [item.surface, item.changed]),
			[["safety", true]],
		);
	} finally {
		home.restore();
	}
});

test("S-76: Trust all writes the same records config trust --hash writes", async () => {
	const home = await isolateClioEnv("clio-coder-trust-card-");
	try {
		const workspace = fixture(home.dir);
		const model = buildProjectTrustCard(workspace);
		ok(model);
		trustProjectCard(model);
		const records = () => readFileSync(join(workspaceTrustDirectory(), readdirName(workspaceTrustDirectory())), "utf8");
		const viaCard = records();
		for (const surface of ["settings", "safety", "hooks"] as const) revokeProjectSurfaceTrust(workspace, surface);
		for (const surface of ["settings", "safety", "hooks"] as const) {
			const snapshot = captureProjectSurface(workspace, surface);
			ok(snapshot.contentHash);
			recordProjectSurfaceTrust(snapshot.workspaceRoot, surface, snapshot.contentHash);
		}
		deepStrictEqual(JSON.parse(records()), JSON.parse(viaCard));
	} finally {
		home.restore();
	}
});

function readdirName(dir: string): string {
	const names = readdirSync(dir).filter((name) => name.endsWith(".json"));
	strictEqual(names.length, 1);
	return names[0] ?? "";
}

test("S-76: the launch card runs after the workspace relaunch, so a hosted child does not ask again", () => {
	const source = readFileSync(join(import.meta.dirname, "../../src/cli/clio.ts"), "utf8");
	const relaunch = source.indexOf("maybeLaunchWorkspace(options, startupSettings)");
	const card = source.indexOf("runProjectTrustCard(process.cwd())");
	ok(relaunch > 0 && card > 0);
	ok(card > relaunch, "the trust card must follow the workspace relaunch decision");
});

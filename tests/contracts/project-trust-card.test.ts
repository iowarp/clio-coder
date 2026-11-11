import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
	buildProjectTrustCard,
	launchTrustNotices,
	projectConnectionNeeds,
	projectTrustCardChoice,
	projectTrustCardReviewFiles,
	renderProjectTrustCard,
	trustProjectCard,
} from "../../src/cli/project-trust-card.js";
import { readStrictLayeredSettings } from "../../src/core/settings-layers.js";
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

test("after Trust all, each project connection names the key or sign-in it still needs", async () => {
	const home = await isolateClioEnv("clio-coder-trust-card-");
	const saved = process.env.OPENAI_API_KEY;
	delete process.env.OPENAI_API_KEY;
	try {
		const workspace = join(home.dir, "workspace");
		mkdirSync(join(workspace, ".clio-coder"), { recursive: true });
		writeFileSync(
			join(workspace, ".clio-coder", "settings.yaml"),
			[
				"targets:",
				"  - id: team-openai",
				"    runtime: openai",
				"  - id: lab-gateway",
				"    runtime: openai",
				"    url: https://llm.lab.example.org/v1",
				"  - id: local",
				"    runtime: openai-compat",
				"    url: http://127.0.0.1:8000/v1",
				"",
			].join("\n"),
		);
		const model = buildProjectTrustCard(workspace);
		ok(model);
		trustProjectCard(model);
		const needs = () => projectConnectionNeeds(workspace, readStrictLayeredSettings(workspace).settings);
		const gateway =
			"lab-gateway points at https://llm.lab.example.org/v1, an address this project chose, so Clio sends it none of your keys. To use it, define lab-gateway in your user settings.";
		deepStrictEqual(needs(), [
			"openai has no key or sign-in stored. Run: clio-coder auth login openai (or press Enter on /config)",
			gateway,
		]);
		// A key in the shell serves the provider's own address, never the address the project chose.
		process.env.OPENAI_API_KEY = "sk-test";
		deepStrictEqual(needs(), [gateway]);
	} finally {
		if (saved === undefined) delete process.env.OPENAI_API_KEY;
		else process.env.OPENAI_API_KEY = saved;
		home.restore();
	}
});

test("a launch with the project trusted, as after /trust restarts into the session, names the connection needs too", async () => {
	const home = await isolateClioEnv("clio-coder-trust-card-");
	const saved = process.env.OPENAI_API_KEY;
	delete process.env.OPENAI_API_KEY;
	try {
		const workspace = join(home.dir, "workspace");
		mkdirSync(join(workspace, ".clio-coder"), { recursive: true });
		writeFileSync(
			join(workspace, ".clio-coder", "settings.yaml"),
			"targets:\n  - id: team-openai\n    runtime: openai\n",
		);
		writeFileSync(join(workspace, ".clio-coder", "safety.yaml"), "version: 1\nnoWritePaths:\n  - secrets/\n");
		const settings = () => readStrictLayeredSettings(workspace).settings;
		const need = "openai has no key or sign-in stored. Run: clio-coder auth login openai (or press Enter on /config)";
		// No card over untrusted configuration (no terminal to ask): the per-file notices stay.
		strictEqual(launchTrustNotices("none", workspace, settings()), undefined);
		// Open without it: the header's /trust reminder answers it, nothing else.
		deepStrictEqual(launchTrustNotices("skipped", workspace, settings()), []);
		const model = buildProjectTrustCard(workspace);
		ok(model);
		trustProjectCard(model);
		deepStrictEqual(launchTrustNotices("trusted", workspace, settings()), [need]);
		// The restarted session's card has nothing left to ask; the need is still named.
		deepStrictEqual(launchTrustNotices("none", workspace, settings()), [need]);
		process.env.OPENAI_API_KEY = "sk-test";
		strictEqual(launchTrustNotices("none", workspace, settings()), undefined);
	} finally {
		if (saved === undefined) delete process.env.OPENAI_API_KEY;
		else process.env.OPENAI_API_KEY = saved;
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

test("trust card: q and Ctrl+C quit as the legend says; Esc still opens without the configuration", () => {
	strictEqual(projectTrustCardChoice({ kind: "quit" }), "quit");
	strictEqual(projectTrustCardChoice({ kind: "back" }), "skip");
	strictEqual(projectTrustCardChoice({ kind: "selected", value: "trust" }), "trust");
});

test("trust card: Review shows the hook scripts the hooks file pins, so a changed script can be read", async () => {
	const home = await isolateClioEnv("clio-coder-trust-card-");
	try {
		const workspace = fixture(home.dir);
		mkdirSync(join(workspace, "scripts"), { recursive: true });
		writeFileSync(join(workspace, "scripts", "fmt.sh"), "#!/bin/sh\necho one\n");
		const first = buildProjectTrustCard(workspace);
		ok(first);
		trustProjectCard(first);
		writeFileSync(join(workspace, "scripts", "fmt.sh"), "#!/bin/sh\necho two\n");
		const again = buildProjectTrustCard(workspace);
		deepStrictEqual(
			again?.surfaces.map((item) => [item.surface, item.changed]),
			[["hooks", true]],
		);
		const reviewed = projectTrustCardReviewFiles(again);
		const script = reviewed.find((file) => file.path.endsWith(join("scripts", "fmt.sh")));
		ok(script, reviewed.map((file) => file.path).join(", "));
		ok(script.text.includes("echo two"));
		ok(renderProjectTrustCard(again).join("\n").includes("scripts/fmt.sh"));
	} finally {
		home.restore();
	}
});

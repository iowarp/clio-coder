import { strictEqual } from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { installDiagnosticSink } from "../../src/core/diagnostics.js";
import { clioConfigDir } from "../../src/core/xdg.js";
import { projectShadowNotice } from "../../src/interactive/project-shadow-notice.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

const BUILTINS = join(import.meta.dirname, "..", "..", "src", "domains", "agents");

function customAgent(name: string): string {
	return readFileSync(join(BUILTINS, "builtins", "documenter.md"), "utf8")
		.replace(/^name: Documenter$/mu, `name: ${name}`)
		.replace(/^audience: base$/mu, "audience: custom");
}

test("the session names, in words, the agents and playbooks this project replaces", async () => {
	const home = await isolateClioEnv("clio-coder-project-shadow-");
	const raw: string[] = [];
	const removeSink = installDiagnosticSink((text) => raw.push(text));
	try {
		const workspace = join(home.dir, "workspace");
		mkdirSync(join(workspace, ".clio-coder", "agents"), { recursive: true });
		mkdirSync(join(workspace, ".clio-coder", "playbooks"), { recursive: true });
		strictEqual(projectShadowNotice(workspace), null);

		mkdirSync(join(clioConfigDir(), "agents"), { recursive: true });
		writeFileSync(join(clioConfigDir(), "agents", "helper.md"), customAgent("Helper"));
		writeFileSync(join(workspace, ".clio-coder", "agents", "helper.md"), customAgent("Helper"));
		writeFileSync(
			join(workspace, ".clio-coder", "playbooks", "build-review.md"),
			readFileSync(join(BUILTINS, "playbooks", "build-review.md"), "utf8"),
		);
		// A project file with a fresh name replaces nothing.
		writeFileSync(join(workspace, ".clio-coder", "agents", "solo.md"), customAgent("Solo"));
		strictEqual(
			projectShadowNotice(workspace),
			"This project replaces your agent helper and the built-in playbook build-review with its own copies; clio-coder doctor names the files.",
		);
		// The terminal owner states the override itself; the raw line stays for headless runs.
		strictEqual(raw.filter((line) => line.includes("override")).length, 0, raw.join("\n"));
	} finally {
		removeSink();
		home.restore();
	}
});

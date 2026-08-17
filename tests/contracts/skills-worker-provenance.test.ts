import { ok, strictEqual } from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { makeScratchHome, runCli } from "../harness/spawn.js";

// gh-90: a worker with the bash tool can run `clio-coder skills install`,
// which writes into the trusted project skill root. That is not privilege
// escalation (the worker's own skill policy is fixed at spawn and nothing
// auto-activates from a project root), but the operator should be able to
// tell that a skill in that root arrived unasked, from a worker rather than
// from themselves. `CLIO_CODER_WORKER_RUN=1` is the env marker
// `worker/entry.ts` sets on itself at launch, which rides into every
// bash-tool child a worker spawns; these tests simulate that child process
// directly rather than spinning up a real worker.

describe("contracts/skills worker install provenance", () => {
	const scratch = makeScratchHome("clio-skills-worker-provenance-");
	after(() => scratch.cleanup());

	function seedSource(name: string, description: string): string {
		const dir = join(scratch.dir, "source", name);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\nBody.\n`);
		return dir;
	}

	it("stamps installed-by: worker only when the install ran under a worker env", async () => {
		const source = seedSource("worker-installed", "installed by a simulated worker");
		const project = join(scratch.dir, "project-worker");
		mkdirSync(project, { recursive: true });

		const result = await runCli(["skills", "install", source, "--project"], {
			env: { ...scratch.env, CLIO_CODER_WORKER_RUN: "1" },
			cwd: project,
		});
		strictEqual(result.code, 0, `stderr=${result.stderr}`);

		const installed = readFileSync(join(project, ".clio-coder", "skills", "worker-installed", "SKILL.md"), "utf8");
		ok(installed.includes('installed-by: "worker"'), `expected worker provenance stamp, got:\n${installed}`);

		const listed = await runCli(["skills", "list", "--all", "--json"], { env: scratch.env, cwd: project });
		strictEqual(listed.code, 0, `stderr=${listed.stderr}`);
		const skill = JSON.parse(listed.stdout).skills.find((entry: { name: string }) => entry.name === "worker-installed");
		ok(skill, "worker-installed skill must appear in skills list");
		strictEqual(skill.provenance?.installedBy, "worker");

		const inspected = await runCli(["skills", "inspect", "worker-installed"], { env: scratch.env, cwd: project });
		strictEqual(inspected.code, 0, `stderr=${inspected.stderr}`);
		ok(
			inspected.stdout.includes("installed-by: worker"),
			`expected inspect to surface provenance, got:\n${inspected.stdout}`,
		);
	});

	it("leaves no installed-by stamp for an ordinary operator install", async () => {
		const source = seedSource("operator-installed", "installed by the operator");
		const project = join(scratch.dir, "project-operator");
		mkdirSync(project, { recursive: true });

		const result = await runCli(["skills", "install", source, "--project"], { env: scratch.env, cwd: project });
		strictEqual(result.code, 0, `stderr=${result.stderr}`);

		const installed = readFileSync(join(project, ".clio-coder", "skills", "operator-installed", "SKILL.md"), "utf8");
		ok(!installed.includes("installed-by"), `operator install must carry no installed-by stamp, got:\n${installed}`);

		const listed = await runCli(["skills", "list", "--all", "--json"], { env: scratch.env, cwd: project });
		strictEqual(listed.code, 0, `stderr=${listed.stderr}`);
		const skill = JSON.parse(listed.stdout).skills.find((entry: { name: string }) => entry.name === "operator-installed");
		ok(skill, "operator-installed skill must appear in skills list");
		strictEqual(skill.provenance?.installedBy, undefined);
	});
});

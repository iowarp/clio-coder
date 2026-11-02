import { match, ok, strictEqual } from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { isSkillActivation, skillActivationFromToolDetails } from "../../src/core/skill-activation.js";
import { normalizedSkillHash } from "../../src/domains/resources/skills/content-hash.js";
import { loadSkills, parsePendingSkillRequests } from "../../src/domains/resources/skills/loader.js";
import { createPendingSkillToolPolicy } from "../../src/session-control/chat-loop-messages.js";
import { createContextTool } from "../../src/tools/context/index.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

const roots: string[] = [];

function scratchRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "clio-coder-skill-contract-"));
	roots.push(root);
	return root;
}

function writeSkill(root: string, name: string, description: string | null, body: string): string {
	const directory = join(root, name);
	mkdirSync(directory, { recursive: true });
	writeFileSync(
		join(directory, "SKILL.md"),
		["---", `name: ${name}`, ...(description === null ? [] : [`description: ${description}`]), "---", "", body, ""].join(
			"\n",
		),
		"utf8",
	);
	return directory;
}

describe("skill install and activation boundary", () => {
	afterEach(() => {
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	it("loads an explicit skill path and carries it through request and activation provenance", () => {
		const root = scratchRoot();
		const explicit = writeSkill(root, "explicit", "Explicit workflow.", "Run the explicit workflow.");
		const list = loadSkills({
			cwd: root,
			disableDiscovery: true,
			explicitSkillPaths: [explicit],
		});
		strictEqual(list.items.length, 1);
		strictEqual(list.items[0]?.source, "path");

		const pending = parsePendingSkillRequests("/skill explicit focus on tests", list, { cwd: root });
		strictEqual(pending.text, "focus on tests");
		strictEqual(pending.pendingSkillRequests[0]?.installed, true);
		strictEqual(pending.pendingSkillRequests[0]?.filePath, list.items[0]?.filePath);

		const skill = list.items[0];
		ok(skill !== undefined);
		const activation = skillActivationFromToolDetails(
			{
				name: skill.name,
				filePath: skill.filePath,
				hash: skill.hash,
				source: skill.source,
				sourceOrigin: skill.sourceInfo.source,
			},
			"turn-1",
		);
		ok(activation !== null);
		strictEqual(isSkillActivation(activation), true);
		strictEqual(activation.turnId, "turn-1");
		strictEqual(activation.filePath, skill.filePath);
	});

	it("loads a trusted manual-only skill only after the operator names it", async () => {
		const root = scratchRoot();
		const manual = join(root, "manual-review");
		mkdirSync(manual, { recursive: true });
		writeFileSync(
			join(manual, "SKILL.md"),
			[
				"---",
				"name: manual-review",
				"description: Review a change only when the operator explicitly requests it.",
				"disable-model-invocation: true",
				"---",
				"",
				"Run the manual review workflow.",
				"",
			].join("\n"),
			"utf8",
		);
		const loaderOptions = { disableDiscovery: true, explicitSkillPaths: [manual] } as const;
		const list = loadSkills({ cwd: root, ...loaderOptions });
		strictEqual(list.items[0]?.disableModelInvocation, true);

		const context = createContextTool({
			getCwd: () => root,
			getSkillLoaderOptions: () => loaderOptions,
		});
		const unsolicited = await context.run({ scope: "skills", name: "manual-review" });
		strictEqual(unsolicited.kind, "error", "manual-only skills must remain hidden without operator activation");

		const pending = parsePendingSkillRequests("/skill manual-review inspect this patch", list, { cwd: root });
		const pendingSkillPolicy = createPendingSkillToolPolicy(pending.pendingSkillRequests);
		ok(pendingSkillPolicy !== undefined);
		const activated = await context.run({ scope: "skills", name: "manual-review" }, { pendingSkillPolicy });
		strictEqual(activated.kind, "ok");
		if (activated.kind === "ok") {
			match(activated.output, /Run the manual review workflow\./u);
			strictEqual((activated.details as { disableModelInvocation?: unknown } | undefined)?.disableModelInvocation, true);
		}
	});

	it("separates context-prime installation, explicit-path availability, suggestion and slash activation", async () => {
		const isolated = await isolateClioEnv("clio-coder-prime-stages-");
		try {
			const project = join(isolated.dir, "project");
			mkdirSync(project);
			// Keep source and installed discovery independent inside the scratch project.
			const source = join(isolated.dir, "source", "context-prime");
			cpSync(join(process.cwd(), "library", "skills", "context", "context-prime"), source, { recursive: true });
			strictEqual(
				loadSkills({ cwd: project, home: isolated.dir }).items.some((skill) => skill.name === "context-prime"),
				false,
			);
			const destination = join(project, ".clio-coder", "skills", "context-prime");
			cpSync(source, destination, { recursive: true });
			const installed = { path: join(destination, "SKILL.md") };
			strictEqual(
				normalizedSkillHash(readFileSync(installed.path, "utf8")),
				normalizedSkillHash(readFileSync(join(source, "SKILL.md"), "utf8")),
			);
			ok(existsSync(installed.path));
			ok(loadSkills({ cwd: project, home: isolated.dir }).items.some((skill) => skill.name === "context-prime"));

			// The --skill entry wiring supplies explicitSkillPaths; that exposes the
			// skill at cli scope but does not create an operator activation request.
			const loaderOptions = { disableDiscovery: true, explicitSkillPaths: [installed.path] } as const;
			const list = loadSkills({ cwd: project, ...loaderOptions });
			strictEqual(list.items.length, 1);
			strictEqual(list.items[0]?.scope, "cli");
			strictEqual(list.items[0]?.source, "path");
			const context = createContextTool({
				getCwd: () => project,
				getSkillLoaderOptions: () => loaderOptions,
				skillMarketplace: false,
			});
			const listing = await context.run({ scope: "skills" });
			strictEqual(listing.kind, "ok");
			if (listing.kind === "ok") {
				match(listing.output, /Explicitly supplied session skills \(not installed packages\):/u);
				match(listing.output, /session availability does not mean Clio installed or copied them/u);
				match(listing.output, /Other-agent skill folders are discovery-only\. Explicitly import into Clio before use/u);
				match(listing.output, /context-prime \(source: path; scope: cli; file:/u);
				match(listing.output, /Suggested skill: \/skill <name>/u);
				ok(!listing.output.includes("# Context Prime"), "listing must not activate or expose the workflow body");
			}
			const denied = await context.run({ scope: "skills", name: "context-prime" });
			strictEqual(denied.kind, "error");
			if (denied.kind === "error") match(denied.message, /only the operator can activate a skill/u);

			const pending = parsePendingSkillRequests(
				"/skill context-prime Give only a brief orientation of this scratch repository; no implementation is requested.",
				list,
				{ cwd: project },
			);
			const pendingSkillPolicy = createPendingSkillToolPolicy(pending.pendingSkillRequests);
			ok(pendingSkillPolicy);
			const activated = await context.run({ scope: "skills", name: "context-prime" }, { pendingSkillPolicy });
			strictEqual(activated.kind, "ok");
			if (activated.kind === "ok") {
				match(activated.output, /# Context Prime/u);
				match(activated.output, /source: slash-command/u);
				const activation = skillActivationFromToolDetails(activated.details, "orientation-turn");
				ok(activation);
				strictEqual(activation.name, "context-prime");
				strictEqual(activation.filePath, installed.path);
			}
		} finally {
			isolated.restore();
		}
	});

	it("reports missing and invalid explicit paths without falling back to discovery", () => {
		const root = scratchRoot();
		const invalid = writeSkill(root, "broken", null, "Broken.");
		const list = loadSkills({
			cwd: root,
			disableDiscovery: true,
			explicitSkillPaths: [join(root, "missing"), invalid],
		});
		strictEqual(list.items.length, 0);
		ok(list.diagnostics.some((diagnostic) => diagnostic.message.includes("does not exist")));
		ok(list.diagnostics.some((diagnostic) => diagnostic.message.includes("description is required")));
	});
});

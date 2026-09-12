import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { cpSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { it } from "node:test";
import { skillActivationFromToolDetails, withModelSkillActivation } from "../../src/core/skill-activation.js";
import { clearPluginSnapshots, pluginSnapshotFor } from "../../src/domains/plugins/index.js";
import { discoverLibrary } from "../../src/domains/resources/library.js";
import {
	applyLibraryLifecycle,
	planLibraryLifecycle,
	pluginSnapshotRefreshHost,
} from "../../src/domains/resources/library-actions.js";
import { readLibraryInventory } from "../../src/domains/resources/library-inventory.js";
import { loadSkills, parsePendingSkillRequests } from "../../src/domains/resources/skills/loader.js";
import { reloadPluginResourcesAndNotify } from "../../src/entry/plugin-reload.js";
import { createPendingSkillToolPolicy } from "../../src/interactive/chat-loop-messages.js";
import { createContextTool } from "../../src/tools/context/index.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

const herdr = new URL("../../library/skills/meta/herdr/", import.meta.url);

function automaticPolicy() {
	const policy = withModelSkillActivation(undefined, true);
	ok(policy);
	return policy;
}

it("activates every bundled skill from its native package in a workspace with peer skill copies", async () => {
	const env = await isolateClioEnv("clio-coder-library-all-skill-activation-");
	try {
		process.env.HOME = env.dir;
		const cwd = path.join(env.dir, "project");
		cpSync(new URL("../../library/skills/", import.meta.url), path.join(cwd, ".agents/skills/clio-coder"), {
			recursive: true,
		});
		cpSync(new URL("../../library/plugins/materio/skills/", import.meta.url), path.join(cwd, ".agents/skills/materio"), {
			recursive: true,
		});
		const catalog = discoverLibrary({ cwd }).entries;
		strictEqual(catalog.length, 34);
		const refresh = pluginSnapshotRefreshHost();
		refresh(cwd);
		for (const entry of catalog) {
			const result = applyLibraryLifecycle(
				planLibraryLifecycle({ operation: "install", ref: `${entry.kind}:${entry.name}`, scope: "user", cwd }),
			);
			strictEqual(result.committed, 1, `${entry.name}: ${JSON.stringify(result)}`);
		}
		refresh(cwd);
		const skills = loadSkills({ cwd }).items;
		strictEqual(skills.length, 39);
		const context = createContextTool({ getCwd: () => cwd });
		for (const skill of skills) {
			strictEqual(skill.source, "plugin", skill.name);
			strictEqual(skill.trusted, true, skill.name);
			const automatic = automaticPolicy();
			if (skill.disableModelInvocation) {
				const denied = await context.run({ scope: "skills", name: skill.name }, { pendingSkillPolicy: automatic });
				ok(denied.kind === "error");
				match(denied.message, /explicit operator activation/);
			}
			const requests = parsePendingSkillRequests(`/skill ${skill.name}`, { items: skills, diagnostics: [] }, { cwd });
			const pendingSkillPolicy = skill.disableModelInvocation
				? createPendingSkillToolPolicy(requests.pendingSkillRequests)
				: automatic;
			ok(pendingSkillPolicy);
			const result = await context.run({ scope: "skills", name: skill.name }, { pendingSkillPolicy });
			ok(result.kind === "ok", `${skill.name}: ${JSON.stringify(result)}`);
			strictEqual(skillActivationFromToolDetails(result.details, skill.name)?.filePath, skill.filePath);
		}
	} finally {
		clearPluginSnapshots();
		env.restore();
	}
});

for (const scope of ["user", "project"] as const) {
	it(`loads the native ${scope} Library skill after session refresh despite untrusted compatibility copies`, async () => {
		const env = await isolateClioEnv("clio-coder-library-skill-activation-");
		try {
			process.env.HOME = env.dir;
			const cwd = path.join(env.dir, "project");
			const foreign = path.join(cwd, ".claude/skills/herdr");
			cpSync(herdr, foreign, { recursive: true });
			const foreignFile = path.join(foreign, "SKILL.md");
			const foreignBytes = readFileSync(foreignFile, "utf8");
			const generations: number[] = [];
			const refresh = pluginSnapshotRefreshHost(
				(project) => reloadPluginResourcesAndNotify(project, (event) => generations.push(event.generation)),
				(project) => pluginSnapshotFor(project).generation,
			);
			refresh(cwd); // The already-running session initially has no native installation.
			const context = createContextTool({ getCwd: () => cwd });
			const plan = planLibraryLifecycle({ operation: "install", ref: "skill:herdr", scope, cwd });
			const applied = applyLibraryLifecycle(plan, { refresh });
			strictEqual(applied.committed, 1, JSON.stringify(applied));
			strictEqual(applied.refresh.status, "refreshed");
			strictEqual(generations.length, 2);
			const installedRoot = plan.steps[0]?.destination;
			ok(installedRoot);
			const installedFile = path.join(installedRoot, "SKILL.md");

			if (scope === "project") {
				// The same physical file can also be visible through a peer-agent root.
				const alias = path.join(cwd, ".agents/skills/herdr");
				mkdirSync(path.dirname(alias), { recursive: true });
				symlinkSync(installedRoot, alias, "junction");
			}
			const listing = await context.run({ scope: "skills" });
			ok(listing.kind === "ok");
			match(listing.output, /herdr \(package\)/);
			const activated = await context.run({ scope: "skills", name: "herdr" }, { pendingSkillPolicy: automaticPolicy() });
			ok(activated.kind === "ok", JSON.stringify(activated));
			strictEqual(skillActivationFromToolDetails(activated.details, "native-load")?.filePath, installedFile);
			match(activated.output, /# Herdr/);
			const rows = readLibraryInventory({ cwd, kinds: ["skill"], query: "herdr" }).resources;
			ok(rows.some((row) => row.owner?.ref === "skill:herdr" && row.availability === "available"));
			ok(rows.some((row) => row.path === foreignFile && row.availability === "shadowed"));

			// A slash request resolves to the same native owner as automatic activation.
			const list = loadSkills({ cwd });
			const pending = parsePendingSkillRequests("/skill herdr inspect the pane", list, { cwd });
			const pendingSkillPolicy = createPendingSkillToolPolicy(pending.pendingSkillRequests);
			ok(pendingSkillPolicy);
			const explicit = await context.run({ scope: "skills", name: "herdr" }, { pendingSkillPolicy });
			ok(explicit.kind === "ok", JSON.stringify(explicit));
			strictEqual(skillActivationFromToolDetails(explicit.details, "slash-load")?.filePath, installedFile);
			strictEqual(readFileSync(foreignFile, "utf8"), foreignBytes);

			// Explicitly trusted project imports keep their normal override semantics.
			const trusted = loadSkills({ cwd, trustProjectCompatRoots: true });
			strictEqual(trusted.items.find((skill) => skill.name === "herdr")?.scope, "project");
		} finally {
			clearPluginSnapshots();
			env.restore();
		}
	});
}

it("explains a discovered but untrusted skill without claiming it is unknown or granting access", async () => {
	const env = await isolateClioEnv("clio-coder-library-skill-denial-");
	try {
		process.env.HOME = env.dir;
		const cwd = path.join(env.dir, "project");
		const foreign = path.join(cwd, ".claude/skills/foreign-only");
		mkdirSync(foreign, { recursive: true });
		writeFileSync(
			path.join(foreign, "SKILL.md"),
			"---\nname: foreign-only\ndescription: Foreign skill\n---\nPRIVATE FOREIGN BODY\n",
		);
		const context = createContextTool({ getCwd: () => cwd });
		const result = await context.run(
			{ scope: "skills", name: "foreign-only" },
			{ pendingSkillPolicy: automaticPolicy() },
		);
		ok(result.kind === "error");
		match(result.message, /untrusted/);
		ok(!result.message.includes("unknown skill") && !result.message.includes("PRIVATE FOREIGN BODY"));
		deepStrictEqual(
			loadSkills({ cwd }).items.map((skill) => [skill.name, skill.trusted]),
			[["foreign-only", false]],
		);
	} finally {
		clearPluginSnapshots();
		env.restore();
	}
});

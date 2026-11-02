import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { withModelSkillActivation } from "../../src/core/skill-activation.js";
import { skillAuthoringDiagnostics, skillVerification } from "../../src/domains/resources/skills/authoring-check.js";
import { createContextTool } from "../../src/tools/context/index.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

test("authoring checks distinguish broken links, companion hints, routing and length", async () => {
	const env = await isolateClioEnv();
	try {
		mkdirSync(join(env.dir, "references"));
		writeFileSync(join(env.dir, "references", "present.md"), "Present.");
		const skill = {
			baseDir: env.dir,
			filePath: join(env.dir, "SKILL.md"),
			metadata: {},
			description: "Inspect; use known-skill or absent-skill.",
			content: [
				"[Missing](references/missing.md)",
				"Read scripts/check.py",
				"[Present](references/present.md)",
				...Array(118).fill("Detail."),
			].join("\n"),
		};
		const diagnostics = skillAuthoringDiagnostics(skill, { knownSkills: new Set(["known-skill"]) });
		deepStrictEqual(
			diagnostics.map((d) => d.type),
			["error", "warning", "warning", "warning"],
		);
		match(diagnostics[0]?.message ?? "", /references\/missing.md/);
		match(diagnostics[1]?.message ?? "", /scripts\/check.py/);
		match(diagnostics[2]?.message ?? "", /absent-skill/);
		match(diagnostics[3]?.message ?? "", /121 lines/);
	} finally {
		env.restore();
	}
});

test("verification dates handle absent, invalid, future, current and stale claims", () => {
	const now = Date.parse("2026-11-02T00:00:00Z");
	for (const [value, expected] of [
		[undefined, undefined],
		["2026-02-30", /must be a date/],
		["bad", /must be a date/],
		["2026-11-03", /future/],
		["2026-11-02", undefined],
		["2026-01-01", /days old/],
	] as const) {
		const skill = {
			baseDir: ".",
			filePath: "SKILL.md",
			description: "Check",
			content: "Check.",
			metadata: { clioCoder: value === undefined ? {} : { "verified-at": value } },
		};
		const diagnostics = skillAuthoringDiagnostics(skill, { knownSkills: new Set(), now });
		if (expected) {
			strictEqual(diagnostics.length, 1);
			strictEqual(diagnostics[0]?.type, "warning");
			match(diagnostics[0]?.message ?? "", expected);
		} else strictEqual(diagnostics.length, 0);
		if (value === undefined) strictEqual(skillVerification(skill, now), undefined);
	}
});

test("a skill load exposes its verification date to the model", async () => {
	const env = await isolateClioEnv();
	try {
		const file = join(env.dir, "SKILL.md");
		writeFileSync(
			file,
			'---\nname: date-check\ndescription: Check verified facts\nclio-coder:\n  verified-at: "2026-01-01"\n---\nRead the facts.\n',
		);
		const tool = createContextTool({
			getCwd: () => env.dir,
			getSkillLoaderOptions: () => ({ disableDiscovery: true, explicitSkillPaths: [file] }),
		});
		const pendingSkillPolicy = withModelSkillActivation(undefined, true);
		ok(pendingSkillPolicy);
		const result = await tool.run({ scope: "skills", name: "date-check" }, { pendingSkillPolicy });
		strictEqual(result.kind, "ok");
		if (result.kind === "ok") match(result.output, /verified_at: 2026-01-01/);
	} finally {
		env.restore();
	}
});

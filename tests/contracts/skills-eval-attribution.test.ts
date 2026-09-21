import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import {
	type AttributedBullet,
	artifactIsPinnable,
	attributionFromStrict,
	type CapturedRun,
	deriveBulletAttribution,
	deriveScenarioAttributionVerdict,
	parseRunStdout,
	type RunScenarioInput,
	runScenario,
	runSkillEvalCli,
	type SkillEvalArmRunner,
	type SkillEvalSubject,
	sidecar,
	skillTreeDigest,
	strictJudgeVerdicts,
	verifyObservedActivation,
	verifySubjectTree,
} from "../../src/cli/skills-eval.js";
import { HEADLESS_PERMISSION_DENIED_MARKER } from "../../src/core/headless-permission.js";
import { normalizedSkillHash } from "../../src/domains/resources/skills/content-hash.js";
import type { SkillEvalScenario } from "../../src/domains/resources/skills/evals.js";
import { loadSkills } from "../../src/domains/resources/skills/loader.js";

/**
 * P3 attribution and P2 subject identity, through the production path.
 *
 * The derivation table is covered by exhaustive enumeration of the verdict
 * space rather than a sampled split. That is a different validity claim from a
 * held-out sample and is stated rather than implied.
 *
 * Everything else drives the real `runScenario` with a scripted arm runner, so
 * the skip gates, the arm sequencing, the recorded reasons and the sidecar
 * wiring are exercised as they actually run. Nothing here launches a model.
 */

const VERDICTS = ["pass", "fail", "error", "unmeasured"] as const;

function scenarioOf(bullets: number): SkillEvalScenario {
	return {
		id: "S1",
		number: 1,
		title: "probe",
		setup: "Do the thing.",
		expected: Array.from({ length: bullets }, (_, i) => `expected ${i + 1}`),
	};
}

function run(over: Partial<CapturedRun> = {}): CapturedRun {
	return {
		sessionId: null,
		transcript: "ASSISTANT: did the thing",
		finalText: "did the thing",
		exitCode: 0,
		timedOut: false,
		wallTimeMs: 1,
		stderr: "",
		activations: [],
		...over,
	};
}

/**
 * A treatment arm that reports it activated a given artifact.
 *
 * `path` matters as much as `hash`: two directories can hold identical SKILL.md
 * bytes beside different reference files, and the body's own pointers resolve
 * against the directory it loaded from.
 */
function activated(hash: string, path = "", name = "probe"): CapturedRun {
	return run({ activations: [{ name, hash, path }] });
}

function judgeRun(bullets: unknown): CapturedRun {
	const text = JSON.stringify({ bullets });
	return run({ transcript: text, finalText: text });
}

const goodJudge = (passes: boolean[]) => judgeRun(passes.map((pass, i) => ({ index: i + 1, pass, reason: "because" })));

describe("contracts/skill eval attribution derivation", () => {
	it("derives every baseline x treatment pair, exhaustively", () => {
		const expected: Record<string, string> = {
			"pass|pass": "no-change-pass",
			"pass|fail": "regressed",
			"pass|error": "unmeasured",
			"pass|unmeasured": "unmeasured",
			"fail|pass": "helped",
			"fail|fail": "no-change-fail",
			"fail|error": "unmeasured",
			"fail|unmeasured": "unmeasured",
			"error|pass": "unmeasured",
			"error|fail": "unmeasured",
			"error|error": "unmeasured",
			"error|unmeasured": "unmeasured",
			"unmeasured|pass": "unmeasured",
			"unmeasured|fail": "unmeasured",
			"unmeasured|error": "unmeasured",
			"unmeasured|unmeasured": "unmeasured",
		};
		strictEqual(Object.keys(expected).length, VERDICTS.length * VERDICTS.length);
		for (const baseline of VERDICTS) {
			for (const treatment of VERDICTS) {
				strictEqual(deriveBulletAttribution(baseline, treatment), expected[`${baseline}|${treatment}`]);
			}
		}
	});

	it("rolls a scenario up with unmeasured first and mixed over either direction", () => {
		const at = (index: number, attribution: AttributedBullet["attribution"]): AttributedBullet => ({
			index,
			text: `b${index}`,
			baseline: "fail",
			treatment: "pass",
			attribution,
		});
		strictEqual(deriveScenarioAttributionVerdict([]), "unmeasured");
		strictEqual(deriveScenarioAttributionVerdict([at(1, "helped")]), "helped");
		strictEqual(deriveScenarioAttributionVerdict([at(1, "regressed")]), "regressed");
		strictEqual(deriveScenarioAttributionVerdict([at(1, "no-change-pass"), at(2, "no-change-fail")]), "no-change");
		strictEqual(deriveScenarioAttributionVerdict([at(1, "helped"), at(2, "regressed")]), "mixed");
		strictEqual(
			deriveScenarioAttributionVerdict([at(1, "helped"), at(2, "helped"), at(3, "helped"), at(4, "regressed")]),
			"mixed",
			"three helped and one regressed is mixed, never helped",
		);
		strictEqual(deriveScenarioAttributionVerdict([at(1, "helped"), at(2, "unmeasured")]), "unmeasured");
	});
});

describe("contracts/skill eval strict comparison evidence", () => {
	const scenario = scenarioOf(1);

	// The payloads the review probed. Each parses to `fail` through the legacy
	// rubric parser; each must be refused as comparison evidence, because paired
	// against a real treatment pass they would otherwise read `helped`.
	const refused: Array<[string, unknown]> = [
		["missing pass", [{ index: 1 }]],
		["null pass", [{ index: 1, pass: null }]],
		["string pass", [{ index: 1, pass: "true" }]],
		["string index", [{ index: "1oops", pass: true }]],
		["out-of-range index", [{ index: 7, pass: true }]],
		["non-integer index", [{ index: 1.5, pass: true }]],
		[
			"contradictory duplicate",
			[
				{ index: 1, pass: true },
				{ index: 1, pass: false },
			],
		],
	];

	for (const [label, bullets] of refused) {
		it(`refuses ${label} as comparison evidence instead of scoring it`, () => {
			const strict = strictJudgeVerdicts(scenario, judgeRun(bullets));
			strictEqual(strict.verdicts.has(1), false, "no verdict entered the comparison");
			ok(strict.rejected.get(1) !== undefined, "the refusal carries a reason");
			const attribution = attributionFromStrict(scenario, strict, strictJudgeVerdicts(scenario, goodJudge([true])));
			strictEqual(attribution.verdict, "unmeasured");
			strictEqual(attribution.bullets[0]?.attribution, "unmeasured");
			ok(attribution.reason?.startsWith("baseline judge:"), attribution.reason ?? "no reason");
		});
	}

	it("refuses a malformed treatment verdict rather than inventing a regression", () => {
		const attribution = attributionFromStrict(
			scenario,
			strictJudgeVerdicts(scenario, goodJudge([true])),
			strictJudgeVerdicts(scenario, judgeRun([{ index: 1, pass: "false" }])),
		);
		strictEqual(attribution.verdict, "unmeasured");
		ok(attribution.reason?.startsWith("treatment judge:"), attribution.reason ?? "no reason");
	});

	it("refuses a bullet whose duplicate is malformed, in either order and on either arm", () => {
		// Rejection is sticky and order-independent. A valid entry followed by a
		// malformed one used to leave the valid verdict eligible, so which answer
		// "counted" depended on the order the judge happened to emit them in.
		const orders: Array<[string, unknown]> = [
			[
				"valid then malformed",
				[
					{ index: 1, pass: false },
					{ index: 1, pass: "true" },
				],
			],
			[
				"malformed then valid",
				[
					{ index: 1, pass: "true" },
					{ index: 1, pass: false },
				],
			],
			["valid, malformed, valid again", [{ index: 1, pass: false }, { index: 1 }, { index: 1, pass: false }]],
			[
				"valid then null",
				[
					{ index: 1, pass: true },
					{ index: 1, pass: null },
				],
			],
		];
		for (const [label, bullets] of orders) {
			const strict = strictJudgeVerdicts(scenario, judgeRun(bullets));
			strictEqual(strict.verdicts.has(1), false, `${label}: no verdict survives`);
			ok(strict.rejected.has(1), `${label}: the refusal is recorded`);

			// As the baseline arm, against a passing treatment.
			const asBaseline = attributionFromStrict(scenario, strict, strictJudgeVerdicts(scenario, goodJudge([true])));
			strictEqual(asBaseline.verdict, "unmeasured", `${label}: no phantom helped`);
			strictEqual(asBaseline.counts.helped, 0, label);

			// And as the treatment arm, against a passing baseline.
			const asTreatment = attributionFromStrict(scenario, strictJudgeVerdicts(scenario, goodJudge([true])), strict);
			strictEqual(asTreatment.verdict, "unmeasured", `${label}: no phantom regressed`);
			strictEqual(asTreatment.counts.regressed, 0, label);
		}
	});

	it("accepts an agreeing duplicate and keeps its verdict", () => {
		const strict = strictJudgeVerdicts(
			scenario,
			judgeRun([
				{ index: 1, pass: true },
				{ index: 1, pass: true },
			]),
		);
		strictEqual(strict.verdicts.get(1), true);
		strictEqual(strict.rejected.has(1), false);
	});

	it("records a per-bullet reason when only some bullets carry evidence", () => {
		const two = scenarioOf(2);
		const attribution = attributionFromStrict(
			two,
			strictJudgeVerdicts(two, judgeRun([{ index: 1, pass: false }])),
			strictJudgeVerdicts(two, goodJudge([true, true])),
		);
		strictEqual(attribution.bullets[0]?.attribution, "helped");
		strictEqual(attribution.bullets[1]?.attribution, "unmeasured");
		ok(attribution.bullets[1]?.reason?.includes("omitted bullet 2"), attribution.bullets[1]?.reason ?? "no reason");
		strictEqual(attribution.verdict, "unmeasured", "one unmeasured bullet poisons the scenario");
		ok(attribution.reason !== null, "an unmeasured scenario says why");
	});

	it("reports an absent verdict object once rather than per bullet cause", () => {
		const strict = strictJudgeVerdicts(scenario, run({ transcript: "no json here", finalText: "no json here" }));
		ok(strict.absent !== null);
		const attribution = attributionFromStrict(scenario, strict, strictJudgeVerdicts(scenario, goodJudge([true])));
		ok(attribution.reason?.includes("no parseable verdict object"), attribution.reason ?? "no reason");
	});

	it("pairs two well-formed arms into a real comparison", () => {
		const two = scenarioOf(2);
		const attribution = attributionFromStrict(
			two,
			strictJudgeVerdicts(two, goodJudge([false, true])),
			strictJudgeVerdicts(two, goodJudge([true, false])),
		);
		strictEqual(attribution.verdict, "mixed");
		deepStrictEqual(
			attribution.bullets.map((b) => b.attribution),
			["helped", "regressed"],
		);
		deepStrictEqual(attribution.counts, { helped: 1, regressed: 1, noChangePass: 0, noChangeFail: 0, unmeasured: 0 });
		strictEqual(attribution.reason, null);
	});
});

describe("contracts/skill eval subject identity", () => {
	let root: string;

	before(async () => {
		root = await mkdtemp(join(tmpdir(), "clio-coder-skill-subject-"));
	});

	after(async () => {
		await rm(root, { recursive: true, force: true });
	});

	const base = (extra = "", body = "Body.") =>
		`---\nname: subject-probe\ndescription: A probe skill used to assert eval subject identity.\n${extra}---\n\n# Probe\n\n${body}\n`;

	async function writeSkill(name: string, content: string): Promise<string> {
		const dir = join(root, name);
		await rm(dir, { recursive: true, force: true });
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, "SKILL.md"), content, "utf8");
		return dir;
	}

	it("separates a content edit from an install-lifecycle stamp", async () => {
		const plain = await writeSkill("plain", base());
		const stamped = await writeSkill("stamped", base("clio-coder:\n  installed-at: 2026-01-01T00:00:00Z\n"));
		const edited = await writeSkill("edited", base("", "Body, edited."));
		const load = (dir: string) => {
			const item = loadSkills({ disableDiscovery: true, explicitSkillPaths: [dir] }).items[0];
			ok(item !== undefined, `skill loaded from ${dir}`);
			return item;
		};
		const a = load(plain);
		const b = load(stamped);
		const c = load(edited);
		ok(a.hash !== b.hash, "an install stamp changes the raw hash");
		strictEqual(a.normalizedHash, b.normalizedHash, "an install stamp does not change the pinned hash");
		ok(a.normalizedHash !== c.normalizedHash, "a body edit changes the pinned hash");
	});

	it("computes the same normalized hash the pin manifest compares against", async () => {
		const dir = await writeSkill("pinned", base());
		const item = loadSkills({ disableDiscovery: true, explicitSkillPaths: [dir] }).items[0];
		ok(item !== undefined);
		strictEqual(item.normalizedHash, normalizedSkillHash(await readFile(join(dir, "SKILL.md"), "utf8")));
	});

	it("digests the whole skill directory, not only SKILL.md", async () => {
		// A SKILL.md hash names that file. A skill is a directory whose body points
		// at references the run will read, so the identity has to cover the tree.
		const dir = await writeSkill("tree", base());
		const onlySkillMd = await skillTreeDigest(dir);
		await mkdir(join(dir, "references"), { recursive: true });
		await writeFile(join(dir, "references", "guide.md"), "step one\n", "utf8");
		const withReference = await skillTreeDigest(dir);
		ok(onlySkillMd !== null && withReference !== null);
		ok(onlySkillMd !== withReference, "adding a reference file changes the digest");

		await writeFile(join(dir, "references", "guide.md"), "step two\n", "utf8");
		const editedReference = await skillTreeDigest(dir);
		ok(editedReference !== withReference, "editing a reference file changes the digest");

		await rm(join(dir, "references", "guide.md"));
		await writeFile(join(dir, "references", "manual.md"), "step two\n", "utf8");
		ok((await skillTreeDigest(dir)) !== editedReference, "renaming a reference file changes the digest");
		strictEqual(await skillTreeDigest(join(root, "does-not-exist")), null, "an unreadable tree digests to null");
	});

	it("covers symlinks and refuses a tree whose link leaves it", async () => {
		// A link is part of the identity: retargeting one changes what the skill
		// reads without changing the set of regular files.
		const dir = await writeSkill("links", base());
		await mkdir(join(dir, "references"), { recursive: true });
		await writeFile(join(dir, "references", "a.md"), "alpha\n", "utf8");
		await writeFile(join(dir, "references", "b.md"), "beta\n", "utf8");
		await symlink("a.md", join(dir, "references", "current.md"));
		const pointingAtA = await skillTreeDigest(dir);
		ok(pointingAtA !== null, "an in-tree link is covered, not skipped");

		await rm(join(dir, "references", "current.md"));
		await symlink("b.md", join(dir, "references", "current.md"));
		ok((await skillTreeDigest(dir)) !== pointingAtA, "retargeting an in-tree link changes the digest");

		// A link out of the tree covers content the digest cannot see, so the
		// artifact is reported unverifiable rather than partially hashed.
		const outside = join(root, "outside.md");
		await writeFile(outside, "outside\n", "utf8");
		await rm(join(dir, "references", "current.md"));
		await symlink(outside, join(dir, "references", "current.md"));
		strictEqual(await skillTreeDigest(dir), null, "an escaping link makes the tree unverifiable");
	});

	it("refuses to pin an artifact whose body carries package references", () => {
		ok(artifactIsPinnable("# Probe\n\nOrdinary body.\n"));
		ok(!artifactIsPinnable("See ${pluginRoot}/references/guide.md for detail."));
		ok(!artifactIsPinnable("See ${component:skill:other}/SKILL.md."));
	});

	it("verifies only when the subject and both observations agree", () => {
		strictEqual(verifySubjectTree("a", "a", "a"), "verified");
		strictEqual(verifySubjectTree("a", "b", "b"), "mismatch", "changed before the arm");
		strictEqual(verifySubjectTree("a", "a", "b"), "mismatch", "changed during the arm");
		strictEqual(verifySubjectTree("a", "b", "a"), "mismatch", "changed and reverted around the arm");
		strictEqual(verifySubjectTree(null, "a", "a"), "unreadable");
		strictEqual(verifySubjectTree("a", null, "a"), "unreadable");
		strictEqual(verifySubjectTree("a", "a", null), "unreadable");
	});
});

// ---------------------------------------------------------------------------
// Production orchestration, driven by a scripted arm runner.
// ---------------------------------------------------------------------------

interface ScriptedArm {
	label: string;
	args: string[];
	cwd: string;
}

function scriptedRunner(reply: (label: string, args: ReadonlyArray<string>) => CapturedRun | Promise<CapturedRun>): {
	runner: SkillEvalArmRunner;
	calls: ScriptedArm[];
} {
	const calls: ScriptedArm[] = [];
	const runner: SkillEvalArmRunner = async (args, cwd) => {
		// The prompt is the last argument; each arm is identified by what it asks.
		const prompt = args[args.length - 1] ?? "";
		const label = prompt.startsWith("/skill ")
			? "treatment"
			: prompt.includes("TREATMENT TRANSCRIPT:")
				? "judge"
				: prompt.includes("it ran WITHOUT any skill loaded")
					? "baseline-judge"
					: "baseline";
		calls.push({ label, args: [...args], cwd });
		return reply(label, args);
	};
	return { runner, calls };
}

describe("contracts/skill eval scenario orchestration", () => {
	let root: string;
	let skillDir: string;

	const BODY = "---\nname: probe\ndescription: A probe skill.\n---\n\n# Probe\n\nBody.\n";
	const bodyHash = (body: string) => createHash("sha256").update(body, "utf8").digest("hex");

	before(async () => {
		root = await mkdtemp(join(tmpdir(), "clio-coder-skill-orch-"));
		skillDir = join(root, "probe");
		await mkdir(skillDir, { recursive: true });
		await writeFile(join(skillDir, "SKILL.md"), BODY, "utf8");
	});

	after(async () => {
		await rm(root, { recursive: true, force: true });
	});

	beforeEach(async () => {
		// Each case starts from the same artifact; a case that edits it under the
		// run must not leak that edit into the next.
		await rm(skillDir, { recursive: true, force: true });
		await mkdir(skillDir, { recursive: true });
		await writeFile(join(skillDir, "SKILL.md"), BODY, "utf8");
	});

	async function execute(
		over: Partial<RunScenarioInput> = {},
		reply: (label: string, args: ReadonlyArray<string>) => CapturedRun | Promise<CapturedRun> = () => run(),
	): Promise<{ outcome: Awaited<ReturnType<typeof runScenario>>; calls: ScriptedArm[] }> {
		const { runner, calls } = scriptedRunner(reply);
		const outcome = await runScenario({
			skillName: "probe",
			skillBaseDir: skillDir,
			scenario: scenarioOf(2),
			target: undefined,
			timeoutMs: 5_000,
			workspaceOverride: null,
			trustFixtures: false,
			childEnv: {},
			attributionEnabled: true,
			subjectTreeSha256: await skillTreeDigest(skillDir),
			subjectSha256: bodyHash(BODY),
			pinnable: true,
			runner,
			...over,
		});
		return { outcome, calls };
	}

	/** The pinned SKILL.md this arm was handed, read out of its own argv. */
	const pinnedSkillMd = (args: ReadonlyArray<string>) => join(args[args.indexOf("--skill") + 1] ?? "", "SKILL.md");

	/** The success path: the treatment arm reports it activated the snapshot. */
	const answering =
		(treatment?: (args: ReadonlyArray<string>) => CapturedRun) =>
		(label: string, args: ReadonlyArray<string>): CapturedRun =>
			label === "judge"
				? goodJudge([true, true])
				: label === "baseline-judge"
					? goodJudge([false, true])
					: label === "treatment"
						? (treatment ?? ((a: ReadonlyArray<string>) => activated(bodyHash(BODY), pinnedSkillMd(a))))(args)
						: run();

	it("runs four arms and produces a real comparison when everything answers", async () => {
		const { outcome, calls } = await execute({}, answering());
		deepStrictEqual(
			calls.map((call) => call.label),
			["baseline", "treatment", "judge", "baseline-judge"],
			"arm order is baseline, treatment, judge, baseline judge",
		);
		strictEqual(new Set(calls.map((call) => call.cwd)).size, 4, "each arm gets its own workspace");
		const skillArms = calls.filter((call) => call.args.includes("--skill"));
		deepStrictEqual(
			skillArms.map((call) => call.label),
			["treatment"],
			"only the treatment arm is handed the skill",
		);
		const handed = skillArms[0]?.args[skillArms[0].args.indexOf("--skill") + 1] ?? "";
		ok(handed !== skillDir, "the arm is handed the pinned copy, not the live source directory");
		ok(handed.includes("skill-eval-pin"), handed);
		for (const call of calls) {
			strictEqual(
				call.args.includes("--autonomy"),
				call.label === "baseline" || call.label === "treatment",
				`${call.label}: judges do not run at full-auto`,
			);
		}
		const baselineJudgePrompt = calls[3]?.args.at(-1) ?? "";
		ok(baselineJudgePrompt.includes("it ran WITHOUT any skill loaded"));
		ok(!baselineJudgePrompt.includes("TREATMENT TRANSCRIPT:"), "the baseline judge never sees the treatment arm");

		strictEqual(outcome.subjectVerification, "verified");
		strictEqual(outcome.attribution.verdict, "helped");
		deepStrictEqual(
			outcome.attribution.bullets.map((b) => b.attribution),
			["helped", "no-change-pass"],
		);
		deepStrictEqual(
			outcome.bullets.map((b) => b.verdict),
			["pass", "pass"],
			"the rubric result is treatment-only and unaffected by the comparison",
		);
	});

	const skipCases: Array<
		[
			string,
			Partial<RunScenarioInput>,
			(label: string, args: ReadonlyArray<string>) => CapturedRun | Promise<CapturedRun>,
			string,
			string,
		]
	> = [
		["attribution disabled", { attributionEnabled: false }, answering(), "not-attempted", "disabled by --no-attribution"],
		[
			"baseline arm infra failure",
			{},
			(label) => (label === "baseline" ? run({ exitCode: 9, stderr: "boom" }) : run()),
			"unmeasured",
			"baseline run exited 9",
		],
		[
			"treatment arm timeout",
			{},
			(label) => (label === "treatment" ? run({ timedOut: true }) : run()),
			"unmeasured",
			"treatment run timed out",
		],
		[
			"treatment judge failure",
			{},
			(label) => (label === "judge" ? run({ exitCode: 4 }) : run()),
			"unmeasured",
			"judge run exited 4",
		],
		[
			"wholly unmeasured treatment",
			{},
			(label, args) =>
				label === "judge"
					? run({ transcript: "nothing", finalText: "nothing" })
					: label === "treatment"
						? activated(bodyHash(BODY), pinnedSkillMd(args))
						: run(),
			"unmeasured",
			"nothing to compare",
		],
		["a changed skill tree", { subjectTreeSha256: "0".repeat(64) }, answering(), "unmeasured", "changed on disk"],
		["an unreadable skill tree", { subjectTreeSha256: null }, answering(), "unmeasured", "unverified"],
		[
			// The arm ran and answered, but never loaded the skill. Disk equality is
			// satisfied by exactly this run, which is why it is not enough on its own.
			"a treatment that activated nothing",
			{},
			answering(() => run()),
			"unmeasured",
			"recorded no successful activation",
		],
		[
			"a treatment that activated different content",
			{},
			answering((a) => activated("f".repeat(64), pinnedSkillMd(a))),
			"unmeasured",
			"not the pinned artifact's",
		],
		[
			"a treatment that activated a different skill",
			{},
			answering((a) => activated(bodyHash(BODY), pinnedSkillMd(a), "some-other-skill")),
			"unmeasured",
			"recorded no successful activation",
		],
		[
			"a treatment that activated two different revisions",
			{},
			answering((a) =>
				run({
					activations: [
						{ name: "probe", hash: bodyHash(BODY), path: pinnedSkillMd(a) },
						{ name: "probe", hash: "e".repeat(64), path: "/elsewhere/probe/SKILL.md" },
					],
				}),
			),
			"unmeasured",
			"not the pinned artifact's",
		],
		[
			"an artifact that cannot be pinned",
			{ pinnable: false },
			answering(),
			"unmeasured",
			"could not be pinned to an immutable copy",
		],
	];

	for (const [label, over, reply, verdict, reasonFragment] of skipCases) {
		it(`skips the baseline judge on ${label} and records why`, async () => {
			const { outcome, calls } = await execute(over, reply);
			strictEqual(
				calls.some((call) => call.label === "baseline-judge"),
				false,
				"no baseline judge ran",
			);
			strictEqual(outcome.baselineJudge, null);
			strictEqual(outcome.attribution.verdict, verdict);
			ok(outcome.attribution.reason?.includes(reasonFragment), outcome.attribution.reason ?? "no reason");
			ok(outcome.attribution.verdict !== "no-change", "a skipped comparison never reads as no-change");
		});
	}

	it("survives an edit and revert inside the treatment arm, which disk hashing alone cannot see", async () => {
		// The case the before/after digest misses entirely: the source changes to
		// B while the arm runs and is restored to A before it returns, so both
		// observations equal A. The arm loads the pinned copy, which nothing can
		// write to, so the edit never reaches it and the receipt still names A.
		const edited = BODY.replace("Body.", "Edited body.");
		const { outcome } = await execute({}, async (label, args) => {
			if (label !== "treatment")
				return label === "judge" ? goodJudge([true, true]) : label === "baseline-judge" ? goodJudge([false, true]) : run();
			await writeFile(join(skillDir, "SKILL.md"), edited, "utf8");
			const pinnedPath = args[args.indexOf("--skill") + 1] ?? "";
			const seen = await readFile(join(pinnedPath, "SKILL.md"), "utf8");
			await writeFile(join(skillDir, "SKILL.md"), BODY, "utf8");
			// The child reads the pin, so what it saw is A even while the source was B.
			strictEqual(seen, BODY, "the pinned copy is unaffected by an edit to the source");
			return activated(bodyHash(seen), join(pinnedPath, "SKILL.md"));
		});
		strictEqual(outcome.subjectVerification, "verified");
		strictEqual(outcome.attribution.verdict, "helped");
		strictEqual(
			await readFile(join(skillDir, "SKILL.md"), "utf8"),
			BODY,
			"the source was restored, as the case requires",
		);
	});

	it("keeps the rubric result when the skill tree changed under the run", async () => {
		const { outcome } = await execute({ subjectTreeSha256: "0".repeat(64) }, (label) =>
			label === "judge" ? goodJudge([true, true]) : run(),
		);
		strictEqual(outcome.subjectVerification, "mismatch");
		deepStrictEqual(
			outcome.bullets.map((b) => b.verdict),
			["pass", "pass"],
			"the rubric result still stands; only the comparison is refused",
		);
	});

	it("records a baseline judge that failed without disturbing the rubric result", async () => {
		const { outcome, calls } = await execute({}, (label, args) =>
			label === "judge"
				? goodJudge([true, true])
				: label === "baseline-judge"
					? run({ exitCode: 3 })
					: label === "treatment"
						? activated(bodyHash(BODY), pinnedSkillMd(args))
						: run(),
		);
		ok(
			calls.some((call) => call.label === "baseline-judge"),
			"the baseline judge did run",
		);
		ok(outcome.baselineJudge !== null, "and its run is recorded in the bundle");
		strictEqual(outcome.attribution.verdict, "unmeasured");
		ok(outcome.attribution.reason?.includes("baseline-judge run exited 3"), outcome.attribution.reason ?? "");
		deepStrictEqual(
			outcome.bullets.map((b) => b.verdict),
			["pass", "pass"],
		);
	});

	it("refuses a baseline judge that hit the harness permission wall", async () => {
		// The prompt tells the judge to use no tools. That is an instruction, not
		// enforcement, so a judge that tried anyway scored under a constraint the
		// treatment judge did not have.
		const { outcome } = await execute({}, (label, args) =>
			label === "treatment"
				? activated(bodyHash(BODY), pinnedSkillMd(args))
				: label === "judge"
					? goodJudge([true, true])
					: label === "baseline-judge"
						? run({
								transcript: `RESULT bash error: ${HEADLESS_PERMISSION_DENIED_MARKER}\n${JSON.stringify({
									bullets: [
										{ index: 1, pass: false },
										{ index: 2, pass: false },
									],
								})}`,
								finalText: JSON.stringify({
									bullets: [
										{ index: 1, pass: false },
										{ index: 2, pass: false },
									],
								}),
							})
						: run(),
		);
		strictEqual(outcome.attribution.verdict, "unmeasured");
		ok(outcome.attribution.reason?.includes("permission wall"), outcome.attribution.reason ?? "");
	});

	it("refuses a treatment judge that hit the permission wall, exactly as the baseline judge is", async () => {
		// The asymmetry the review found: the baseline judge was checked and the
		// treatment judge was not, so an equally compromised judge was eligible on
		// one side and refused on the other.
		const denied = JSON.stringify({
			bullets: [
				{ index: 1, pass: true },
				{ index: 2, pass: true },
			],
		});
		const { outcome } = await execute({}, (label, args) =>
			label === "judge"
				? run({ transcript: `RESULT bash error: ${HEADLESS_PERMISSION_DENIED_MARKER}\n${denied}`, finalText: denied })
				: label === "treatment"
					? activated(bodyHash(BODY), pinnedSkillMd(args))
					: run(),
		);
		strictEqual(outcome.attribution.verdict, "unmeasured");
		ok(outcome.attribution.reason?.includes("permission wall"), outcome.attribution.reason ?? "");
		deepStrictEqual(
			outcome.bullets.map((b) => b.verdict),
			["pass", "pass"],
			"the legacy rubric gate is untouched by comparative eligibility",
		);
	});

	it("refuses a comparison built on malformed baseline evidence, through the real path", async () => {
		// Blocker 1, end to end: the baseline judge omits `pass`, the treatment
		// passes. Before the strict parser this reported `helped`.
		const { outcome } = await execute({}, (label, args) =>
			label === "treatment"
				? activated(bodyHash(BODY), pinnedSkillMd(args))
				: label === "judge"
					? goodJudge([true, true])
					: label === "baseline-judge"
						? judgeRun([{ index: 1 }, { index: 2 }])
						: run(),
		);
		strictEqual(outcome.attribution.verdict, "unmeasured");
		strictEqual(
			outcome.attribution.counts.helped,
			0,
			"a missing boolean must not become a baseline failure and then a helped verdict",
		);
		ok(outcome.attribution.reason?.startsWith("baseline judge:"), outcome.attribution.reason ?? "");
	});

	it("serializes subject, verification and attribution into the sidecar", async () => {
		const { outcome } = await execute({}, answering());
		const subject: SkillEvalSubject = {
			name: "probe",
			baseDir: skillDir,
			origin: "path",
			sha256: "a".repeat(64),
			normalizedHash: "b".repeat(64),
			treeSha256: "c".repeat(64),
			pinnable: true,
			evalsPath: join(skillDir, "evals.md"),
			evalsSha256: "d".repeat(64),
			drift: { verdict: "mismatch", authority: "pinned-manifest", expected: "e".repeat(64) },
		};
		const payload = JSON.parse(JSON.stringify(sidecar(subject, "eval-1", [outcome], false, true))) as Record<
			string,
			unknown
		>;
		strictEqual(payload.version, 2);
		deepStrictEqual(payload.subject, subject);
		strictEqual(payload.attributionEnabled, true);
		deepStrictEqual(payload.attributionSummary, {
			helped: 1,
			regressed: 0,
			mixed: 0,
			"no-change": 0,
			unmeasured: 0,
			"not-attempted": 0,
		});
		const scenarios = payload.scenarios as Array<Record<string, unknown>>;
		strictEqual(scenarios[0]?.subjectVerification, "verified");
		ok(typeof scenarios[0]?.observedTreeSha256 === "string");
		ok(scenarios[0]?.baselineJudge !== null, "the baseline judge run is in the bundle");
		const deltas = payload.deltas as string[];
		ok(
			deltas.some((line) => line.includes("reported a successful activation whose sha256 equals subject.sha256")),
			"the sidecar states that verification rests on an activation receipt, not on disk equality alone",
		);
		ok(
			deltas.some((line) => line.includes("private per-run copy")),
			"and that the arm ran against a private copy",
		);
		ok(
			deltas.some((line) => line.includes("isolated snapshot, not an immutable pin")),
			"and says plainly what that copy is not",
		);
		ok(
			deltas.some((line) => line.includes("strict rules")),
			"the sidecar states that comparison evidence is parsed strictly",
		);
	});
});

describe("contracts/skill eval activation receipts", () => {
	// Driven by the actual event stream shape the child emits, not by hand-built
	// activation arrays: the parser has to find the receipt inside a real
	// tool_execution_end payload, and keep it out of the transcript.
	const stream = (events: unknown[]) => events.map((event) => JSON.stringify(event)).join("\n");

	const activationEvents = (over: Record<string, unknown> = {}, isError = false) => [
		{ type: "session_start", sessionId: "s-1" },
		{
			type: "tool_execution_start",
			toolCallId: "call-1",
			toolName: "context",
			args: { scope: "skills", name: "probe" },
		},
		{
			type: "tool_execution_end",
			toolCallId: "call-1",
			toolName: "context",
			isError,
			result: {
				content: [{ type: "text", text: "# Probe\n\nBody." }],
				details: { name: "probe", hash: "a".repeat(64), filePath: "/pin/skill/SKILL.md", source: "path", ...over },
			},
		},
		{ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }] } },
	];

	it("reads the activation receipt out of a real execution-end event", () => {
		const parsed = parseRunStdout(stream(activationEvents()));
		deepStrictEqual(parsed.activations, [{ name: "probe", hash: "a".repeat(64), path: "/pin/skill/SKILL.md" }]);
		ok(!parsed.transcript.includes("# Probe"), "the body still never reaches the transcript");
		ok(parsed.transcript.includes("skill body withheld"), "and the withholding is still visible");
	});

	it("records no receipt for a failed load", () => {
		strictEqual(parseRunStdout(stream(activationEvents({}, true))).activations.length, 0);
	});

	it("records no receipt when the details carry no hash", () => {
		const events = activationEvents();
		const end = events[2] as { result: { details: Record<string, unknown> } };
		delete end.result.details.hash;
		strictEqual(parseRunStdout(stream(events)).activations.length, 0);
	});

	it("records no receipt for an ordinary tool result", () => {
		const parsed = parseRunStdout(
			stream([
				{ type: "tool_execution_start", toolCallId: "c", toolName: "read", args: { path: "a.md" } },
				{ type: "tool_execution_end", toolCallId: "c", toolName: "read", result: { details: { name: "x" } } },
			]),
		);
		strictEqual(parsed.activations.length, 0);
	});

	it("refuses an activation whose bytes match but whose file is a different copy", () => {
		// Two directories can hold identical SKILL.md bytes beside different
		// reference files. A matching hash from elsewhere is not the artifact.
		strictEqual(
			verifyObservedActivation("probe", "a".repeat(64), "/pin/skill/SKILL.md", [
				{ name: "probe", hash: "a".repeat(64), path: "/elsewhere/skill/SKILL.md" },
			]),
			"activation-mismatch",
		);
		strictEqual(
			verifyObservedActivation("probe", "a".repeat(64), "/pin/skill/SKILL.md", [
				{ name: "probe", hash: "a".repeat(64), path: "/pin/skill/SKILL.md" },
			]),
			"verified",
		);
		strictEqual(
			verifyObservedActivation("probe", "a".repeat(64), "/pin/skill/SKILL.md", [
				{ name: "probe", hash: "a".repeat(64), path: "" },
			]),
			"activation-mismatch",
			"a receipt with no path establishes no copy",
		);
		strictEqual(verifyObservedActivation("probe", "a".repeat(64), "/pin/skill/SKILL.md", []), "not-activated");
	});
});

describe("contracts/skill eval cli surface", () => {
	it("accepts --no-attribution and still rejects an unknown flag", async () => {
		strictEqual(await runSkillEvalCli(["--no-attribution", "definitely-not-a-real-skill-name-xyz"]), 2);
		strictEqual(await runSkillEvalCli(["--no-such-flag", "x"]), 2);
	});

	it("documents --no-attribution in the help output", async () => {
		const written: string[] = [];
		const original = process.stdout.write.bind(process.stdout);
		process.stdout.write = ((chunk: string) => {
			written.push(String(chunk));
			return true;
		}) as typeof process.stdout.write;
		try {
			strictEqual(await runSkillEvalCli(["--help"]), 0);
		} finally {
			process.stdout.write = original;
		}
		const help = written.join("");
		ok(help.includes("--no-attribution"));
		ok(help.includes("saves one judge run per scenario"));
	});
});

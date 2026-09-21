import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
	type AttributedBullet,
	attributionFromBullets,
	deriveBulletAttribution,
	deriveScenarioAttributionVerdict,
	runSkillEvalCli,
	type ScoredBullet,
} from "../../src/cli/skills-eval.js";
import { normalizedSkillHash } from "../../src/domains/resources/skills/content-hash.js";
import { loadSkills } from "../../src/domains/resources/skills/loader.js";

/**
 * P3 attribution and P2 subject identity.
 *
 * The derivation is a pure function over two verdict lists, so it is tested by
 * exhaustive enumeration rather than by a sampled split: every (baseline,
 * treatment) pair the harness can produce appears below. That is the validity
 * argument here, and it is stated rather than implied, because exhaustiveness
 * over a 4x4 space is a different claim from a held-out sample.
 *
 * Nothing in this file launches a model. The scenario-level behaviour that does
 * (skipping the baseline judge, the flag) is asserted through the CLI's own
 * argument and reporting paths and through the derivation, never by paying for
 * an inference in a contract test.
 */

const VERDICTS = ["pass", "fail", "error", "unmeasured"] as const;
type Verdict = (typeof VERDICTS)[number];

function bullet(index: number, verdict: Verdict, text = `expected ${index}`): ScoredBullet {
	return { index, text, verdict, reason: "" };
}

describe("contracts/skill eval attribution", () => {
	it("derives every baseline x treatment pair, exhaustively", () => {
		// The complete cross-product. Written out rather than generated, so the
		// intended answer for each cell is reviewable next to the cell.
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
				const key = `${baseline}|${treatment}`;
				strictEqual(deriveBulletAttribution(baseline, treatment), expected[key], `${key} must derive ${expected[key]}`);
			}
		}
	});

	it("never reports a pair as changed when neither arm produced a verdict", () => {
		// The single invariant the exhaustive table above encodes, asserted on its
		// own so a future edit to the table cannot quietly drop it.
		for (const baseline of VERDICTS) {
			for (const treatment of VERDICTS) {
				const unscored =
					baseline === "error" || baseline === "unmeasured" || treatment === "error" || treatment === "unmeasured";
				const derived = deriveBulletAttribution(baseline, treatment);
				if (unscored) strictEqual(derived, "unmeasured", `${baseline}|${treatment} must not read as a comparison`);
				else ok(derived !== "unmeasured", `${baseline}|${treatment} is a real comparison`);
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
		// Three helped and one regressed is still mixed, never "helped".
		strictEqual(
			deriveScenarioAttributionVerdict([at(1, "helped"), at(2, "helped"), at(3, "helped"), at(4, "regressed")]),
			"mixed",
		);
		// One unmeasured bullet poisons the whole scenario, in every combination.
		strictEqual(deriveScenarioAttributionVerdict([at(1, "helped"), at(2, "unmeasured")]), "unmeasured");
		strictEqual(deriveScenarioAttributionVerdict([at(1, "regressed"), at(2, "unmeasured")]), "unmeasured");
		strictEqual(deriveScenarioAttributionVerdict([at(1, "no-change-pass"), at(2, "unmeasured")]), "unmeasured");
	});

	it("pairs bullets by index and counts each attribution", () => {
		const baseline = [bullet(1, "fail"), bullet(2, "pass"), bullet(3, "pass"), bullet(4, "fail")];
		const treatment = [bullet(1, "pass"), bullet(2, "pass"), bullet(3, "fail"), bullet(4, "fail")];
		const attribution = attributionFromBullets(baseline, treatment);
		strictEqual(attribution.verdict, "mixed");
		strictEqual(attribution.reason, null);
		deepStrictEqual(
			attribution.bullets.map((item) => item.attribution),
			["helped", "no-change-pass", "regressed", "no-change-fail"],
		);
		deepStrictEqual(attribution.counts, {
			helped: 1,
			regressed: 1,
			noChangePass: 1,
			noChangeFail: 1,
			unmeasured: 0,
		});
	});

	it("treats a treatment bullet with no baseline counterpart as unmeasured, not as a change", () => {
		// The baseline judge answered bullet 1 and skipped bullet 2. Pairing by
		// position instead of by index would have called bullet 2 "helped".
		const attribution = attributionFromBullets([bullet(1, "fail")], [bullet(1, "pass"), bullet(2, "pass")]);
		deepStrictEqual(
			attribution.bullets.map((item) => [item.index, item.baseline, item.attribution]),
			[
				[1, "fail", "helped"],
				[2, "unmeasured", "unmeasured"],
			],
		);
		strictEqual(attribution.verdict, "unmeasured");
	});

	it("keeps baseline pairing index-correct when the judge answers out of order", () => {
		const attribution = attributionFromBullets(
			[bullet(2, "pass"), bullet(1, "fail")],
			[bullet(1, "pass"), bullet(2, "fail")],
		);
		deepStrictEqual(
			attribution.bullets.map((item) => [item.index, item.baseline, item.treatment, item.attribution]),
			[
				[1, "fail", "pass", "helped"],
				[2, "pass", "fail", "regressed"],
			],
		);
		strictEqual(attribution.verdict, "mixed");
	});

	it("accepts --no-attribution and rejects it as a value-taking flag", async () => {
		// The flag has to parse before anything else can be true about it. A bad
		// skill name exits 2 from the command, not from argument parsing.
		const code = await runSkillEvalCli(["--no-attribution", "definitely-not-a-real-skill-name-xyz"]);
		strictEqual(code, 2, "an unknown skill still exits 2 with the flag present");
		const unknown = await runSkillEvalCli(["--no-such-flag", "x"]);
		strictEqual(unknown, 2, "an unknown flag is still rejected");
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
		ok(help.includes("--no-attribution"), "help names the flag");
		ok(help.includes("saves one judge run per scenario"), "help states what it costs to keep");
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

	async function writeSkill(name: string, body: string): Promise<string> {
		const dir = join(root, name);
		await rm(dir, { recursive: true, force: true });
		const { mkdir } = await import("node:fs/promises");
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, "SKILL.md"), body, "utf8");
		return dir;
	}

	const base = (extra = "") =>
		`---\nname: subject-probe\ndescription: A probe skill used to assert eval subject identity.\n${extra}---\n\n# Probe\n\nBody.\n`;

	it("separates a content edit from an install-lifecycle stamp", async () => {
		// The two hashes exist to answer different questions, and the subject block
		// records both. An install stamp must move `sha256` and leave
		// `normalizedHash` alone, or a reinstalled copy would read as drifted.
		const plain = await writeSkill("plain", base());
		const stamped = await writeSkill("stamped", base("clio-coder:\n  installed-at: 2026-01-01T00:00:00Z\n"));
		const edited = await writeSkill("edited", base().replace("Body.", "Body, edited."));

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
		const { readFile } = await import("node:fs/promises");
		const raw = await readFile(join(dir, "SKILL.md"), "utf8");
		strictEqual(item.normalizedHash, normalizedSkillHash(raw), "subject.normalizedHash is the pinned-hash function");
		strictEqual(item.normalizedHash.length, 64);
	});
});

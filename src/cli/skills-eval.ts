import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative as relativePath, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { combineBashOutput, runBashCommand } from "../core/bash-exec.js";
import { HEADLESS_PERMISSION_DENIED_MARKER } from "../core/headless-permission.js";
import { clioDataDir, clioStateDir } from "../core/xdg.js";
import {
	type EvalHarnessMetrics,
	type EvalRunArtifact,
	type EvalRunRecord,
	evalClioProvenance,
	evalEnvironmentProvenance,
	summarizeEvalResults,
	writeEvalArtifact,
	ZERO_EVAL_HARNESS_METRICS,
} from "../domains/eval/index.js";
import { buildEvalEvidence } from "../domains/evidence/index.js";
import {
	checkSkillDrift,
	discoverMarketplaceSkills,
	loadSkills,
	parseSkillEvals,
	type SkillEvalScenario,
} from "../domains/resources/index.js";
import { NO_NETWORK_TOOLS_ENV } from "../tools/network-policy.js";
import { effectiveToolCall } from "../tools/surface.js";
import { formatColumns, printError } from "./shared.js";

/**
 * Executable skill evals (experimental). Every catalog skill ships an
 * `evals.md` with RED-GREEN scenarios; this lane executes them instead of
 * trusting the prose: per scenario one baseline headless run (no skills), one
 * treatment run (the skill loaded via the explicit --skill path and invoked
 * with /skill <name>), then one judge run that scores each Expected bullet
 * pass/fail from the two transcripts.
 *
 * Deltas from the task-file eval harness, recorded rather than papered over:
 * the evals domain verifies with setup/verifier commands and has no judge, so
 * bullet verdicts here come from a model run, not command exit codes. The
 * synthesized EvalRunArtifact carries scenario-level records with empty
 * command lists, receipt-backed token/cost totals when headless main-agent
 * receipts are present, and per-bullet detail in a `skill-eval.json` sidecar
 * registered in the bundle's `overview.json` files list.
 *
 * Two things the sidecar records beyond the rubric result.
 *
 * `subject` names the exact artifact the run measured: the resolved base
 * directory, how it was resolved, both hashes of the SKILL.md, and whether that
 * content still matches whatever hash was recorded for it. A bundle that names
 * only a skill and an evals.md cannot be compared against another bundle for
 * the same skill, because nothing in either says whether the skill changed.
 *
 * `attribution` answers "did the skill change anything?" by scoring the
 * baseline arm too. That arm was always executed and always thrown away: the
 * treatment judge is told the baseline exists only for context. A second,
 * isolated judge scores it against the same bullets, and the two verdict sets
 * are paired per bullet. It is advisory in the strict sense: `pass`,
 * `exitCode` and `failureClass` keep their treatment-only meaning, and no
 * attribution value reaches the exit code. `--no-attribution` skips it.
 */

const DEFAULT_RUN_TIMEOUT_MS = 600_000;
/**
 * The autonomy the acting arms run at.
 *
 * A headless `clio-coder run` has no operator to answer a permission ask, so below
 * full-auto every exec-class call in an arm dies with the harness's own denial
 * and the judge scores a skill that was never allowed to act. The 2026-08-13
 * harness decision is that eval arms run full-auto because their workspaces
 * are per-run copies created under a
 * private temp root and removed when the scenario ends. The judge arm is
 * excluded: it scores text and is instructed to call no tools, so granting it
 * unattended write and exec buys nothing.
 */
const ARM_AUTONOMY = "full-auto";
const CHILD_OUTPUT_LIMIT = 4_000_000;
const PREVIEW_MAX_CHARS = 300;
const TRANSCRIPT_HEAD_CHARS = 9_000;
const TRANSCRIPT_TAIL_CHARS = 4_000;
/** Per-eval detail file written beside the standard bundle and registered in overview.files. */
const SKILL_EVAL_SIDECAR = "skill-eval.json";

export interface SkillsEvalOptions {
	json: boolean;
	/**
	 * Fixture commands in evals.md are shell authored by the skill, executed
	 * with the operator's environment. They run only on explicit opt-in;
	 * without it a fixture-bearing scenario reports an error instead of
	 * silently executing third-party shell.
	 */
	trustFixtures: boolean;
	/**
	 * Let the arm runs keep the network tool plane. Off by default: an eval is
	 * a measurement of a skill against a fixed workspace, and a run that can
	 * fetch the open web is measuring something else as well.
	 */
	allowNetwork: boolean;
	/**
	 * Skip the baseline judge, and with it the paired attribution.
	 *
	 * Attribution costs one extra judge run per scenario. Turning it off is a
	 * cost decision, not a result: a skipped comparison is recorded
	 * `not-attempted` with the reason, never `no-change`.
	 */
	noAttribution: boolean;
	scenario?: string;
	target?: string;
	timeoutSeconds?: number;
	workspace?: string;
}

/**
 * `unmeasured` is not a verdict on the skill. It is the state of a bullet the
 * judge never scored, which is a different fact from a bullet the judge scored
 * negative, and reporting it as `fail` (or as `error`, which the exit code
 * treats as failure) said the skill broke when what broke was the scoring run.
 */
type BulletVerdict = "pass" | "fail" | "error" | "unmeasured";

/** Exported for contracts tests. */
export interface ScoredBullet {
	index: number;
	text: string;
	verdict: BulletVerdict;
	reason: string;
}

/**
 * One skill activation this run actually performed, as the activation contract
 * reported it. `hash` is the sha256 of the bytes the child read.
 *
 * @internal Exported for contract tests.
 */
export interface ObservedActivation {
	name: string;
	hash: string;
	path: string;
}

/** Exported for contracts tests. */
export interface CapturedRun {
	sessionId: string | null;
	transcript: string;
	finalText: string;
	exitCode: number;
	timedOut: boolean;
	wallTimeMs: number;
	stderr: string;
	/** Skill loads this run completed successfully; empty when none did. */
	activations: ObservedActivation[];
}

interface ScenarioUsage {
	tokens: number;
	costUsd: number;
	harness: EvalHarnessMetrics;
}

/**
 * The exact artifact a run measured.
 *
 * A bundle used to name only its `evals.md` by hash, so two runs of the same
 * skill could not be told apart when the SKILL.md between them had changed.
 * Everything here is already computed elsewhere in the run: the loader hashes
 * the file, `resolveSkillBaseDir` resolves which copy activation would pick,
 * and `checkSkillDrift` compares it against whatever recorded hash speaks for
 * it. Discarding all of it was the whole gap.
 *
 * @internal Exported for contract tests.
 */
export interface SkillEvalSubject {
	name: string;
	baseDir: string;
	/** How the copy was resolved: `path`, `<source>/<scope>`, or `catalog`. */
	origin: string;
	/** sha256 of the SKILL.md exactly as read. */
	sha256: string;
	/** sha256 with install-lifecycle provenance stripped; this is what pins compare. */
	normalizedHash: string;
	/**
	 * Digest over every file under `baseDir`, not just SKILL.md.
	 *
	 * A skill is a directory: the body can point at `references/` and scripts
	 * the run will read. Naming the artifact by its SKILL.md hash alone would
	 * claim an identity for content that hash does not cover, and would miss an
	 * edit to a reference file entirely. Null when the tree could not be read.
	 */
	treeSha256: string | null;
	/**
	 * Whether the artifact could be snapshotted for the run. False when the body
	 * carries package references, which resolve against an owning package root
	 * above the skill directory: a copy of the directory alone would deliver
	 * different instructions from the live path.
	 */
	pinnable: boolean;
	evalsPath: string;
	evalsSha256: string;
	/** Null when nothing on this machine recorded a hash for the skill. */
	drift: { verdict: "match" | "mismatch"; authority: string; expected: string } | null;
}

/**
 * Whether the artifact on disk still matched {@link SkillEvalSubject} across
 * one scenario's treatment arm.
 *
 * `verified` states exactly one thing: the tree digest taken immediately before
 * the treatment arm and again immediately after both equalled the run-level
 * subject. It is not proof of what the child activated. The treatment child
 * loads the skill from the live source directory by path, so an edit landing
 * between resolution and the arm, or between two scenarios, would otherwise be
 * measured under the previous artifact's recorded identity. This check closes
 * that window; it cannot see a change reverted entirely inside the arm, and the
 * sidecar says so rather than implying activation was witnessed.
 */
export type SubjectVerification =
	| "verified"
	| "mismatch"
	| "unreadable"
	| "not-pinned"
	| "not-activated"
	| "activation-mismatch"
	| "not-checked";

/**
 * Whether the skill changed the outcome for one bullet, relative to the same
 * bullet in the baseline arm.
 *
 * `unmeasured` is not a comparison that came out even. It is the absence of a
 * comparison, and it is returned whenever either arm failed to produce a
 * verdict for that bullet.
 *
 * @internal Exported for contract tests.
 */
export type BulletAttribution = "helped" | "regressed" | "no-change-pass" | "no-change-fail" | "unmeasured";

/**
 * The scenario-level rollup.
 *
 * `not-attempted` and `unmeasured` are deliberately separate. The first means
 * the comparison was never run, the second means it was impossible. Collapsing
 * either into `no-change` would report "the skill made no difference" about a
 * measurement that never happened.
 *
 * @internal Exported for contract tests.
 */
export type ScenarioAttributionVerdict =
	| "helped"
	| "regressed"
	| "mixed"
	| "no-change"
	| "unmeasured"
	| "not-attempted";

/** @internal Exported for contract tests. */
export interface AttributedBullet {
	index: number;
	text: string;
	baseline: BulletVerdict;
	treatment: BulletVerdict;
	attribution: BulletAttribution;
	/** Why this bullet is unmeasured; absent once both arms supplied evidence. */
	reason?: string;
}

/** @internal Exported for contract tests. */
export interface ScenarioAttribution {
	verdict: ScenarioAttributionVerdict;
	/** Why the verdict is `unmeasured` or `not-attempted`; null once a real comparison ran. */
	reason: string | null;
	bullets: AttributedBullet[];
	counts: {
		helped: number;
		regressed: number;
		noChangePass: number;
		noChangeFail: number;
		unmeasured: number;
	};
}

interface ScenarioOutcome {
	scenario: SkillEvalScenario;
	bullets: ScoredBullet[];
	baseline: CapturedRun | null;
	treatment: CapturedRun | null;
	judge: CapturedRun | null;
	/** The isolated judge run that scored the baseline arm; null when none ran. */
	baselineJudge: CapturedRun | null;
	/** Whether the artifact on disk still matched the subject across this scenario. */
	subjectVerification: SubjectVerification;
	/** Tree digest observed after this scenario's treatment arm; null when unread. */
	observedTreeSha256: string | null;
	/** Advisory paired comparison. Never a gate, never folded into `pass`. */
	attribution: ScenarioAttribution;
	/** Seed workspace cloned for both arms; removed after the run, kept as a record. */
	workspace: string;
	wallTimeMs: number;
	infraError: string | null;
	usage: ScenarioUsage;
}

/**
 * Did the skill change this bullet's outcome?
 *
 * Either arm failing to produce a verdict makes the pair unmeasurable, and that
 * check comes first: a bullet the baseline judge never scored carries no
 * information about the treatment, whatever the treatment did.
 *
 * @internal Exported for contract tests.
 */
export function deriveBulletAttribution(baseline: BulletVerdict, treatment: BulletVerdict): BulletAttribution {
	if (baseline === "unmeasured" || baseline === "error") return "unmeasured";
	if (treatment === "unmeasured" || treatment === "error") return "unmeasured";
	if (baseline === "fail" && treatment === "pass") return "helped";
	if (baseline === "pass" && treatment === "fail") return "regressed";
	return baseline === "pass" ? "no-change-pass" : "no-change-fail";
}

/**
 * Roll per-bullet attributions into one scenario verdict.
 *
 * Order matters and is deliberate. An unmeasured bullet poisons the scenario,
 * because a rollup that ignored it would report a comparison over a subset
 * while naming the whole. `mixed` outranks both single-direction verdicts, so a
 * skill that fixed three bullets and broke one is never reported as simply
 * having helped.
 *
 * @internal Exported for contract tests.
 */
export function deriveScenarioAttributionVerdict(
	bullets: ReadonlyArray<AttributedBullet>,
): Exclude<ScenarioAttributionVerdict, "not-attempted"> {
	if (bullets.length === 0) return "unmeasured";
	if (bullets.some((bullet) => bullet.attribution === "unmeasured")) return "unmeasured";
	const helped = bullets.some((bullet) => bullet.attribution === "helped");
	const regressed = bullets.some((bullet) => bullet.attribution === "regressed");
	if (helped && regressed) return "mixed";
	if (regressed) return "regressed";
	if (helped) return "helped";
	return "no-change";
}

function attributionCounts(bullets: ReadonlyArray<AttributedBullet>): ScenarioAttribution["counts"] {
	const counts = { helped: 0, regressed: 0, noChangePass: 0, noChangeFail: 0, unmeasured: 0 };
	for (const bullet of bullets) {
		if (bullet.attribution === "helped") counts.helped += 1;
		else if (bullet.attribution === "regressed") counts.regressed += 1;
		else if (bullet.attribution === "no-change-pass") counts.noChangePass += 1;
		else if (bullet.attribution === "no-change-fail") counts.noChangeFail += 1;
		else counts.unmeasured += 1;
	}
	return counts;
}

/**
 * Pair two arms' strict verdicts into a per-bullet comparison.
 *
 * Both sides have to have supplied unambiguous evidence for the same bullet.
 * When either did not, the bullet is `unmeasured` and carries the reason it was
 * refused, so a reader can tell "the judge omitted it" from "the judge answered
 * with a string" from "the judge contradicted itself". The reason used to be
 * dropped during pairing, which left an unmeasured scenario with nothing saying
 * why.
 *
 * @internal Exported for contract tests.
 */
export function attributionFromStrict(
	scenario: SkillEvalScenario,
	baseline: StrictJudgeVerdicts,
	treatment: StrictJudgeVerdicts,
): ScenarioAttribution {
	const verdictOf = (pass: boolean | undefined): BulletVerdict =>
		pass === undefined ? "unmeasured" : pass ? "pass" : "fail";
	const refusal = (side: string, strict: StrictJudgeVerdicts, index: number): string | null => {
		if (strict.verdicts.has(index)) return null;
		if (strict.absent !== null) return `${side} judge: ${strict.absent}`;
		return `${side} judge: ${strict.rejected.get(index) ?? `no verdict for bullet ${index}`}`;
	};
	const bullets: AttributedBullet[] = scenario.expected.map((text, i) => {
		const index = i + 1;
		const baselinePass = baseline.verdicts.get(index);
		const treatmentPass = treatment.verdicts.get(index);
		const baselineVerdict = verdictOf(baselinePass);
		const treatmentVerdict = verdictOf(treatmentPass);
		const reason = refusal("baseline", baseline, index) ?? refusal("treatment", treatment, index);
		return {
			index,
			text,
			baseline: baselineVerdict,
			treatment: treatmentVerdict,
			attribution: deriveBulletAttribution(baselineVerdict, treatmentVerdict),
			...(reason !== null ? { reason } : {}),
		};
	});
	const verdict = deriveScenarioAttributionVerdict(bullets);
	const firstReason = bullets.find((bullet) => bullet.reason !== undefined)?.reason ?? null;
	return {
		verdict,
		reason: verdict === "unmeasured" ? firstReason : null,
		bullets,
		counts: attributionCounts(bullets),
	};
}

/**
 * A digest of the whole skill directory, path-sensitive and order-independent.
 *
 * Sorted relative paths are hashed alongside their contents, so adding, moving
 * or removing a reference file changes the digest as surely as editing one
 * does. Null on any read failure rather than a partial digest, because a digest
 * over some of a tree would compare unequal for a reason that is not a change.
 *
 * @internal Exported for contract tests.
 */
export async function skillTreeDigest(baseDir: string): Promise<string | null> {
	interface Entry {
		relative: string;
		kind: "file" | "symlink";
		target?: string;
	}
	const root = resolve(baseDir);
	const entries: Entry[] = [];
	const seenDirs = new Set<string>();
	const walk = async (dir: string): Promise<void> => {
		// A directory symlink pointing at an ancestor would otherwise walk forever.
		const real = await realpath(dir);
		if (seenDirs.has(real)) throw new Error("cycle");
		seenDirs.add(real);
		const found = await readdir(dir, { withFileTypes: true });
		for (const entry of found.sort((a, b) => a.name.localeCompare(b.name))) {
			const full = join(dir, entry.name);
			if (entry.isSymbolicLink()) {
				// A link is part of the artifact's identity: retargeting one changes
				// what the skill reads without changing any regular file. The link's
				// own target string is hashed, and a link leaving the tree makes the
				// artifact unverifiable rather than silently half-covered.
				const target = await readlink(full);
				const resolved = resolve(dir, target);
				const relative = relativePath(root, resolved);
				if (relative.startsWith("..") || isAbsolute(relative)) throw new Error("escaping symlink");
				entries.push({ relative: full.slice(root.length), kind: "symlink", target });
				continue;
			}
			if (entry.isDirectory()) await walk(full);
			else if (entry.isFile()) entries.push({ relative: full.slice(root.length), kind: "file" });
		}
	};
	try {
		await walk(root);
		const hash = createHash("sha256");
		for (const entry of entries.sort((a, b) => a.relative.localeCompare(b.relative))) {
			hash.update(entry.relative, "utf8");
			hash.update("\0");
			hash.update(entry.kind, "utf8");
			hash.update("\0");
			if (entry.kind === "symlink") hash.update(entry.target ?? "", "utf8");
			else hash.update(await readFile(join(root, entry.relative)));
			hash.update("\0");
		}
		return hash.digest("hex");
	} catch {
		return null;
	}
}

/**
 * Whether the artifact can be snapshotted for the run.
 *
 * The treatment arm runs against a private copy rather than the live source
 * directory. Hashing the source before and after the arm catches an edit that
 * persists and nothing else: an A to B to A change inside the arm leaves both
 * observations equal while the child read B. A copy under a per-run temp root
 * is not reachable from the source path, so an ordinary edit there cannot
 * affect the run.
 *
 * What that is, precisely: an isolated snapshot, not an immutable pin. The
 * copy sits in a writable temp directory, and the arm runs at full-auto, so a
 * model that chose to edit the copy, read it, and restore it would not be
 * detected. The harness has no mechanism that would make the copy read-only to
 * its own child, and building one is out of scope here. These results are
 * evidence about a cooperative model, which is the same caveat
 * `materializeSkillEvalWorkspaces` already records about arm isolation.
 *
 * Returns false for the one case a copy would misrepresent: a body carrying
 * package references. Those resolve against the owning package root, which
 * sits above the skill directory and is not part of the copy, so a copied
 * skill would deliver different instructions from the ones the live path
 * delivers. A tree whose digest cannot be taken is a separate failure and is
 * reported by `skillTreeDigest` returning null.
 *
 * @internal Exported for contract tests.
 */
export function artifactIsPinnable(skillBody: string): boolean {
	return !skillBody.includes("${pluginRoot}") && !skillBody.includes("${component:");
}

/** No comparison was attempted. Records why, and never reads as `no-change`. */
function notAttemptedAttribution(reason: string): ScenarioAttribution {
	return { verdict: "not-attempted", reason, bullets: [], counts: attributionCounts([]) };
}

/** A comparison was impossible. Distinct from one that was never started. */
function unmeasurableAttribution(reason: string): ScenarioAttribution {
	return { verdict: "unmeasured", reason, bullets: [], counts: attributionCounts([]) };
}

async function runSkillsEvalCommand(nameOrPath: string, options: SkillsEvalOptions): Promise<number> {
	const resolved = resolveSkillBaseDir(nameOrPath, process.cwd());
	if (resolved.baseDir === null) {
		printError(resolved.error ?? `unknown skill: ${nameOrPath}`);
		return 2;
	}
	const list = loadSkills({ disableDiscovery: true, explicitSkillPaths: [resolved.baseDir] });
	const skill = list.items[0];
	if (skill === undefined) {
		printError(`skill did not load from ${resolved.baseDir}: ${list.diagnostics.map((d) => d.message).join("; ")}`);
		return 2;
	}
	// Which copy is under test, before any scenario runs. A result nobody can
	// attribute to a source is not evidence about a skill, and several roots may
	// carry this name.
	process.stderr.write(
		`clio-coder eval skill: ${skill.name} from ${resolved.origin ?? "unknown"} at ${resolved.baseDir} (sha256 ${skill.normalizedHash.slice(0, 12)}…)\n`,
	);
	const evalsPath = join(resolved.baseDir, "evals.md");
	let evalsRaw: string;
	try {
		evalsRaw = await readFile(evalsPath, "utf8");
	} catch {
		printError(`skill ${skill.name} has no evals.md at ${evalsPath}`);
		return 2;
	}
	const parsed = parseSkillEvals(evalsRaw);
	for (const diagnostic of parsed.diagnostics) {
		process.stderr.write(`clio-coder eval skill: ${diagnostic}\n`);
	}
	// Coherence check on the subject itself. `skill` was loaded, and its hashes
	// taken, before the tree digest; an edit landing in that gap would produce a
	// subject naming one SKILL.md revision and a tree containing another. The
	// SKILL.md is re-read here and compared, so the recorded identity describes
	// one state of the directory or admits it could not.
	const subjectTree = await skillTreeDigest(resolved.baseDir);
	const reread = await readFile(join(resolved.baseDir, "SKILL.md"), "utf8").catch(() => null);
	const coherent = reread !== null && createHash("sha256").update(reread, "utf8").digest("hex") === skill.hash;
	const pinnable = reread !== null && artifactIsPinnable(reread);
	const driftReport = checkSkillDrift(skill, process.cwd());
	const subject: SkillEvalSubject = {
		name: skill.name,
		baseDir: resolved.baseDir,
		origin: resolved.origin ?? "unknown",
		sha256: skill.hash,
		normalizedHash: skill.normalizedHash,
		treeSha256: coherent ? subjectTree : null,
		pinnable,
		evalsPath,
		evalsSha256: createHash("sha256").update(evalsRaw, "utf8").digest("hex"),
		drift:
			driftReport === null
				? null
				: { verdict: driftReport.verdict, authority: driftReport.authority, expected: driftReport.expected },
	};
	// Said once, before any arm runs. A bundle measured against content that no
	// longer matches its recorded form is evidence about a different artifact
	// than the one it names, and the reader has to know that up front. It does
	// not block: drift never gates activation either.
	if (subject.drift?.verdict === "mismatch") {
		process.stderr.write(
			`clio-coder eval skill: WARNING skill_drift: ${skill.name} content (sha256 ${skill.normalizedHash.slice(0, 12)}…) ` +
				`does not match the hash recorded for it by the ${subject.drift.authority} (expected ${subject.drift.expected.slice(0, 12)}…); ` +
				"this run measures the copy on disk, not the recorded one\n",
		);
	}
	const matcher = options.scenario === undefined ? null : scenarioMatcher(options.scenario);
	if (options.scenario !== undefined && matcher === null) {
		printError(`invalid --scenario "${options.scenario}": use a scenario id like S1 or a bare number`);
		return 2;
	}
	const scenarios = matcher === null ? parsed.scenarios : parsed.scenarios.filter(matcher);
	if (scenarios.length === 0) {
		printError(
			matcher === null
				? `no parseable scenarios in ${evalsPath}`
				: `scenario ${options.scenario} not found in ${evalsPath} (have: ${parsed.scenarios.map((s) => s.id).join(", ") || "none"})`,
		);
		return 2;
	}

	process.stderr.write(`clio-coder eval skill: ${describeArmPolicy(options.allowNetwork)}\n`);
	const childEnv = evalChildEnv(options.allowNetwork);
	const timeoutMs = options.timeoutSeconds !== undefined ? options.timeoutSeconds * 1000 : DEFAULT_RUN_TIMEOUT_MS;
	const workspaceOverride = await resolveWorkspaceOverride(options.workspace);
	if (typeof workspaceOverride !== "string" && workspaceOverride !== null) {
		printError(workspaceOverride.error);
		return 2;
	}
	const startedAt = new Date().toISOString();
	const outcomes: ScenarioOutcome[] = [];
	const attributionEnabled = !options.noAttribution;
	for (const scenario of scenarios) {
		process.stderr.write(
			`clio-coder eval skill: ${skill.name} ${scenario.id} baseline/treatment/judge${attributionEnabled ? "/baseline-judge" : ""}...\n`,
		);
		outcomes.push(
			await runScenario({
				skillName: skill.name,
				skillBaseDir: resolved.baseDir,
				scenario,
				target: options.target,
				timeoutMs,
				workspaceOverride,
				trustFixtures: options.trustFixtures,
				childEnv,
				attributionEnabled,
				subjectTreeSha256: subject.treeSha256,
				subjectSha256: subject.sha256,
				pinnable: subject.pinnable,
			}),
		);
	}
	const unverified = outcomes.filter((outcome) => outcome.subjectVerification === "mismatch");
	if (unverified.length > 0) {
		process.stderr.write(
			`clio-coder eval skill: WARNING subject_changed: the skill tree at ${resolved.baseDir} changed during ${unverified
				.map((outcome) => outcome.scenario.id)
				.join(", ")}; those scenarios' rubric results stand but their baseline comparison is unmeasured\n`,
		);
	}
	const endedAt = new Date().toISOString();

	const artifact = synthesizeArtifact(subject, evalsPath, evalsRaw, startedAt, endedAt, outcomes, options.target);
	let evidenceId: string | null = null;
	let evidenceDirectory: string | null = null;
	const evidenceErrors: string[] = [];
	try {
		await writeEvalArtifact(clioDataDir(), artifact);
		const built = await buildEvalEvidence({
			dataDir: clioDataDir(),
			stateDir: clioStateDir(),
			artifact,
			sidecars: [SKILL_EVAL_SIDECAR],
		});
		evidenceId = built.evidenceId;
		evidenceDirectory = built.directory;
		await writeFile(
			join(built.directory, SKILL_EVAL_SIDECAR),
			`${JSON.stringify(sidecar(subject, artifact.evalId, outcomes, options.allowNetwork, attributionEnabled), null, 2)}\n`,
			"utf8",
		);
	} catch (error) {
		evidenceErrors.push(error instanceof Error ? error.message : String(error));
	}
	for (const message of evidenceErrors) {
		process.stderr.write(`clio-coder eval skill: evidence build failed: ${message}\n`);
	}

	if (options.json) {
		for (const outcome of outcomes) {
			const attributed = new Map(outcome.attribution.bullets.map((item) => [item.index, item]));
			for (const bullet of outcome.bullets) {
				const pair = attributed.get(bullet.index);
				process.stdout.write(
					`${JSON.stringify({
						schema: "experimental",
						kind: "skill-eval-bullet",
						skill: skill.name,
						skillSha256: subject.normalizedHash,
						skillOrigin: subject.origin,
						skillDrift: subject.drift?.verdict ?? null,
						scenario: outcome.scenario.id,
						title: outcome.scenario.title,
						bullet: bullet.index,
						expected: bullet.text,
						verdict: bullet.verdict,
						reason: bullet.reason,
						// Advisory, never a gate: `verdict` above is the rubric result and
						// is unchanged by anything here.
						baselineVerdict: pair?.baseline ?? null,
						attribution: pair?.attribution ?? null,
						scenarioAttribution: outcome.attribution.verdict,
						attributionReason: outcome.attribution.reason,
						network: networkPolicyLabel(options.allowNetwork),
						autonomy: ARM_AUTONOMY,
						baselineSessionId: outcome.baseline?.sessionId ?? null,
						treatmentSessionId: outcome.treatment?.sessionId ?? null,
						judgeSessionId: outcome.judge?.sessionId ?? null,
						baselineJudgeSessionId: outcome.baselineJudge?.sessionId ?? null,
						evalId: artifact.evalId,
						evidenceId,
					})}\n`,
				);
			}
		}
	} else {
		printHumanReport(subject, outcomes, artifact.evalId, evidenceId, evidenceDirectory, options.allowNetwork);
	}
	const anyFailure = outcomes.some((outcome) =>
		outcome.bullets.some((bullet) => bullet.verdict === "fail" || bullet.verdict === "error"),
	);
	const anyUnmeasured = outcomes.some((outcome) => outcome.bullets.some((bullet) => bullet.verdict === "unmeasured"));
	// 1 means the skill failed its rubric. 3 means no rubric verdict stands to
	// regress against, either because a scenario went unmeasured or because the
	// evidence archive write failed; a caller branching on the code must not
	// read either as a regression, and a run that measured nothing is still not
	// a pass.
	if (anyFailure) return 1;
	return anyUnmeasured || evidenceErrors.length > 0 ? 3 : 0;
}

export type NetworkPolicyLabel = "retrieve-disabled" | "allowed";

function networkPolicyLabel(allowNetwork: boolean): NetworkPolicyLabel {
	return allowNetwork ? "allowed" : "retrieve-disabled";
}

/**
 * One line stating everything the harness imposes on its children, before the
 * first arm starts. Autonomy sits beside the network mode because they are the
 * same kind of fact: a reader who has to guess either one cannot tell what a
 * verdict was measured under.
 */
function describeArmPolicy(allowNetwork: boolean): string {
	const network = allowNetwork
		? "network allowed (--allow-network), so arm runs keep the web tools"
		: "retrieval tools disabled in every arm run; bash networking requires OS isolation (pass --allow-network to keep web tools)";
	return `policy: autonomy ${ARM_AUTONOMY} for the baseline and treatment arms in per-run disposable workspaces; ${network}`;
}

/** The same two facts in the past tense, for the tail of the human report. */
function describeArmPolicyOutcome(allowNetwork: boolean): string {
	const network = allowNetwork
		? "network: allowed (--allow-network); arm runs kept the web tools"
		: "retrieval: disabled; bash networking was not constrained";
	return `policy: the baseline and treatment arms ran at autonomy ${ARM_AUTONOMY}; ${network}`;
}

type EvalArm = "baseline" | "treatment" | "judge" | "baseline-judge";

/**
 * A judge arm scores text and is told to call no tools, so granting it
 * unattended write and exec buys nothing. Both judge arms are excluded from
 * `--autonomy full-auto` for that reason.
 */
function isJudgeArm(arm: EvalArm): boolean {
	return arm === "judge" || arm === "baseline-judge";
}

/**
 * The argv for one arm's child `clio-coder run`. Every arm streams the full JSON
 * event sequence because the evaluator scores assistant messages and tool
 * evidence, while terminal mode is intentionally receipt-only. A turn that ends
 * on a terminating tool carries its content in the full event stream rather
 * than text mode. Discovery stays off so only the treatment arm's explicit
 * skill loads.
 *
 * @internal Exported for contract tests.
 */
function armRunArgs(
	arm: EvalArm,
	prompt: string,
	options: { target?: string | undefined; skillBaseDir?: string | undefined } = {},
): string[] {
	const args = ["run", "--json", "--json-events", "full", "--no-skills"];
	if (!isJudgeArm(arm)) args.push("--autonomy", ARM_AUTONOMY);
	if (options.skillBaseDir !== undefined) args.push("--skill", options.skillBaseDir);
	if (options.target !== undefined) args.push("--target", options.target);
	args.push(prompt);
	return args;
}

/**
 * The harness's own permission gate, found in an arm transcript.
 *
 * A headless run denies any call it cannot get an operator's approval for, and
 * the denial reaches the model as a tool error. An arm that collected those is
 * not evidence about the skill in either direction: it never ran the skill's
 * workflow, so its bullets are unmeasured, exactly like a judge that never
 * scored them. Reported as an infra error, never as a verdict.
 *
 * @internal Exported for contract tests.
 */
function permissionWallReason(arm: EvalArm, run: CapturedRun): string | null {
	const haystack = `${run.transcript}\n${run.finalText}`;
	let blocked = 0;
	let at = haystack.indexOf(HEADLESS_PERMISSION_DENIED_MARKER);
	while (at >= 0) {
		blocked += 1;
		at = haystack.indexOf(HEADLESS_PERMISSION_DENIED_MARKER, at + HEADLESS_PERMISSION_DENIED_MARKER.length);
	}
	if (blocked === 0) return null;
	return `${arm} arm transcript carries the headless permission wall ${blocked} time(s) ("${HEADLESS_PERMISSION_DENIED_MARKER}"): this run measured the harness's own autonomy gate, not the skill`;
}

function unmeasuredBullets(scenario: SkillEvalScenario, reason: string): ScoredBullet[] {
	return scenario.expected.map((text, index) => ({ index: index + 1, text, verdict: "unmeasured", reason }));
}

/**
 * The environment each arm's child `clio-coder run` inherits. Absent
 * `--allow-network` the retrieval registration switch is set, which strips the RETRIEVE
 * plane from every registry the child and its descendants build. With the flag
 * the variable is removed rather than left alone, so an ambient setting in the
 * operator's shell cannot make `--allow-network` a claim the run does not keep.
 *
 * @internal Exported for contract tests.
 */
export function evalChildEnv(allowNetwork: boolean, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const childEnv: NodeJS.ProcessEnv = { ...env };
	if (allowNetwork) {
		Reflect.deleteProperty(childEnv, NO_NETWORK_TOOLS_ENV);
		Reflect.deleteProperty(childEnv, "CLIO_CODER_NO_NETWORK_TOOLS");
	} else childEnv[NO_NETWORK_TOOLS_ENV] = "1";
	return childEnv;
}

/**
 * The copy of a named skill this eval will actually execute.
 *
 * Resolution follows activation, not the catalog. A bare name previously
 * resolved straight to the catalog entry, so an operator with the same skill
 * installed in a project or user root evaluated a different artifact from the
 * one their agent would load, and nothing in the run said which. Discovery runs
 * first and its precedence winner is exactly what an activation would select;
 * the catalog answers only for a name no root installed, which is the skill
 * author's case in this repository.
 */
function resolveSkillBaseDir(
	nameOrPath: string,
	cwd: string,
): { baseDir: string | null; origin?: string; error?: string } {
	const asPath = resolve(nameOrPath);
	if (existsSync(join(asPath, "SKILL.md"))) return { baseDir: asPath, origin: "path" };
	const discovered = loadSkills({ cwd }).items.find((skill) => skill.name === nameOrPath);
	if (discovered !== undefined) {
		return { baseDir: discovered.baseDir, origin: `${discovered.source}/${discovered.scope}` };
	}
	const marketplace = discoverMarketplaceSkills({ cwd });
	const entry = marketplace.skills.find((skill) => skill.name === nameOrPath && skill.origin === "catalog");
	if (entry !== undefined) return { baseDir: entry.sourceUrl, origin: "catalog" };
	return {
		baseDir: null,
		error: `skill not found: ${nameOrPath} (expected an installed skill, a catalog skill name, or a directory containing SKILL.md)`,
	};
}

/**
 * A full id like "D2" selects exactly that scenario; a bare number selects
 * every scenario with that number (evals.md files may mix letter prefixes).
 */
function scenarioMatcher(value: string): ((scenario: SkillEvalScenario) => boolean) | null {
	const trimmed = value.trim();
	const full = /^([A-Za-z])(\d+)$/.exec(trimmed);
	if (full !== null) {
		const id = `${(full[1] ?? "").toUpperCase()}${Number.parseInt(full[2] ?? "", 10)}`;
		return (scenario) => scenario.id === id;
	}
	const bare = /^(\d+)$/.exec(trimmed);
	if (bare !== null) {
		const wanted = Number.parseInt(bare[1] ?? "", 10);
		return (scenario) => scenario.number === wanted;
	}
	return null;
}

async function resolveWorkspaceOverride(workspace: string | undefined): Promise<string | null | { error: string }> {
	if (workspace === undefined) return null;
	const resolved = resolve(workspace);
	try {
		const info = await stat(resolved);
		if (!info.isDirectory()) return { error: `--workspace is not a directory: ${resolved}` };
		return resolved;
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		return { error: `--workspace is not readable: ${resolved}: ${detail}` };
	}
}

/**
 * One arm's child process, behind a seam.
 *
 * The default is {@link captureHeadlessRun}, which spawns a real
 * `clio-coder run`. Contract tests substitute a scripted runner so the arm
 * sequencing, the skip gates and the recorded reasons are exercised through the
 * production orchestration rather than by constructing already-correct typed
 * data, and without paying for an inference.
 *
 * @internal
 */
export type SkillEvalArmRunner = (
	args: ReadonlyArray<string>,
	cwd: string,
	timeoutMs: number,
	env: NodeJS.ProcessEnv,
) => Promise<CapturedRun>;

/** @internal Exported for contract tests. */
export interface RunScenarioInput {
	skillName: string;
	skillBaseDir: string;
	scenario: SkillEvalScenario;
	target: string | undefined;
	timeoutMs: number;
	workspaceOverride: string | null;
	trustFixtures: boolean;
	childEnv: NodeJS.ProcessEnv;
	attributionEnabled: boolean;
	/** Tree digest recorded at resolution; the scenario re-checks against it. */
	subjectTreeSha256: string | null;
	/** sha256 of the subject's SKILL.md, compared against the activation receipt. */
	subjectSha256: string;
	/** False when the artifact cannot be snapshotted faithfully; see artifactIsPinnable. */
	pinnable: boolean;
	runner?: SkillEvalArmRunner;
}

/** @internal Exported for contract tests. */
export async function runScenario(input: RunScenarioInput): Promise<ScenarioOutcome> {
	const {
		skillName,
		skillBaseDir,
		scenario,
		target,
		timeoutMs,
		workspaceOverride,
		trustFixtures,
		childEnv,
		attributionEnabled,
		subjectTreeSha256,
		subjectSha256,
		pinnable,
	} = input;
	const runArm = input.runner ?? captureHeadlessRun;
	// Published per-scenario figure: monotonic so a clock correction during a
	// long sweep cannot land in one row's wall time.
	const scenarioStart = performance.now();
	const workspace = await mkdtemp(join(tmpdir(), "clio-coder-skill-eval-seed-"));
	let runWorkspaces: MaterializedSkillEvalWorkspaces | null = null;
	let subjectVerification: SubjectVerification = "not-checked";
	let observedTreeSha256: string | null = null;
	try {
		// A scenario that ended before the comparison could run records why. When
		// attribution is off the operator's own choice is the operative reason,
		// because the baseline judge would have been skipped either way.
		const skipAttribution = (reason: string): ScenarioAttribution =>
			attributionEnabled ? unmeasurableAttribution(reason) : notAttemptedAttribution(ATTRIBUTION_DISABLED_REASON);
		const outcomeBase = () => ({
			workspace,
			subjectVerification,
			observedTreeSha256,
			wallTimeMs: Math.round(performance.now() - scenarioStart),
		});

		if (workspaceOverride !== null) await copyWorkspace(workspaceOverride, workspace);
		const fixtureError = await runFixtureCommands(scenario, workspace, timeoutMs, trustFixtures);
		if (fixtureError !== null) {
			return await completeScenarioOutcome({
				scenario,
				bullets: errorBullets(scenario, fixtureError),
				baseline: null,
				treatment: null,
				judge: null,
				baselineJudge: null,
				attribution: skipAttribution(fixtureError),
				...outcomeBase(),
				infraError: fixtureError,
			});
		}
		runWorkspaces = await materializeSkillEvalWorkspaces(workspace, pinnable ? skillBaseDir : null);
		const baseline = await runArm(
			armRunArgs("baseline", scenario.setup, { target }),
			runWorkspaces.baseline,
			timeoutMs,
			childEnv,
		);
		// The arm runs against a private copy, so an edit to the source tree
		// cannot reach the child mid-run. The copy is still digested either side
		// of the arm, so the claim rests on a measurement rather than on the
		// assumption that nothing touched it.
		const pinned = pinnable ? runWorkspaces.pin : null;
		const armSkillDir = pinned ?? skillBaseDir;
		const before = await skillTreeDigest(armSkillDir);
		const treatment = await runArm(
			armRunArgs("treatment", `/skill ${skillName} ${scenario.setup}`, { target, skillBaseDir: armSkillDir }),
			runWorkspaces.treatment,
			timeoutMs,
			childEnv,
		);
		const after = await skillTreeDigest(armSkillDir);
		observedTreeSha256 = after;
		// Three conditions, in the order they can fail. The artifact must be
		// pinnable, the pin must have held, and the child must have actually
		// activated it. Disk equality alone is satisfied by a run that activated
		// nothing, so it is necessary and not sufficient.
		subjectVerification = !pinnable
			? "not-pinned"
			: verifySubjectTree(subjectTreeSha256, before, after) === "verified"
				? verifyObservedActivation(skillName, subjectSha256, join(armSkillDir, "SKILL.md"), treatment.activations)
				: verifySubjectTree(subjectTreeSha256, before, after);
		const infra = runInfraError("baseline", baseline) ?? runInfraError("treatment", treatment);
		if (infra !== null) {
			return await completeScenarioOutcome({
				scenario,
				bullets: errorBullets(scenario, infra),
				baseline,
				treatment,
				judge: null,
				baselineJudge: null,
				attribution: skipAttribution(infra),
				...outcomeBase(),
				infraError: infra,
			});
		}
		// An arm the harness itself blocked is scored by nobody: spending a judge
		// run on those transcripts would only buy well-reasoned verdicts about
		// the permission wall.
		const wall = permissionWallReason("baseline", baseline) ?? permissionWallReason("treatment", treatment);
		if (wall !== null) {
			return await completeScenarioOutcome({
				scenario,
				bullets: unmeasuredBullets(scenario, wall),
				baseline,
				treatment,
				judge: null,
				baselineJudge: null,
				attribution: skipAttribution(wall),
				...outcomeBase(),
				infraError: wall,
			});
		}
		// The judge also runs with --json: a model that ends the turn through a
		// terminating tool (artifact plan/review/report) prints only that tool's
		// result line in text mode, while the event stream carries the artifact
		// content the verdict may live in.
		const judge = await runArm(
			armRunArgs("judge", judgePrompt(scenario, baseline.transcript, treatment.transcript), { target }),
			runWorkspaces.judge,
			timeoutMs,
			childEnv,
		);
		const judgeInfra = runInfraError("judge", judge);
		if (judgeInfra !== null) {
			return await completeScenarioOutcome({
				scenario,
				bullets: errorBullets(scenario, judgeInfra),
				baseline,
				treatment,
				judge,
				baselineJudge: null,
				attribution: skipAttribution(judgeInfra),
				...outcomeBase(),
				infraError: judgeInfra,
			});
		}
		const bullets = parseJudgeVerdicts(scenario, judge);
		// The rubric result above stands whatever the comparison decides. The
		// comparison, unlike the rubric, is refused when the artifact measured is
		// not demonstrably the artifact the subject names.
		const attributed = await attributeScenario({
			scenario,
			bullets,
			baseline,
			judge,
			target,
			timeoutMs,
			childEnv,
			attributionEnabled,
			subjectVerification,
			workspace: runWorkspaces.baselineJudge,
			runner: runArm,
		});
		return await completeScenarioOutcome({
			scenario,
			bullets,
			baseline,
			treatment,
			judge,
			baselineJudge: attributed.baselineJudge,
			attribution: attributed.attribution,
			...outcomeBase(),
			infraError: null,
		});
	} finally {
		try {
			if (runWorkspaces !== null) await runWorkspaces.cleanup();
		} finally {
			await rm(workspace, { recursive: true, force: true });
		}
	}
}

/** The exact reason recorded when the operator turned the comparison off. */
const ATTRIBUTION_DISABLED_REASON = "disabled by --no-attribution";

/**
 * Compare the tree digests taken either side of the treatment arm against the
 * one the subject was resolved from.
 *
 * All three must agree. `verified` therefore means "the artifact on disk was
 * the subject's artifact before the arm and still was after it", which is a
 * narrower claim than "the child activated the subject", and the sidecar states
 * that distinction rather than letting the word imply more.
 *
 * @internal Exported for contract tests.
 */
export function verifySubjectTree(
	subject: string | null,
	before: string | null,
	after: string | null,
): SubjectVerification {
	if (subject === null || before === null || after === null) return "unreadable";
	return subject === before && before === after ? "verified" : "mismatch";
}

/**
 * Did the treatment child actually activate the artifact the subject names?
 *
 * Disk equality answers a different question. It says the directory looked the
 * same either side of the arm, which is true of a run that activated nothing at
 * all, and true of a run that loaded a revision written and reverted inside the
 * arm. Neither is a measurement of the subject, and reporting `helped` about
 * either would attribute a difference to an artifact that was never read.
 *
 * So the positive evidence is the activation receipt: the child reports the
 * sha256 of the bytes it read, and that has to equal the pinned SKILL.md's.
 * Several activations of the same name are ambiguous and are refused rather
 * than resolved by picking one.
 *
 * @internal Exported for contract tests.
 */
export function verifyObservedActivation(
	skillName: string,
	expectedSha256: string,
	expectedPath: string,
	activations: ReadonlyArray<ObservedActivation>,
): SubjectVerification {
	const matching = activations.filter((entry) => entry.name === skillName);
	if (matching.length === 0) return "not-activated";
	if (matching.length > 1 && new Set(matching.map((entry) => `${entry.hash}|${entry.path}`)).size > 1) {
		return "activation-mismatch";
	}
	const observed = matching[0];
	if (observed === undefined || observed.hash !== expectedSha256) return "activation-mismatch";
	// The hash says which bytes; the path says which copy. Two directories can
	// hold the same SKILL.md and different reference files beside it, and the
	// body's own pointers resolve against the directory it was loaded from, so a
	// matching hash from somewhere else is not the artifact under test.
	return samePath(observed.path, expectedPath) ? "verified" : "activation-mismatch";
}

/** Compare two paths as the filesystem resolves them, falling back to lexical. */
function samePath(left: string, right: string): boolean {
	if (left.length === 0 || right.length === 0) return false;
	try {
		return realpathSync.native(left) === realpathSync.native(right);
	} catch {
		return resolve(left) === resolve(right);
	}
}

/** Why the comparison was refused, named after what was not established. */
const SUBJECT_REFUSAL: Record<Exclude<SubjectVerification, "verified">, string> = {
	mismatch:
		"the measured skill tree changed on disk during this scenario, so its two arms did not run against one artifact",
	unreadable: "the measured skill tree could not be re-read, so the artifact under test is unverified",
	"not-pinned":
		"the skill body carries package references, which resolve against an owning package root outside the skill directory, so the artifact could not be copied faithfully for this run",
	"not-activated":
		"the treatment arm recorded no successful activation of this skill, so nothing establishes that the measured artifact ran",
	"activation-mismatch":
		"the treatment arm activated content whose hash is not the pinned artifact's, so the comparison would name the wrong revision",
	"not-checked": "the artifact identity was never checked for this scenario",
};

interface AttributeScenarioInput {
	scenario: SkillEvalScenario;
	/** Treatment verdicts from the legacy rubric parser, used only as a skip gate. */
	bullets: ReadonlyArray<ScoredBullet>;
	baseline: CapturedRun;
	/** The treatment judge run, re-read under strict rules for the comparison. */
	judge: CapturedRun;
	target: string | undefined;
	timeoutMs: number;
	childEnv: NodeJS.ProcessEnv;
	attributionEnabled: boolean;
	subjectVerification: SubjectVerification;
	workspace: string;
	runner: SkillEvalArmRunner;
}

/**
 * Score the baseline arm and pair it with the treatment, or say why not.
 *
 * The baseline run is already paid for by the time this is reached; only the
 * judge that reads it is new. Five states end the comparison before it produces
 * a verdict, and each is recorded with its own reason rather than collapsed
 * into one: the operator disabled it, the artifact measured was not
 * demonstrably the artifact the subject names, the treatment produced nothing
 * to compare against, the baseline judge failed to run, or the baseline judge
 * hit the harness's own permission wall.
 *
 * The verdicts it pairs come from {@link strictJudgeVerdicts}, not from the
 * rubric parser, so a judge that answered with a missing, null or string `pass`
 * contributes nothing instead of contributing an invented `fail`.
 */
async function attributeScenario(
	input: AttributeScenarioInput,
): Promise<{ attribution: ScenarioAttribution; baselineJudge: CapturedRun | null }> {
	if (!input.attributionEnabled) {
		return { attribution: notAttemptedAttribution(ATTRIBUTION_DISABLED_REASON), baselineJudge: null };
	}
	// Nothing establishes which artifact ran, so nothing can be attributed to
	// one. Each refusal names what was not established rather than collapsing
	// into one verdict.
	if (input.subjectVerification !== "verified") {
		return { attribution: unmeasurableAttribution(SUBJECT_REFUSAL[input.subjectVerification]), baselineJudge: null };
	}
	// The same comparative eligibility the baseline judge gets. A treatment judge
	// that collected the harness's own denial and then answered was scoring under
	// a constraint the other arm did not have. The rubric result it produced
	// stands; only the comparison is refused.
	const treatmentWall = permissionWallReason("judge", input.judge);
	if (treatmentWall !== null) return { attribution: unmeasurableAttribution(treatmentWall), baselineJudge: null };
	// Nothing on the treatment side was scored, so no pair can be formed. Running
	// the baseline judge anyway would spend an inference to learn nothing.
	if (!input.bullets.some((bullet) => bullet.verdict === "pass" || bullet.verdict === "fail")) {
		return {
			attribution: unmeasurableAttribution(
				"the treatment arm produced no scored bullet, so there is nothing to compare a baseline against",
			),
			baselineJudge: null,
		};
	}
	const baselineJudge = await input.runner(
		armRunArgs("baseline-judge", baselineJudgePrompt(input.scenario, input.baseline.transcript), {
			target: input.target,
		}),
		input.workspace,
		input.timeoutMs,
		input.childEnv,
	);
	const infra = runInfraError("baseline-judge", baselineJudge);
	if (infra !== null) {
		// The treatment verdicts stand: this failure is about the comparison, not
		// about the skill, so it never touches `bullets` or the exit code.
		return { attribution: unmeasurableAttribution(infra), baselineJudge };
	}
	// The prompt tells the judge to use no tools, which is an instruction and not
	// enforcement. A judge that tried anyway and collected the harness's denial
	// was scoring under a constraint the treatment judge did not have.
	const wall = permissionWallReason("baseline-judge", baselineJudge);
	if (wall !== null) return { attribution: unmeasurableAttribution(wall), baselineJudge };
	return {
		attribution: attributionFromStrict(
			input.scenario,
			strictJudgeVerdicts(input.scenario, baselineJudge),
			strictJudgeVerdicts(input.scenario, input.judge),
		),
		baselineJudge,
	};
}

export interface MaterializedSkillEvalWorkspaces {
	baseline: string;
	treatment: string;
	judge: string;
	/** The baseline judge gets its own root for the same reason the other arms do. */
	baselineJudge: string;
	/**
	 * Private per-run copy of the artifact the treatment arm loads; null when the
	 * artifact cannot be copied faithfully. Isolated from the source directory,
	 * not read-only to the arm itself.
	 */
	pin: string | null;
	cleanup(): Promise<void>;
}

/**
 * One private root per arm, with the arm's workspace nested inside it.
 *
 * The arms used to be three `mkdtemp` directories sitting side by side in the
 * system temp dir, named `...-baseline-`, `...-treatment-` and `...-judge-`.
 * A full-auto run in one arm could therefore reach the others in a single
 * relative step, and the names said which was which, so a treatment run could
 * read the baseline it is supposed to be measured against. Nesting each
 * workspace one level down under a neutrally-named private root means `..`
 * from a workspace shows only that arm.
 *
 * This raises the cost of crossing arms; it is not containment. Nothing here
 * confines a run to its workspace, because the write boundary is a per-run
 * tool policy and not something the eval harness can impose on a child
 * process it spawns. An arm that walks the system temp dir can still find the
 * others. Treat eval results from a full-auto run as evidence about a
 * cooperative model, not as an isolation guarantee.
 */
async function armWorkspace(created: string[]): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "clio-coder-skill-eval-"));
	created.push(root);
	const workspace = join(root, "workspace");
	await mkdir(workspace, { recursive: true });
	return workspace;
}

/** @internal Exported for contract tests. */
async function materializeSkillEvalWorkspaces(
	seedWorkspace: string,
	pinSource: string | null,
): Promise<MaterializedSkillEvalWorkspaces> {
	const created: string[] = [];
	try {
		const baseline = await armWorkspace(created);
		const treatment = await armWorkspace(created);
		const judge = await armWorkspace(created);
		const baselineJudge = await armWorkspace(created);
		let pin: string | null = null;
		if (pinSource !== null) {
			const root = await mkdtemp(join(tmpdir(), "clio-coder-skill-eval-pin-"));
			created.push(root);
			pin = join(root, "skill");
			await cp(pinSource, pin, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
		}
		// Only the acting arms get the fixture. A judge scores text and is told to
		// call no tools, so seeding its workspace would only give it the artifacts
		// it is supposed to read about.
		await Promise.all([copyWorkspace(seedWorkspace, baseline), copyWorkspace(seedWorkspace, treatment)]);
		return {
			baseline,
			treatment,
			judge,
			baselineJudge,
			pin,
			cleanup: async () => {
				await Promise.all(created.map((path) => rm(path, { recursive: true, force: true })));
			},
		};
	} catch (error) {
		await Promise.all(created.map((path) => rm(path, { recursive: true, force: true })));
		throw error;
	}
}

async function copyWorkspace(source: string, destination: string): Promise<void> {
	await cp(source, destination, {
		recursive: true,
		preserveTimestamps: true,
		verbatimSymlinks: true,
	});
}

async function completeScenarioOutcome(outcome: Omit<ScenarioOutcome, "usage">): Promise<ScenarioOutcome> {
	return {
		...outcome,
		usage: await usageForCapturedRuns([outcome.baseline, outcome.treatment, outcome.judge, outcome.baselineJudge]),
	};
}

async function runFixtureCommands(
	scenario: SkillEvalScenario,
	workspace: string,
	timeoutMs: number,
	trustFixtures: boolean,
): Promise<string | null> {
	const commands = scenario.fixtureCommands?.trim();
	if (commands === undefined || commands.length === 0) return null;
	if (!trustFixtures) {
		return "scenario declares fixture commands, which are real shell from the skill's evals.md; review them and rerun with --trust-fixtures";
	}
	const validationError = validateFixtureCommands(commands);
	if (validationError !== null) return `fixture setup rejected: ${validationError}`;
	const result = await runBashCommand(commands, {
		cwd: workspace,
		timeoutMs: Math.min(timeoutMs, 120_000),
	});
	const output = combineBashOutput(result).trim();
	if (result.timedOut) return `fixture setup timed out${output.length > 0 ? `: ${truncate(output, 300)}` : ""}`;
	if (result.outputCapped) {
		return `fixture setup output exceeded limit${output.length > 0 ? `: ${truncate(output, 300)}` : ""}`;
	}
	if (result.error !== null) {
		return `fixture setup failed${output.length > 0 ? `: ${truncate(output, 300)}` : `: ${result.error.message}`}`;
	}
	return null;
}

/**
 * Best-effort lint over trusted fixture scripts, not a sandbox: fixtures only
 * run behind --trust-fixtures, and these checks exist to catch obvious
 * workspace escapes in otherwise-reviewed scripts (shell is not reliably
 * classifiable by regex).
 */
function validateFixtureCommands(commands: string): string | null {
	const checks: Array<{ pattern: RegExp; reason: string }> = [
		{
			pattern: /(^|[\s;&|(<>='"`])\/(?!dev\/null(?:\s|$))(?=\S)/,
			reason: "absolute paths are not allowed in fixture commands",
		},
		{
			pattern: /(^|[\s;&|()'"`/=])\.\.(?=$|[/\s;&|()'"`])/,
			reason: "parent-directory path segments are not allowed in fixture commands",
		},
		{
			pattern: /(^|[\s;&|()])~(?=$|[/\s;&|()])/,
			reason: "home-directory expansion is not allowed in fixture commands",
		},
		{
			pattern:
				/\$(?:\{(?:HOME|CLIO_CODER_HOME|CLIO_CODER_CONFIG_DIR|CLIO_CODER_DATA_DIR|CLIO_CODER_STATE_DIR|CLIO_CODER_CACHE_DIR)\}|(?:HOME|CLIO_CODER_HOME|CLIO_CODER_CONFIG_DIR|CLIO_CODER_DATA_DIR|CLIO_CODER_STATE_DIR|CLIO_CODER_CACHE_DIR)\b)/,
			reason: "home and Clio directory environment variables are not allowed in fixture commands",
		},
		{
			pattern: /(^|[\s;&|()])(?:cd|pushd|popd)\b/,
			reason: "directory-changing commands are not allowed in fixture commands",
		},
		{
			pattern: /(^|[\s;&|()])(?:sudo|su|ssh|scp|rsync)\b/,
			reason: "privilege-changing or remote commands are not allowed in fixture commands",
		},
	];
	for (const check of checks) {
		if (check.pattern.test(commands)) return check.reason;
	}
	return null;
}

async function usageForCapturedRuns(runs: ReadonlyArray<CapturedRun | null>): Promise<ScenarioUsage> {
	const sessionIds = new Set(
		runs.flatMap((run) => (run?.sessionId !== null && run?.sessionId !== undefined ? [run.sessionId] : [])),
	);
	const usage: ScenarioUsage = {
		tokens: 0,
		costUsd: 0,
		harness: { ...ZERO_EVAL_HARNESS_METRICS },
	};
	if (sessionIds.size === 0) return usage;
	const receiptRoot = join(clioStateDir(), "receipts");
	let files: string[];
	try {
		files = (await readdir(receiptRoot)).filter((name) => name.endsWith(".json"));
	} catch {
		return usage;
	}
	for (const file of files) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(await readFile(join(receiptRoot, file), "utf8"));
		} catch {
			continue;
		}
		if (!isRecord(parsed) || typeof parsed.sessionId !== "string" || !sessionIds.has(parsed.sessionId)) continue;
		usage.tokens += readNumber(parsed.tokenCount);
		usage.costUsd += readNumber(parsed.costUsd);
		usage.harness.receiptCount += 1;
		usage.harness.toolCalls += readNumber(parsed.toolCalls);
		if (isRecord(parsed.safety) && isRecord(parsed.safety.decisions)) {
			usage.harness.safetyBlocks += readNumber(parsed.safety.decisions.blocked);
		}
	}
	return usage;
}

function runInfraError(label: string, run: CapturedRun): string | null {
	if (run.timedOut) return `${label} run timed out`;
	if (run.exitCode !== 0) {
		const detail = run.stderr.trim().split("\n").at(-1) ?? "";
		return `${label} run exited ${run.exitCode}${detail.length > 0 ? `: ${detail}` : ""}`;
	}
	if (run.transcript.trim().length === 0 && run.finalText.trim().length === 0) {
		return `${label} run produced no transcript`;
	}
	return null;
}

function errorBullets(scenario: SkillEvalScenario, reason: string): ScoredBullet[] {
	return scenario.expected.map((text, index) => ({ index: index + 1, text, verdict: "error", reason }));
}

function captureHeadlessRun(
	args: ReadonlyArray<string>,
	cwd: string,
	timeoutMs: number,
	env: NodeJS.ProcessEnv,
): Promise<CapturedRun> {
	const startedMs = performance.now();
	return new Promise((resolvePromise) => {
		let stdout = "";
		let pendingStdout = "";
		let stderr = "";
		let timedOut = false;
		let settled = false;
		const keepLine = (line: string): void => {
			if (line.length === 0) return;
			if (stdout.length < CHILD_OUTPUT_LIMIT) stdout += `${line}\n`;
		};
		const child = spawn(process.execPath, [process.argv[1] ?? "", ...args], {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
			env,
		});
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			pendingStdout += chunk;
			const lines = pendingStdout.split("\n");
			pendingStdout = lines.pop() ?? "";
			for (const line of lines) keepLine(line);
		});
		child.stderr.on("data", (chunk: string) => {
			if (stderr.length < CHILD_OUTPUT_LIMIT) stderr += chunk;
		});
		let killTimer: NodeJS.Timeout | undefined;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGTERM");
			killTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
		}, timeoutMs);
		const finish = (exitCode: number): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (killTimer !== undefined) clearTimeout(killTimer);
			keepLine(pendingStdout);
			pendingStdout = "";
			const parsedRun = parseRunStdout(stdout);
			resolvePromise({
				...parsedRun,
				exitCode,
				timedOut,
				wallTimeMs: Math.round(performance.now() - startedMs),
				stderr,
			});
		};
		child.on("error", (error) => {
			stderr += `\n${error.message}`;
			finish(1);
		});
		child.on("close", (code) => finish(typeof code === "number" ? code : timedOut ? 124 : 1));
	});
}

/**
 * Fold a headless run's stdout into a compact transcript. `--json` runs emit
 * one terminal JSONL event per line (session header, message_end,
 * tool_execution_*, turn_start, turn_end);
 * text-mode runs emit the final assistant text, which passes through as-is.
 */
/**
 * True for the `context` call that delivers a skill's body:
 * `context(scope="skills", name=<skill>)`. Without a name the same scope only
 * lists what is available, which carries no instructions.
 */
function loadsSkillBody(tool: string, args: unknown): boolean {
	if (tool !== "context" || !isRecord(args)) return false;
	return args.scope === "skills" && typeof args.name === "string" && args.name.trim().length > 0;
}

/**
 * The activation contract inside a successful skill load's result details.
 *
 * `runSkillsScope` records `name`, `filePath` and `hash` on every activation,
 * and the agent loop puts the tool result's details on the execution-end event.
 * Anything missing either field is not an activation receipt and is ignored
 * rather than half-read.
 */
function activationFromResult(result: unknown): ObservedActivation | null {
	if (!isRecord(result)) return null;
	const details = isRecord(result.details) ? result.details : null;
	if (details === null) return null;
	const name = readString(details.name);
	const hash = readString(details.hash);
	if (name === null || hash === null) return null;
	return { name, hash, path: readString(details.filePath) ?? readString(details.path) ?? "" };
}

/** @internal Exported for contract tests. */
export function parseRunStdout(stdout: string): {
	sessionId: string | null;
	transcript: string;
	finalText: string;
	activations: ObservedActivation[];
} {
	let sessionId: string | null = null;
	const lines: string[] = [];
	let finalText = "";
	let sawJson = false;
	const activations: ObservedActivation[] = [];
	const streamedText = new Map<number, string>();
	// Tool calls whose result is the skill's own SKILL.md. Correlated by
	// toolCallId, which both the start and end events carry.
	const skillBodyCallIds = new Set<string>();
	for (const line of stdout.split("\n")) {
		if (line.trim().length === 0) continue;
		let event: unknown;
		try {
			event = JSON.parse(line);
		} catch {
			continue;
		}
		if (!isRecord(event)) continue;
		sawJson = true;
		if (event.type === "session" && typeof event.id === "string") {
			sessionId = event.id;
			continue;
		}
		if (event.type === "text_delta" && typeof event.delta === "string") {
			const contentIndex = typeof event.contentIndex === "number" ? event.contentIndex : 0;
			streamedText.set(contentIndex, `${streamedText.get(contentIndex) ?? ""}${event.delta}`);
			continue;
		}
		if (event.type === "tool_execution_start") {
			const recordedTool = readString(event.toolName) ?? readString(event.tool) ?? "tool";
			const recordedArgs = event.args ?? event.arguments ?? event.input;
			const callId = readString(event.toolCallId);
			// A gateway call is judged as the capability it reached: an artifact
			// written through the gateway is still the terminal answer.
			const effective = effectiveToolCall(recordedTool, recordedArgs);
			const tool = effective.toolName;
			const args = effective.viaGateway ? effective.args : recordedArgs;
			if (callId !== null && loadsSkillBody(tool, args)) skillBodyCallIds.add(callId);
			lines.push(`TOOL ${tool} args=${preview(args)}`);
			// Terminating tools end the turn with no assistant text; their content
			// IS the answer, so keep it whole (the judge verdict may live here).
			if (tool === "artifact" && isRecord(args) && typeof args.content === "string") {
				lines.push(`TERMINAL ${tool} content:\n${args.content}`);
			}
			continue;
		}
		if (event.type === "tool_execution_end") {
			const tool = readString(event.toolName) ?? readString(event.tool) ?? "tool";
			const status = event.isError === true ? "error" : "ok";
			const callId = readString(event.toolCallId);
			// A successful skill load carries the activation contract in its result
			// details: the name, the file and the sha256 of the bytes the child
			// actually read. That is the only evidence in this stream about which
			// artifact ran, and it is collected here and kept out of the transcript
			// so the judge still never sees the body or its identity.
			if (event.isError !== true && callId !== null && skillBodyCallIds.has(callId)) {
				const activation = activationFromResult(event.result);
				if (activation !== null) activations.push(activation);
			}
			// The skill body is the instructions, not the behavior. Left in the
			// transcript it is the easiest thing in the run for a judge to quote,
			// and a 30B judge scored bullets as passing from SKILL.md prose that
			// the model had only read, never acted on. The load still shows, so
			// "did it load the skill" stays checkable.
			if (callId !== null && skillBodyCallIds.has(callId)) {
				lines.push(`RESULT ${tool} ${status}: <skill body withheld from the judge>`);
				continue;
			}
			lines.push(`RESULT ${tool} ${status}: ${preview(event.result)}`);
			continue;
		}
		if (event.type === "message_end" && isRecord(event.message) && event.message.role === "assistant") {
			const content = Array.isArray(event.message.content) ? event.message.content : [];
			const completedText = content
				.filter((item): item is { type: "text"; text: string } => {
					return isRecord(item) && item.type === "text" && typeof item.text === "string";
				})
				.map((item) => item.text)
				.join("")
				.trim();
			const streamed = [...streamedText.entries()]
				.sort(([left], [right]) => left - right)
				.map(([, text]) => text)
				.join("")
				.trim();
			streamedText.clear();
			const text = completedText.length > 0 ? completedText : streamed;
			if (text.length > 0) {
				lines.push(`ASSISTANT: ${text}`);
				finalText = text;
			}
		}
	}
	if (!sawJson) {
		const text = stdout.trim();
		return { sessionId: null, transcript: text, finalText: text, activations: [] };
	}
	return { sessionId, transcript: elide(lines.join("\n")), finalText, activations };
}

function judgePrompt(scenario: SkillEvalScenario, baselineTranscript: string, treatmentTranscript: string): string {
	const bullets = scenario.expected.map((text, index) => `${index + 1}. ${text}`).join("\n");
	return [
		"You are scoring a skill evaluation. Two transcripts follow: BASELINE ran without the skill, TREATMENT ran with the skill loaded.",
		"Score each EXPECTED bullet strictly against the TREATMENT transcript; the baseline exists only for gap context.",
		"A bullet passes only if the treatment transcript observably satisfies it; anything unverifiable from the transcript fails.",
		'Reply with STRICT JSON only, no prose and no code fences, exactly: {"bullets":[{"index":1,"pass":true,"reason":"<= 25 words"}]}',
		`Include one entry per bullet, indexes 1 through ${scenario.expected.length} in order.`,
		"Do not use any tools. Respond with the JSON verdict directly.",
		"",
		`SCENARIO ${scenario.id} - ${scenario.title}`,
		`SETUP: ${scenario.setup}`,
		"",
		"EXPECTED BULLETS:",
		bullets,
		"",
		"BASELINE TRANSCRIPT:",
		baselineTranscript.length > 0 ? baselineTranscript : "(empty)",
		"",
		"TREATMENT TRANSCRIPT:",
		treatmentTranscript.length > 0 ? treatmentTranscript : "(empty)",
	].join("\n");
}

/**
 * Score the baseline arm alone, against the same bullets.
 *
 * Isolated on purpose. The treatment judge above sees both transcripts and is
 * told to score only the treatment; giving the baseline judge the treatment
 * transcript as well would let a strong treatment run colour the baseline's
 * verdicts, and the comparison those verdicts feed would then be measuring the
 * judge. The bullet contract, the strict-JSON shape and the no-tools rule are
 * identical, so `parseJudgeVerdicts` reads both without branching.
 *
 * The treatment prompt is deliberately left byte-identical to what it was
 * before attribution existed, so treatment verdicts stay comparable with every
 * bundle already on disk.
 */
function baselineJudgePrompt(scenario: SkillEvalScenario, baselineTranscript: string): string {
	const bullets = scenario.expected.map((text, index) => `${index + 1}. ${text}`).join("\n");
	return [
		"You are scoring an agent run. One transcript follows: it ran WITHOUT any skill loaded.",
		"Score each EXPECTED bullet strictly against the TRANSCRIPT.",
		"A bullet passes only if the transcript observably satisfies it; anything unverifiable from the transcript fails.",
		'Reply with STRICT JSON only, no prose and no code fences, exactly: {"bullets":[{"index":1,"pass":true,"reason":"<= 25 words"}]}',
		`Include one entry per bullet, indexes 1 through ${scenario.expected.length} in order.`,
		"Do not use any tools. Respond with the JSON verdict directly.",
		"",
		`SCENARIO ${scenario.id} - ${scenario.title}`,
		`SETUP: ${scenario.setup}`,
		"",
		"EXPECTED BULLETS:",
		bullets,
		"",
		"TRANSCRIPT:",
		baselineTranscript.length > 0 ? baselineTranscript : "(empty)",
	].join("\n");
}

/**
 * Why a judge response carried no verdict, named after the thing that failed.
 * A response that opened a bullets object and never closed it is the observed
 * truncation on small local models; a response with no bullets key at all
 * never started one. Neither is evidence about the skill.
 */
function judgeVerdictAbsenceReason(judge: CapturedRun): string {
	const sawBulletsKey = `${judge.finalText}\n${judge.transcript}`.includes('"bullets"');
	return sawBulletsKey
		? "judge response truncated mid-verdict (no complete bullets object): bullet not scored"
		: "judge response carried no parseable verdict object: bullet not scored";
}

/** Exported for contracts tests. */
function parseJudgeVerdicts(scenario: SkillEvalScenario, judge: CapturedRun): ScoredBullet[] {
	const parsed = extractBulletsObject(judge.finalText) ?? extractBulletsObject(judge.transcript);
	// No verdict object anywhere in the judge run. The scenario was not scored,
	// which is a fact about the judge, so every bullet stays unmeasured rather
	// than collecting a verdict nothing produced.
	if (parsed === null) {
		const reason = judgeVerdictAbsenceReason(judge);
		return scenario.expected.map((text, i) => ({ index: i + 1, text, verdict: "unmeasured" as const, reason }));
	}
	const entries = new Map<number, { pass: boolean; reason: string }>();
	if (Array.isArray(parsed.bullets)) {
		for (const item of parsed.bullets) {
			if (!isRecord(item)) continue;
			const index = typeof item.index === "number" ? item.index : Number.parseInt(String(item.index), 10);
			if (!Number.isInteger(index)) continue;
			entries.set(index, {
				pass: item.pass === true,
				reason: readString(item.reason) ?? "",
			});
		}
	}
	return scenario.expected.map((text, i) => {
		const index = i + 1;
		const entry = entries.get(index);
		if (entry === undefined) {
			// The judge scored other bullets and skipped this one, so this bullet
			// has no verdict either. Same state, narrower cause.
			return {
				index,
				text,
				verdict: "unmeasured" as const,
				reason: "judge output omitted this bullet: bullet not scored",
			};
		}
		return { index, text, verdict: entry.pass ? ("pass" as const) : ("fail" as const), reason: entry.reason };
	});
}

/**
 * Verdicts strict enough to compare two arms against each other.
 *
 * {@link parseJudgeVerdicts} above is the legacy rubric gate and its coercions
 * are load-bearing for `pass` / `exitCode` / `failureClass`, so it is left
 * exactly as it is. It is, however, forgiving in ways that are fine for a
 * one-armed verdict and wrong for a comparison: `pass: item.pass === true`
 * turns a missing, null or string field into a genuine `fail`, and
 * `Number.parseInt(String(item.index))` reads `"1oops"` as bullet 1. Pairing a
 * real treatment `pass` against an invented baseline `fail` reports `helped`
 * about a measurement the judge never made.
 *
 * So comparison reads the raw judge output again under stricter rules, and
 * anything that does not clear them stays out of the comparison rather than
 * entering it as a verdict. Rejecting evidence here cannot change the rubric
 * result: the two parsers have separate callers on purpose.
 *
 * @internal Exported for contract tests.
 */
export interface StrictJudgeVerdicts {
	/** Bullet index to its unambiguous boolean verdict. */
	verdicts: Map<number, boolean>;
	/** Bullet index to why its evidence was refused. */
	rejected: Map<number, string>;
	/** Set when the run produced no parseable verdict object at all. */
	absent: string | null;
}

/** @internal Exported for contract tests. */
export function strictJudgeVerdicts(scenario: SkillEvalScenario, judge: CapturedRun): StrictJudgeVerdicts {
	const verdicts = new Map<number, boolean>();
	const rejected = new Map<number, string>();
	const parsed = extractBulletsObject(judge.finalText) ?? extractBulletsObject(judge.transcript);
	if (parsed === null) return { verdicts, rejected, absent: judgeVerdictAbsenceReason(judge) };
	if (!Array.isArray(parsed.bullets)) {
		return { verdicts, rejected, absent: "judge verdict object carried no bullets array" };
	}
	const count = scenario.expected.length;
	const seen = new Map<number, boolean>();
	for (const item of parsed.bullets) {
		if (!isRecord(item)) continue;
		// A numeric index and nothing else. A string that happens to start with
		// digits is not an index the judge chose; it is a parse accident.
		const index = item.index;
		if (typeof index !== "number" || !Number.isInteger(index) || index < 1 || index > count) {
			continue;
		}
		// A rejection for an index is final and order-independent. An entry that
		// arrives after a valid one still poisons it: the judge emitted two
		// answers for one bullet and only one of them is usable, so which one it
		// "meant" is a guess, and a guess is not comparison evidence.
		if (typeof item.pass !== "boolean") {
			rejected.set(index, `judge gave no boolean pass for bullet ${index}: comparison evidence refused`);
			verdicts.delete(index);
			continue;
		}
		if (rejected.has(index)) {
			verdicts.delete(index);
			continue;
		}
		const previous = seen.get(index);
		if (previous !== undefined && previous !== item.pass) {
			// Two contradictory verdicts for one bullet. Taking either would pick a
			// winner the judge never picked.
			rejected.set(index, `judge gave contradictory verdicts for bullet ${index}: comparison evidence refused`);
			verdicts.delete(index);
			continue;
		}
		seen.set(index, item.pass);
		verdicts.set(index, item.pass);
	}
	for (let index = 1; index <= count; index += 1) {
		if (!verdicts.has(index) && !rejected.has(index)) {
			rejected.set(index, `judge omitted bullet ${index}: comparison evidence absent`);
		}
	}
	return { verdicts, rejected, absent: null };
}

/**
 * Find the JSON object carrying the judge's `bullets` array anywhere in the
 * text: models wrap verdicts in prose, code fences, or terminating tool
 * content, so this walks candidate `{` openers around the first "bullets" key
 * and balance-scans to the matching close brace.
 */
function extractBulletsObject(text: string): Record<string, unknown> | null {
	const stripped = text.replace(/```(?:json)?/g, "");
	const bulletsAt = stripped.indexOf('"bullets"');
	if (bulletsAt < 0) return null;
	let start = stripped.lastIndexOf("{", bulletsAt);
	while (start >= 0) {
		const candidate = balancedJsonSlice(stripped, start);
		if (candidate !== null) {
			try {
				const parsed = JSON.parse(candidate) as unknown;
				if (isRecord(parsed) && Array.isArray(parsed.bullets)) return parsed;
			} catch {
				// Try the next opener out.
			}
		}
		// lastIndexOf clamps a negative fromIndex to 0, so stepping from 0 would
		// loop forever on a leading brace.
		if (start === 0) break;
		start = stripped.lastIndexOf("{", start - 1);
	}
	return null;
}

/** Slice a balanced {...} region starting at `start`, string-aware. */
function balancedJsonSlice(text: string, start: number): string | null {
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = start; i < text.length; i += 1) {
		const ch = text[i];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (ch === "\\") {
			if (inString) escaped = true;
			continue;
		}
		if (ch === '"') {
			inString = !inString;
			continue;
		}
		if (inString) continue;
		if (ch === "{") depth += 1;
		else if (ch === "}") {
			depth -= 1;
			if (depth === 0) return text.slice(start, i + 1);
		}
	}
	return null;
}

function synthesizeArtifact(
	subject: SkillEvalSubject,
	evalsPath: string,
	evalsRaw: string,
	startedAt: string,
	endedAt: string,
	outcomes: ReadonlyArray<ScenarioOutcome>,
	target: string | undefined,
): EvalRunArtifact {
	const skillName = subject.name;
	const contentHash = createHash("sha256").update(evalsRaw, "utf8").digest("hex");
	const stamp = startedAt.replace(/[-:.]/g, "");
	// Random suffix for the same reason createEvalId carries one: the stamp plus
	// content hash collides between two workers on the same file in one millisecond,
	// and the id is the artifact filename.
	const evalId = `skill-${skillName}-${stamp}-${contentHash.slice(0, 8)}-${randomBytes(6).toString("hex")}`;
	const results: EvalRunRecord[] = outcomes.map((outcome) => {
		const failed = outcome.bullets.some((bullet) => bullet.verdict === "fail" || bullet.verdict === "error");
		const unmeasured = outcome.bullets.some((bullet) => bullet.verdict === "unmeasured");
		const pass = outcome.bullets.length > 0 && !failed && !unmeasured;
		const record: EvalRunRecord = {
			taskId: outcome.scenario.id,
			runId: `${evalId}-${outcome.scenario.id}`,
			repeatIndex: 0,
			cwd: outcome.workspace,
			prompt: outcome.scenario.setup,
			tags: [
				"skill-eval",
				`skill:${skillName}`,
				// The artifact identity, on every record. Two bundles for one skill
				// name are only comparable when both say which content they ran.
				`skill-sha:${subject.normalizedHash.slice(0, 12)}`,
				`skill-origin:${subject.origin}`,
				...(subject.drift !== null ? [`skill-drift:${subject.drift.verdict}`] : []),
				// Advisory. `pass` and `exitCode` below keep their treatment-only
				// meaning; this tag is read by nothing that gates.
				`attribution:${outcome.attribution.verdict}`,
				...(unmeasured ? ["scenario:unmeasured"] : []),
				...outcome.bullets.map((bullet) => `bullet-${bullet.index}:${bullet.verdict}`),
			],
			pass,
			// 3, not 1, when the scenario carries an unscored bullet and no failed
			// one: a reader who sees exitCode 1 with failureClass verifier_failed
			// reads "this skill failed its rubric", and an unscored bullet is the
			// judge's silence, not the skill's answer.
			exitCode: pass ? 0 : failed ? 1 : 3,
			tokens: outcome.usage.tokens,
			costUsd: outcome.usage.costUsd,
			wallTimeMs: outcome.wallTimeMs,
			harness: outcome.usage.harness,
			commands: [],
		};
		if (failed) record.failureClass = "verifier_failed";
		return record;
	});
	return {
		version: 1,
		evalId,
		taskFile: evalsPath,
		taskFileHash: contentHash,
		clioCoder: evalClioProvenance(),
		environment: evalEnvironmentProvenance(),
		target: target ?? null,
		model: null,
		thinking: null,
		paths: { taskFile: evalsPath, receipts: [], sessionLedgers: [] },
		repeat: 1,
		startedAt,
		endedAt,
		summary: summarizeEvalResults(results),
		results,
	};
}

/** @internal Exported for contract tests. */
export function sidecar(
	subject: SkillEvalSubject,
	evalId: string,
	outcomes: ReadonlyArray<ScenarioOutcome>,
	allowNetwork: boolean,
	attributionEnabled: boolean,
): unknown {
	return {
		version: 2,
		schema: "experimental",
		kind: "skill-eval",
		skill: subject.name,
		// What this run measured, by identity rather than by name. `version` moved
		// to 2 for this block; readers of version 1 keep working, they just never
		// learn which copy produced their numbers.
		subject,
		evalId,
		network: networkPolicyLabel(allowNetwork),
		autonomy: ARM_AUTONOMY,
		attributionEnabled,
		attributionSummary: attributionSummary(outcomes),
		deltas: [
			"bullet verdicts are judge-scored from run transcripts, not command exit codes; the evals-domain artifact carries scenario-level records with empty command lists",
			"a bullet the judge never scored is recorded unmeasured, not failed: its scenario record is pass:false with exitCode 3 and no failureClass",
			"an arm whose transcript carries the headless permission wall is recorded unmeasured with an infraError: the harness's own gate is not a verdict about the skill",
			"tokens and cost are rolled up from headless main-agent receipts when those receipts are present",
			"attribution is advisory and gates nothing: pass, exitCode and failureClass keep their treatment-only meaning",
			"attribution unmeasured means the comparison was impossible; not-attempted means it was never run. Neither is no-change",
			"the baseline judge scores the baseline transcript alone; the treatment judge prompt is unchanged from version 1 bundles",
			"comparison reads both judges' raw output under strict rules (boolean pass, integer in-range index, no contradictory duplicate); refused evidence stays unmeasured and never becomes a verdict",
			"the rubric bullets above keep the legacy parser's forgiving coercions: tightening comparison eligibility does not move the pass/exitCode gate",
			"the treatment arm runs against a private per-run copy of the skill directory, so an edit to the source during the arm cannot reach the child; subject.pinnable is false when the body carries package references, which resolve above the skill directory and cannot be snapshotted faithfully",
			"that copy is an isolated snapshot, not an immutable pin: it lives in a writable temp directory and the arm runs at full-auto, so a model that edited the copy, read it and restored it would not be detected. These are results about a cooperative model, the same caveat the arm workspaces already carry",
			"subjectVerification is verified only when the snapshot held (tree digest equal before and after the arm) AND the treatment arm reported a successful activation whose sha256 equals subject.sha256 and whose file is the snapshot's own SKILL.md by canonical path. not-activated, activation-mismatch, not-pinned, mismatch and unreadable each name what was not established",
			"a scenario whose subjectVerification is not verified keeps its rubric result and records its comparison unmeasured",
			"treeSha256 covers regular files and in-tree symlink targets; a symlink leaving the directory makes the tree unverifiable rather than partially hashed",
			"both judges are checked for the headless permission wall before their verdicts are eligible for comparison; the legacy rubric result is unaffected either way",
			"subject.drift records whether the measured content still matches its recorded hash; a mismatch never blocks the run",
			"subject hashes cover SKILL.md (sha256, normalizedHash) and the whole skill directory (treeSha256); neither covers resources the skill reads from outside its own directory",
			"this sidecar is additive and is registered in overview.json files[]",
		],
		scenarios: outcomes.map((outcome) => ({
			id: outcome.scenario.id,
			title: outcome.scenario.title,
			setup: outcome.scenario.setup,
			fixtureCommands: outcome.scenario.fixtureCommands ?? null,
			infraError: outcome.infraError,
			usage: outcome.usage,
			bullets: outcome.bullets,
			subjectVerification: outcome.subjectVerification,
			observedTreeSha256: outcome.observedTreeSha256,
			attribution: outcome.attribution,
			baseline: sidecarRun(outcome.baseline),
			treatment: sidecarRun(outcome.treatment),
			judge: sidecarRun(outcome.judge),
			baselineJudge: sidecarRun(outcome.baselineJudge),
		})),
	};
}

/** Scenario counts per attribution verdict. A rollup, never collapsed to one score. */
function attributionSummary(outcomes: ReadonlyArray<ScenarioOutcome>): Record<ScenarioAttributionVerdict, number> {
	const summary: Record<ScenarioAttributionVerdict, number> = {
		helped: 0,
		regressed: 0,
		mixed: 0,
		"no-change": 0,
		unmeasured: 0,
		"not-attempted": 0,
	};
	for (const outcome of outcomes) summary[outcome.attribution.verdict] += 1;
	return summary;
}

function sidecarRun(run: CapturedRun | null): unknown {
	if (run === null) return null;
	return {
		sessionId: run.sessionId,
		exitCode: run.exitCode,
		timedOut: run.timedOut,
		wallTimeMs: run.wallTimeMs,
		transcript: run.transcript,
		stderrTail: run.stderr.slice(-500),
	};
}

function printHumanReport(
	subject: SkillEvalSubject,
	outcomes: ReadonlyArray<ScenarioOutcome>,
	evalId: string,
	evidenceId: string | null,
	evidenceDirectory: string | null,
	allowNetwork: boolean,
): void {
	const skillName = subject.name;
	// `vs base` is the same bullet in the arm that ran without the skill. Kept in
	// its own column so a reader never mistakes it for part of the rubric verdict.
	const rows: string[][] = [["scenario", "bullet", "verdict", "vs base", "expected"]];
	for (const outcome of outcomes) {
		const attributed = new Map(outcome.attribution.bullets.map((item) => [item.index, item]));
		for (const bullet of outcome.bullets) {
			rows.push([
				outcome.scenario.id,
				String(bullet.index),
				bullet.verdict,
				attributed.get(bullet.index)?.attribution ?? "-",
				truncate(bullet.text, 64),
			]);
		}
	}
	process.stdout.write(formatColumns(rows));
	const total = outcomes.reduce((sum, outcome) => sum + outcome.bullets.length, 0);
	const passed = outcomes.reduce(
		(sum, outcome) => sum + outcome.bullets.filter((bullet) => bullet.verdict === "pass").length,
		0,
	);
	const unmeasured = outcomes.reduce(
		(sum, outcome) => sum + outcome.bullets.filter((bullet) => bullet.verdict === "unmeasured").length,
		0,
	);
	// The denominator counts bullets the judge never scored, so it says how many
	// passed out of how many were asked, not out of how many were answered. The
	// unscored count is stated beside it rather than folded into the failures.
	const unmeasuredNote = unmeasured > 0 ? `, ${unmeasured} unmeasured` : "";
	process.stdout.write(
		`\n${skillName}: ${passed}/${total} bullets passed${unmeasuredNote} (judge-scored, experimental)\n`,
	);
	if (unmeasured > 0) {
		process.stdout.write(
			unmeasured === total
				? "no bullet was scored, so this run is not evidence about the skill either way\n"
				: `${unmeasured} of ${total} bullets were never scored; unmeasured is not a failed bullet\n`,
		);
	}
	for (const outcome of outcomes) {
		if (outcome.infraError !== null) {
			process.stdout.write(`${outcome.scenario.id}: infra error: ${outcome.infraError}\n`);
			continue;
		}
		for (const bullet of outcome.bullets.filter((item) => item.verdict !== "pass")) {
			process.stdout.write(
				`${outcome.scenario.id} bullet ${bullet.index} ${bullet.verdict}${bullet.reason.length > 0 ? `: ${bullet.reason}` : ""}\n`,
			);
		}
	}
	printAttributionReport(outcomes);
	process.stdout.write(`${describeArmPolicyOutcome(allowNetwork)}\n`);
	process.stdout.write(
		`subject: ${skillName} from ${subject.origin} at ${subject.baseDir} (sha256 ${subject.normalizedHash.slice(0, 12)}…)\n`,
	);
	if (subject.drift !== null) {
		process.stdout.write(
			subject.drift.verdict === "mismatch"
				? `subject drift: MISMATCH against the ${subject.drift.authority} (expected ${subject.drift.expected.slice(0, 12)}…); this run measured the copy on disk\n`
				: `subject drift: matches the ${subject.drift.authority}\n`,
		);
	}
	const unverified = outcomes.filter((outcome) => outcome.subjectVerification !== "verified");
	if (unverified.length > 0) {
		process.stdout.write(
			`subject verification: ${unverified.map((o) => `${o.scenario.id}=${o.subjectVerification}`).join(", ")}; ` +
				"those scenarios kept their rubric result and recorded no baseline comparison\n",
		);
	}
	process.stdout.write(`eval artifact: ${evalId}\n`);
	if (evidenceId !== null && evidenceDirectory !== null) {
		process.stdout.write(`evidence: ${evidenceId} at ${evidenceDirectory} (per-bullet detail in skill-eval.json)\n`);
	}
}

/**
 * The paired comparison, stated as scenario counts and never as one score.
 *
 * Deliberately separated from the rubric block above it. A reader who takes
 * "3/4 bullets passed" and "1 scenario regressed" as the same measurement will
 * draw the wrong conclusion from both: the first says whether the skill met its
 * rubric, the second says whether it changed anything relative to no skill at
 * all. Nothing here influences the exit code.
 */
function printAttributionReport(outcomes: ReadonlyArray<ScenarioOutcome>): void {
	if (outcomes.length === 0) return;
	const summary = attributionSummary(outcomes);
	const compared = summary.helped + summary.regressed + summary.mixed + summary["no-change"];
	if (compared === 0) {
		const reason = outcomes.find((outcome) => outcome.attribution.reason !== null)?.attribution.reason ?? null;
		process.stdout.write(
			`attribution: no scenario was compared against its baseline${reason !== null ? ` (${reason})` : ""}\n`,
		);
		return;
	}
	const parts = [
		`${summary.helped} helped`,
		`${summary.regressed} regressed`,
		`${summary.mixed} mixed`,
		`${summary["no-change"]} no-change`,
	];
	if (summary.unmeasured > 0) parts.push(`${summary.unmeasured} unmeasured`);
	if (summary["not-attempted"] > 0) parts.push(`${summary["not-attempted"]} not-attempted`);
	process.stdout.write(
		`attribution (advisory, vs the no-skill baseline; gates nothing): ${parts.join(", ")} of ${outcomes.length} scenario${outcomes.length === 1 ? "" : "s"}\n`,
	);
	for (const outcome of outcomes) {
		if (outcome.attribution.verdict === "regressed" || outcome.attribution.verdict === "mixed") {
			const regressed = outcome.attribution.bullets
				.filter((bullet) => bullet.attribution === "regressed")
				.map((bullet) => String(bullet.index));
			process.stdout.write(
				`${outcome.scenario.id}: ${outcome.attribution.verdict}; the baseline passed bullet${regressed.length === 1 ? "" : "s"} ${regressed.join(", ")} and the treatment did not\n`,
			);
		} else if (outcome.attribution.reason !== null) {
			process.stdout.write(
				`${outcome.scenario.id}: attribution ${outcome.attribution.verdict}: ${outcome.attribution.reason}\n`,
			);
		}
	}
}

function preview(value: unknown): string {
	if (value === undefined) return "";
	const text = typeof value === "string" ? value : safeStringify(value);
	return truncate(text.replace(/\s+/g, " ").trim(), PREVIEW_MAX_CHARS);
}

function safeStringify(value: unknown): string {
	try {
		return JSON.stringify(value) ?? "";
	} catch {
		return String(value);
	}
}

function elide(text: string): string {
	if (text.length <= TRANSCRIPT_HEAD_CHARS + TRANSCRIPT_TAIL_CHARS) return text;
	return `${text.slice(0, TRANSCRIPT_HEAD_CHARS)}\n[... transcript elided ...]\n${text.slice(-TRANSCRIPT_TAIL_CHARS)}`;
}

function truncate(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, Math.max(0, maxChars - 3))}...`;
}

function readString(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

function readNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The experimental evals.md lane stays under eval, alongside package suite evals. */
export async function runSkillEvalCli(args: ReadonlyArray<string>): Promise<number> {
	const options: SkillsEvalOptions = { json: false, trustFixtures: false, allowNetwork: false, noAttribution: false };
	let source: string | undefined;
	try {
		for (let i = 0; i < args.length; i++) {
			const arg = args[i];
			if (!arg) continue;
			if (arg === "--json") options.json = true;
			else if (arg === "--trust-fixtures") options.trustFixtures = true;
			else if (arg === "--allow-network") options.allowNetwork = true;
			else if (arg === "--no-attribution") options.noAttribution = true;
			else if (["--scenario", "--target", "--workspace", "--timeout"].includes(arg)) {
				const value = args[++i];
				if (!value || value.startsWith("-")) throw new Error(`${arg} requires a value`);
				if (arg === "--timeout") {
					const seconds = Number(value);
					if (!Number.isInteger(seconds) || seconds <= 0) throw new Error("--timeout requires a positive integer");
					options.timeoutSeconds = seconds;
				} else if (arg === "--scenario") options.scenario = value;
				else if (arg === "--target") options.target = value;
				else options.workspace = value;
			} else if (arg === "--help" || arg === "-h") {
				process.stdout.write(
					"clio-coder eval skill <name|path> [--scenario <id>] [--target <id>] [--workspace <path>] [--timeout <seconds>] [--trust-fixtures] [--allow-network] [--no-attribution] [--json]\n" +
						"  --no-attribution  skip the baseline judge and the paired comparison; saves one judge run per scenario\n",
				);
				return 0;
			} else if (arg.startsWith("-") || source) throw new Error(`unexpected skill eval argument: ${arg}`);
			else source = arg;
		}
		if (!source) throw new Error("eval skill requires a skill name or path");
		return await runSkillsEvalCommand(source, options);
	} catch (error) {
		printError(error instanceof Error ? error.message : String(error));
		return 2;
	}
}

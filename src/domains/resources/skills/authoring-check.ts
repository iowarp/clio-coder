import { existsSync } from "node:fs";
import path from "node:path";
import type { ResourceDiagnostic } from "../collision.js";
import type { Skill } from "./loader.js";

/**
 * Checks an author wants from `library validate` and the loader must not run.
 * Loading a skill happens on every `context(scope="skills")` call, so it reads no
 * sibling files and takes no opinion on a body's length or age. These run only
 * when someone asks whether a skill is ready to ship.
 */

/** skill-authoring's sprawl rule, as the number the catalog gate enforces. */
export const SKILL_BODY_LINE_BUDGET = 120;
/** How long a recorded `verified-at` stands before a skill's facts are presumed stale. */
export const SKILL_VERIFICATION_MAX_AGE_DAYS = 180;

const DAY_MS = 24 * 60 * 60 * 1000;
const MARKDOWN_LINK = /\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/gu;
/** The spec's companion directories, spelled as a concrete file a step could open or run. */
const COMPANION_PATH = /(?<![\w./${}-])(?:\.\/)?((?:references|scripts|assets)\/[\w./-]*\w\.\w+)/gu;
const FENCED_CODE = /^(`{3,}|~{3,}).*?^\1[ \t]*$/gmsu;
const INLINE_CODE = /`[^`\n]*`/gu;
const ROUTE_CLAUSE = /;\s*use\s+([^.;]+)/giu;
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)+$/u;
/** Product names a routing clause may mention that are not skills. */
const NOT_SKILLS: ReadonlySet<string> = new Set(["clio-coder", "clio-kit"]);

function linkTarget(raw: string): string | null {
	if (/^[a-z][a-z0-9+.-]*:/iu.test(raw) || raw.startsWith("#") || raw.startsWith("/") || raw.includes("${")) return null;
	const target = raw.split(/[?#]/u)[0] ?? "";
	return target.length > 0 ? target : null;
}

function missingLinks(body: string, baseDir: string): string[] {
	// A link inside code is an example of one, not a pointer the agent follows.
	const prose = body.replace(FENCED_CODE, "").replace(INLINE_CODE, "");
	const missing = new Set<string>();
	for (const match of prose.matchAll(MARKDOWN_LINK)) {
		const target = linkTarget(match[1] ?? "");
		if (target !== null && !existsSync(path.join(baseDir, target))) missing.add(target);
	}
	return [...missing];
}

function missingCompanions(body: string, baseDir: string): string[] {
	const missing = new Set<string>();
	for (const match of body.matchAll(COMPANION_PATH)) {
		const target = match[1] ?? "";
		if (!existsSync(path.join(baseDir, target))) missing.add(target);
	}
	return [...missing];
}

function routedSkills(description: string): string[] {
	const names = new Set<string>();
	for (const match of description.matchAll(ROUTE_CLAUSE)) {
		for (const part of (match[1] ?? "").split(/,|\bor\b|\band\b/u)) {
			const name = part.trim();
			if (SKILL_NAME.test(name) && !NOT_SKILLS.has(name)) names.add(name);
		}
	}
	return [...names];
}

export type SkillVerification =
	| { status: "valid"; date: string; ageDays: number; stale: boolean }
	| { status: "invalid"; value: string };

/** The skill's `clio-coder.verified-at`, read against the clock. Absent means it never claimed one. */
export function skillVerification(
	skill: Pick<Skill, "metadata">,
	now: number = Date.now(),
): SkillVerification | undefined {
	const block = skill.metadata.clioCoder;
	if (block === null || typeof block !== "object" || Array.isArray(block)) return undefined;
	const raw = (block as Record<string, unknown>)["verified-at"];
	if (raw === undefined) return undefined;
	const value = typeof raw === "string" ? raw.trim() : String(raw);
	const parsed = /^\d{4}-\d{2}-\d{2}$/u.test(value) ? Date.parse(`${value}T00:00:00Z`) : Number.NaN;
	// Date.parse rolls 2026-02-30 over to March, so the date has to read back as itself.
	if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 10) !== value)
		return { status: "invalid", value };
	const ageDays = Math.floor((now - parsed) / DAY_MS);
	return { status: "valid", date: value, ageDays, stale: ageDays > SKILL_VERIFICATION_MAX_AGE_DAYS };
}

export interface SkillAuthoringOptions {
	/** Skills a routing clause may name: this package's, installed ones and the catalog's. */
	knownSkills: ReadonlySet<string>;
	now?: number;
}

/**
 * A link to a missing file is an error, because the agent is told to follow it.
 * A bare path is only a warning: a skill may be talking about the project's own
 * `scripts/` directory, and only the author can tell which one is meant.
 */
export function skillAuthoringDiagnostics(
	skill: Pick<Skill, "content" | "baseDir" | "description" | "filePath" | "metadata">,
	options: SkillAuthoringOptions,
): ResourceDiagnostic[] {
	const diagnostics: ResourceDiagnostic[] = [];
	const push = (type: "warning" | "error", message: string): void => {
		diagnostics.push({ type, message, path: skill.filePath });
	};
	const links = missingLinks(skill.content, skill.baseDir);
	for (const target of links) push("error", `body links to ${target}, which is not in the skill directory`);
	for (const target of missingCompanions(skill.content, skill.baseDir))
		if (!links.includes(target)) push("warning", `body names ${target}, which is not in the skill directory`);
	for (const name of routedSkills(skill.description))
		if (!options.knownSkills.has(name))
			push("warning", `description routes to skill "${name}", which is not in this package, installed or in the catalog`);
	const lines = skill.content.split(/\r?\n/u).length;
	if (lines > SKILL_BODY_LINE_BUDGET)
		push(
			"warning",
			`body is ${lines} lines; past about ${SKILL_BODY_LINE_BUDGET}, move reference material into references/ behind a conditional pointer or split the skill`,
		);
	const verification = skillVerification(skill, options.now);
	if (verification?.status === "invalid")
		push("warning", `clio-coder.verified-at must be a date like 2026-11-02, found "${verification.value}"`);
	else if (verification?.status === "valid") {
		if (verification.ageDays < 0) push("warning", `clio-coder.verified-at ${verification.date} is in the future`);
		else if (verification.stale)
			push(
				"warning",
				`clio-coder.verified-at ${verification.date} is ${verification.ageDays} days old; recheck the skill's facts against a live source and update the date`,
			);
	}
	return diagnostics;
}

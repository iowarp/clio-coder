/**
 * Fixed machine-readable projection of this installation's installed skills.
 *
 * `skills list --json` already emits a machine-readable listing, and a GUI host
 * reading it gets two things wrong. Without `--all` it sees only the skills the
 * model may load, which is `trusted && !disableModelInvocation`, so a surface
 * rendering trust and invocability off that payload prints "trusted" and
 * "allowed" on every row and structurally cannot print anything else. And the
 * rows it does get are the full loaded records, carrying the SKILL.md body, the
 * file path, the base directory, and two content hashes, so every consumer has
 * to re-derive the same redaction.
 *
 * This command answers both. It loads once, reports every installed skill
 * whether or not the model can reach it, says which ones it can, and carries
 * only fields that are safe by construction. It is a separate subcommand rather
 * than a flag on `skills inspect`, because that one names a skill and a fixed
 * read a host may run must take no identifier at all.
 *
 * Held back deliberately: the skill body, its file path, its base directory,
 * both hashes, the install and registry URLs, and the free-text loader
 * diagnostics. Whether a skill has an upstream to update from crosses; where
 * that upstream is does not.
 *
 * Marketplace discovery is deliberately not here. `library list --json` already
 * folds `discoverMarketplaceSkills` into its catalog, so every installable
 * skill already crosses through that read, and a second one would report the
 * same rows under a different name.
 */

import {
	loadSkills,
	type ResourceDiagnostic,
	type Skill,
	type SkillCatalogInvalidReason,
	skillCatalogValidity,
} from "../domains/resources/index.js";

/** Wire bound on the emitted skill list. */
const MAX_SKILLS_INVENTORY_SKILLS = 64;
/** Wire bound on each skill's declared tool policy. */
const MAX_SKILLS_INVENTORY_TOOLS = 32;

const TOOL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

type SkillAuditState = "pass" | "warn" | "fail" | "unknown" | "not-reported";

interface SkillsInventoryDiagnosticCounts {
	readonly errors: number;
	readonly warnings: number;
	readonly collisions: number;
}

interface SkillsInventorySkill {
	readonly name: string;
	readonly description: string;
	readonly scope: string;
	readonly source: string;
	/** Whether the skill's root is trusted enough for the model to see it at all. */
	readonly trusted: boolean;
	/** Whether the skill's own frontmatter permits model invocation. */
	readonly modelInvocable: boolean;
	/**
	 * The effective answer, which is both of the above.
	 *
	 * Reported rather than left to be inferred because it is the fact an
	 * operator is actually asking about, and because a listing filtered to it
	 * cannot state it.
	 */
	readonly modelVisible: boolean;
	readonly precedence: number;
	readonly diagnostics: SkillsInventoryDiagnosticCounts;
	/** Tools the skill narrows itself to. The harness intersects these with host policy. */
	readonly allowedTools: readonly string[];
	readonly disallowedTools: readonly string[];
	/** True when a dispatched worker installed this, rather than the operator. */
	readonly installedByWorker: boolean;
	/** True when provenance records an upstream, so `skills update` has something to fetch. */
	readonly updatable: boolean;
	readonly audit: SkillAuditState;
	readonly installedAt: string | null;
	readonly updatedAt: string | null;
}

interface SkillsInventorySnapshot {
	readonly version: 1;
	readonly generatedAt: string;
	/** The verdict `skills validate` reaches, from the rule both callers share. */
	readonly valid: boolean;
	readonly invalidReason: SkillCatalogInvalidReason | null;
	/** Every installed skill the loader resolved, before the wire bound. */
	readonly total: number;
	/** How many of those the model may actually load by name. */
	readonly modelVisible: number;
	readonly diagnostics: SkillsInventoryDiagnosticCounts;
	readonly skills: readonly SkillsInventorySkill[];
	readonly skillsTruncated: boolean;
}

const AUDIT_STATES: ReadonlySet<string> = new Set(["pass", "warn", "fail", "unknown"]);

function countDiagnostics(diagnostics: ReadonlyArray<ResourceDiagnostic>): SkillsInventoryDiagnosticCounts {
	let errors = 0;
	let warnings = 0;
	let collisions = 0;
	for (const diag of diagnostics) {
		if (diag.type === "error") errors += 1;
		else if (diag.type === "collision") collisions += 1;
		else warnings += 1;
	}
	return { errors, warnings, collisions };
}

/**
 * Tool names are already-crossing identifiers: the agent catalog carries the
 * same class. They are re-enforced structurally here anyway, because a skill's
 * frontmatter is operator-authored and the loader does not hold it to a shape.
 */
function toolPolicy(value: ReadonlyArray<string> | undefined): string[] {
	if (value === undefined) return [];
	const tools: string[] = [];
	for (const tool of value) {
		if (tools.length >= MAX_SKILLS_INVENTORY_TOOLS) break;
		if (typeof tool !== "string" || tool.length > 64 || !TOOL_PATTERN.test(tool)) continue;
		if (!tools.includes(tool)) tools.push(tool);
	}
	return tools;
}

function timestamp(value: string | undefined): string | null {
	if (value === undefined) return null;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function projectSkill(skill: Skill): SkillsInventorySkill {
	const provenance = skill.provenance;
	const audit = provenance?.audit;
	return {
		name: skill.name,
		description: skill.description,
		scope: skill.scope,
		source: skill.source,
		trusted: skill.trusted,
		modelInvocable: !skill.disableModelInvocation,
		modelVisible: skill.trusted && !skill.disableModelInvocation,
		precedence: skill.precedence,
		diagnostics: countDiagnostics(skill.diagnostics),
		allowedTools: toolPolicy(skill.allowedTools),
		disallowedTools: toolPolicy(skill.disallowedTools),
		installedByWorker: provenance?.installedBy === "worker",
		// The URL itself is a host-side fact; that one exists is what tells the
		// operator whether an update has anywhere to come from.
		updatable: provenance?.installUrl !== undefined || provenance?.registryUrl !== undefined,
		audit: audit !== undefined && AUDIT_STATES.has(audit) ? (audit as SkillAuditState) : "not-reported",
		installedAt: timestamp(provenance?.installedAt),
		updatedAt: timestamp(provenance?.updatedAt),
	};
}

function skillsInventorySnapshot(now: () => number = Date.now, cwd: string = process.cwd()): SkillsInventorySnapshot {
	const list = loadSkills({ cwd });
	const validity = skillCatalogValidity(list);
	const projected = list.items.map(projectSkill);
	const skills = projected.slice(0, MAX_SKILLS_INVENTORY_SKILLS);
	return {
		version: 1,
		generatedAt: new Date(now()).toISOString(),
		valid: validity.ok,
		invalidReason: validity.reason,
		total: projected.length,
		modelVisible: projected.filter((skill) => skill.modelVisible).length,
		diagnostics: countDiagnostics(list.diagnostics),
		skills,
		skillsTruncated: skills.length < projected.length,
	};
}

export function runSkillsInventory(args: ReadonlyArray<string>): number {
	if (args.length !== 1 || args[0] !== "--json") {
		process.stderr.write("clio-coder skills inventory: usage: clio-coder skills inventory --json\n");
		return 2;
	}
	process.stdout.write(`${JSON.stringify(skillsInventorySnapshot(), null, 2)}\n`);
	return 0;
}

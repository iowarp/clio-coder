// Sentences for the library catalog and its reviewed plans. Pure, so the wording is testable without a browser.

import type { Static } from "typebox";
import type { LibraryApplyResult, LibraryInventory, LibraryPlan } from "../../contracts/library.js";
import type { StatusTone } from "../design/status.js";

export type Package = Static<typeof LibraryInventory>["packages"][number];
export type Plan = Static<typeof LibraryPlan>;
export type PlanStep = Plan["steps"][number];
export type Applied = Static<typeof LibraryApplyResult>;
export type Outcome = Applied["outcomes"][number];
export type Operation = Plan["operation"];
export type Scope = "user" | "project";

export const PACKAGE_KINDS = ["skill", "agent", "prompt", "fleet", "plugin"] as const;
const VERB: Record<Operation, string> = {
	install: "Install",
	update: "Update",
	enable: "Enable",
	disable: "Disable",
	remove: "Remove",
};
const DONE: Record<Operation, string> = {
	install: "Installed",
	update: "Updated",
	enable: "Enabled",
	disable: "Disabled",
	remove: "Removed",
};
export const verb = (operation: Operation) => VERB[operation];
export const scopeLibrary = (scope: Scope) => (scope === "user" ? "your user library" : "this project's library");
export const scopeCopy = (scope: Scope) => (scope === "user" ? "User copy" : "Project copy");

export function copyState(state: string): { label: string; tone: StatusTone } {
	switch (state) {
		case "loadable":
			return { label: "Ready", tone: "success" };
		case "disabled":
			return { label: "Disabled", tone: "neutral" };
		case "shadowed":
			return { label: "Shadowed", tone: "neutral" };
		case "invalid":
			return { label: "Invalid", tone: "fail" };
		case "incompatible":
			return { label: "Incompatible", tone: "fail" };
		case "damaged":
			return { label: "Damaged", tone: "fail" };
		default:
			return { label: state, tone: "unverified" };
	}
}

/** Which lifecycle operations make sense for a copy in this state. The plan, not this list, decides what is allowed. */
export function copyOperations(state: string): Operation[] {
	if (state === "disabled") return ["enable", "update", "remove"];
	if (state === "loadable" || state === "shadowed") return ["update", "disable", "remove"];
	return ["update", "remove"];
}
export function missingScopes(pkg: Package): Scope[] {
	return (["user", "project"] as const).filter((scope) => !pkg.copies.some((copy) => copy.scope === scope));
}

/** A query also matches the recipes a bundle provides, so searching for a recipe finds its install target. */
export function matchesPackage(pkg: Package, query: string): boolean {
	const needle = query.trim().toLocaleLowerCase("en-US");
	if (!needle) return true;
	const provided = (pkg.provides ?? []).map((item) => `${String(item.kind)} ${String(item.name)}`);
	return [pkg.ref, pkg.name, pkg.description, ...provided].join(" ").toLocaleLowerCase("en-US").includes(needle);
}

export function originSentence(pkg: Package): string {
	const origin = pkg.origin as { kind?: string; agent?: string };
	switch (origin.kind) {
		case "bundled":
			return "Ships with Clio Coder";
		case "remote":
			return "Pinned GitHub source";
		case "local":
			return "Local source";
		case "imported":
			return `Imported from ${origin.agent ?? "another agent"}`;
		default:
			return pkg.catalogOrigin === "installed" ? "Installed; no catalog row" : "Origin not recorded";
	}
}

export const stepTitle = (step: PlanStep) =>
	`${VERB[step.operation]} ${step.identity.ref} ${step.operation === "install" ? "into" : "in"} ${scopeLibrary(step.identity.scope)}`;

export function effectSentence(step: PlanStep): string {
	const note = step.fallbackNote ? `${step.fallbackNote[0]?.toUpperCase()}${step.fallbackNote.slice(1)}.` : "";
	const after = step.effectiveAfter;
	if (!after) return note;
	const state = after.loadable ? "Clio can load it" : `it is ${copyState(after.state).label.toLowerCase()}`;
	return `${note} Afterwards the ${after.scope} copy is the one in effect, and ${state}.`.trim();
}

/** True when the only thing stopping the plan is requirements the catalog can supply. */
export const needsRequirements = (plan: Plan) =>
	!plan.applicable && plan.steps.some((step) => step.refusal?.startsWith("library_requirement_missing"));

export function diskSentence(outcome: Outcome): string {
	const v = outcome.verification;
	if (!v) return "Nothing was read back from disk.";
	if (v.tree === "present" && v.record === "recorded") return "The files are on disk and the install record matches.";
	if (v.tree === "absent" && v.record === "absent") return "The files and the install record are gone.";
	return `Files on disk: ${v.tree}. Install record: ${v.record}.`;
}

export function recipeSentence(outcome: Outcome): string {
	const resources = outcome.verification?.resources ?? [];
	if (outcome.operation === "remove") return "Its recipes are no longer offered.";
	if (!resources.length) return "This package declares no recipes to admit.";
	const blocked = resources.filter((item) => !item.available);
	if (!blocked.length)
		return `${resources.length === 1 ? "Its recipe is" : `All ${resources.length} recipes are`} admitted: ${resources.map((item) => item.name).join(", ")}.`;
	return `${resources.length - blocked.length} of ${resources.length} recipes admitted. Held back: ${blocked
		.map((item) => `${item.name}${item.reason ? ` (${item.reason})` : ""}`)
		.join(", ")}.`;
}

export function outcomeHeadline(outcome: Outcome): { text: string; tone: StatusTone } {
	const where = `${outcome.identity.ref} in ${scopeLibrary(outcome.identity.scope)}`;
	if (outcome.status === "committed")
		return outcome.error
			? { text: `${DONE[outcome.operation]} ${where}, but verification disagrees`, tone: "warn" }
			: { text: `${DONE[outcome.operation]} ${where}`, tone: "success" };
	if (outcome.status === "failed")
		return { text: `Could not ${VERB[outcome.operation].toLowerCase()} ${where}`, tone: "fail" };
	return { text: `Did not attempt ${where}`, tone: "unverified" };
}

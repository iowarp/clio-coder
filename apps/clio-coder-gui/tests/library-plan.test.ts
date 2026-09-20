import assert from "node:assert/strict";
import { test } from "node:test";
import {
	copyOperations,
	copyState,
	diskSentence,
	effectSentence,
	matchesPackage,
	missingScopes,
	needsRequirements,
	type Outcome,
	outcomeHeadline,
	type Package,
	type Plan,
	type PlanStep,
	recipeSentence,
	stepTitle,
} from "../client/pages/library-plan.js";

const pkg = (over: Partial<Package> = {}): Package => ({
	ref: "plugin:bundle",
	kind: "plugin",
	name: "bundle",
	description: "A bundle of recipes.",
	sourceUrl: "plugins/bundle",
	origin: { kind: "bundled", catalog: "registry.yaml" },
	catalogOrigin: "catalog",
	copies: [],
	...over,
});
const step = (over: Partial<PlanStep> = {}): PlanStep => ({
	operation: "install",
	identity: { ref: "skill:demo", kind: "skill", name: "demo", scope: "user" },
	destination: "/config/plugins/demo",
	dependencies: { requires: [], missing: [], inactive: [] },
	dependents: { newlyBroken: [], preexisting: [] },
	fallbackNote: "this copy becomes the effective copy",
	recovery: "nothing to recover; the destination is empty",
	...over,
});
const outcome = (over: Partial<Outcome> = {}): Outcome => ({
	status: "committed",
	operation: "install",
	identity: { ref: "skill:demo", kind: "skill", name: "demo", scope: "user" },
	diagnostics: [],
	...over,
});

test("a catalog search finds the package that provides a recipe, and scopes are offered only where no copy exists", () => {
	const bundle = pkg({ provides: [{ kind: "skill", name: "paper-cards" }] });
	assert.equal(matchesPackage(bundle, "  PAPER-cards "), true);
	assert.equal(matchesPackage(bundle, "plugin:bundle"), true);
	assert.equal(matchesPackage(bundle, "absent"), false);
	assert.deepEqual(missingScopes(bundle), ["user", "project"]);
	assert.deepEqual(missingScopes(pkg({ copies: [{ scope: "user", state: "loadable" }] })), ["project"]);
});

test("copy states map to a closed label set and never offer an operation the state makes meaningless", () => {
	assert.deepEqual(copyState("loadable"), { label: "Ready", tone: "success" });
	assert.equal(copyState("damaged").tone, "fail");
	assert.deepEqual(copyState("novel"), { label: "novel", tone: "unverified" });
	assert.deepEqual(copyOperations("disabled"), ["enable", "update", "remove"]);
	assert.ok(!copyOperations("loadable").includes("enable"));
	assert.ok(!copyOperations("damaged").includes("disable"));
});

test("a plan step says what changes, where, and which copy is in effect afterwards", () => {
	assert.equal(stepTitle(step()), "Install skill:demo into your user library");
	assert.equal(
		stepTitle(
			step({ operation: "remove", identity: { ref: "skill:demo", kind: "skill", name: "demo", scope: "project" } }),
		),
		"Remove skill:demo in this project's library",
	);
	assert.equal(
		effectSentence(step({ effectiveAfter: { scope: "project", loadable: false, state: "disabled" } })),
		"This copy becomes the effective copy. Afterwards the project copy is the one in effect, and it is disabled.",
	);
	assert.equal(
		effectSentence(step({ fallbackNote: "no other copy exists; the package will be absent" })),
		"No other copy exists; the package will be absent.",
	);
});

test("only a missing-requirement refusal offers a second plan", () => {
	const plan = (refusal?: string): Plan => ({
		id: "0".repeat(16),
		createdAt: "",
		expiresAt: "",
		operation: "install",
		applicable: !refusal,
		steps: [step(refusal ? { refusal } : {})],
		diagnostics: [],
	});
	assert.equal(needsRequirements(plan("library_requirement_missing: skill:base; plan with requirements")), true);
	assert.equal(needsRequirements(plan("skill:demo is already installed in user scope; use update or force")), false);
	assert.equal(needsRequirements(plan()), false);
});

test("disk, recipe admission and the headline stay separate facts", () => {
	const verified = {
		evidence: "pre-refresh" as const,
		tree: "present" as const,
		record: "recorded" as const,
		resources: [
			{ kind: "skill", name: "a", available: true },
			{ kind: "skill", name: "b", available: false, reason: "untrusted" },
		],
		effective: { scope: "user" as const, loadable: true },
	};
	assert.equal(
		diskSentence(outcome({ verification: verified })),
		"The files are on disk and the install record matches.",
	);
	assert.equal(
		diskSentence(outcome({ verification: { ...verified, tree: "changed" } })),
		"Files on disk: changed. Install record: recorded.",
	);
	assert.equal(diskSentence(outcome()), "Nothing was read back from disk.");
	assert.equal(
		recipeSentence(outcome({ verification: verified })),
		"1 of 2 recipes admitted. Held back: b (untrusted).",
	);
	assert.equal(recipeSentence(outcome({ operation: "remove" })), "Its recipes are no longer offered.");
	assert.deepEqual(outcomeHeadline(outcome()), { text: "Installed skill:demo in your user library", tone: "success" });
	assert.equal(outcomeHeadline(outcome({ error: { code: "verification", message: "m", next: "n" } })).tone, "warn");
	assert.equal(outcomeHeadline(outcome({ status: "failed" })).text, "Could not install skill:demo in your user library");
	assert.equal(outcomeHeadline(outcome({ status: "unattempted" })).tone, "unverified");
});

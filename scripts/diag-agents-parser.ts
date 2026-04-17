import { parseFleet } from "../src/domains/agents/fleet-parser.js";
import { parseFrontmatter } from "../src/domains/agents/frontmatter.js";
import { recipeIdFromPath } from "../src/domains/agents/recipe.js";

const failures: string[] = [];

function check(label: string, ok: boolean, detail?: string): void {
	if (ok) {
		process.stdout.write(`[diag-agents-parser] OK   ${label}\n`);
		return;
	}
	failures.push(detail ? `${label}: ${detail}` : label);
	process.stderr.write(`[diag-agents-parser] FAIL ${label}${detail ? ` — ${detail}` : ""}\n`);
}

function expectThrow(label: string, run: () => void, includes?: string): void {
	let threw = false;
	let message = "";
	try {
		run();
	} catch (err) {
		threw = true;
		message = err instanceof Error ? err.message : String(err);
	}
	check(label, threw && (includes === undefined || message.includes(includes)), threw ? message : "did not throw");
}

function main(): void {
	check(
		"recipeIdFromPath:direct-child",
		recipeIdFromPath("/tmp/x/worker.md", "/tmp/x") === "worker",
		recipeIdFromPath("/tmp/x/worker.md", "/tmp/x"),
	);
	expectThrow(
		"recipeIdFromPath:nested-file-throws",
		() => recipeIdFromPath("/tmp/x/sub/worker.md", "/tmp/x"),
		"directly",
	);

	const parsedFrontmatter = parseFrontmatter("---\nname: X\n---\nbody text\n", "test.md");
	check(
		"parseFrontmatter:name",
		parsedFrontmatter.frontmatter.name === "X",
		JSON.stringify(parsedFrontmatter.frontmatter),
	);
	check("parseFrontmatter:body", parsedFrontmatter.body === "body text\n", JSON.stringify(parsedFrontmatter.body));
	expectThrow(
		"parseFrontmatter:missing-frontmatter-throws",
		() => parseFrontmatter("no frontmatter\n", "test.md"),
		"opening delimiter",
	);

	const twoStepFleet = parseFleet("scout -> worker");
	check("parseFleet:two-steps", twoStepFleet.steps.length === 2, JSON.stringify(twoStepFleet));
	check("parseFleet:two-steps-empty-options", Object.keys(twoStepFleet.steps[0]?.options ?? {}).length === 0);

	const scopedFleet = parseFleet("scout[scope=./src]");
	check("parseFleet:single-step-with-scope", scopedFleet.steps.length === 1, JSON.stringify(scopedFleet));
	check(
		"parseFleet:scope-option",
		scopedFleet.steps[0]?.options.scope === "./src",
		JSON.stringify(scopedFleet.steps[0]?.options),
	);

	const quotedFleet = parseFleet('a -> b[k="v w"]');
	check("parseFleet:quoted-second-step", quotedFleet.steps[1]?.recipeId === "b", JSON.stringify(quotedFleet));
	check(
		"parseFleet:quoted-value",
		quotedFleet.steps[1]?.options.k === "v w",
		JSON.stringify(quotedFleet.steps[1]?.options),
	);

	const mixedFleet = parseFleet('researcher[query="full-text search", depth=3]');
	check("parseFleet:mixed-options-count", Object.keys(mixedFleet.steps[0]?.options ?? {}).length === 2);
	check(
		"parseFleet:mixed-query",
		mixedFleet.steps[0]?.options.query === "full-text search",
		JSON.stringify(mixedFleet.steps[0]?.options),
	);
	check(
		"parseFleet:mixed-depth",
		mixedFleet.steps[0]?.options.depth === "3",
		JSON.stringify(mixedFleet.steps[0]?.options),
	);

	expectThrow("parseFleet:empty-throws", () => parseFleet(""), "empty");
	expectThrow("parseFleet:missing-tail-step-throws", () => parseFleet("a -> "), 'after "->"');
	expectThrow("parseFleet:unclosed-options-throws", () => parseFleet("a[scope=./src"), "unclosed");

	if (failures.length > 0) {
		process.stderr.write(`[diag-agents-parser] FAILED ${failures.length} check(s)\n`);
		process.exit(1);
	}
	process.stdout.write("[diag-agents-parser] PASS\n");
}

main();

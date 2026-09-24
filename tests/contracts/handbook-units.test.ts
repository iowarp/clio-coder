import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { ProjectPromptContext } from "../../src/domains/context/contract.js";
import {
	compileHandbook,
	selectWorkerHandbook,
	workerHandbookAudience,
} from "../../src/domains/context/handbook-units.js";
import { buildDynamicPromptMessages } from "../../src/domains/dispatch/extension.js";

const PATH = "/repo/CLIO-CODER.md";
const HANDBOOK = `# Demo

Demo is a CLI with a web GUI. Only the rules you would get wrong are here.

## Hard invariants

1. Only \`src/engine/**\` imports the SDK.
2. Never write to the operator's real home from tests.

## Conventions

- Relative imports end in \`.js\`.

## Change recipes

- Settings key: add it to \`src/core/defaults.ts\` and a row in \`docs/guide/settings.md\`.
- GUI logic: a pure \`*-model.ts\` next to the component, tested under \`apps/web/tests/\`.
  Register the test file in \`apps/web/package.json\` or it never runs.

\`\`\`sh
pnpm --filter web test
\`\`\`

## Git and release

- Bump \`package.json\` and \`assets/registry/agent.json\` together.

## Operating the agent on this repository

- Route scout through \`.clio-coder/settings.local.yaml\`.

## Pinned area
<!-- clio: audience=verify paths=vendor/** -->

- Vendored code is regenerated, never edited.
`;

const compiled = compileHandbook(HANDBOOK, PATH);

function unitIn(section: string, needle: string) {
	const unit = compiled?.units.find((entry) => entry.section === section && entry.text.includes(needle));
	ok(unit, `${section}: ${needle}`);
	return unit;
}

describe("handbook compilation", () => {
	it("splits sections into rule units with derived audience and path scope", () => {
		ok(compiled);
		strictEqual(compiled.title, "Demo");
		ok(compiled.identity.startsWith("Demo is a CLI"));
		deepStrictEqual(unitIn("Hard invariants", "SDK").audience, ["all"]);
		deepStrictEqual(unitIn("Hard invariants", "SDK").paths, ["src/engine/**"]);
		deepStrictEqual(unitIn("Change recipes", "Settings key").paths, ["docs/guide/**", "src/core/**"]);
		deepStrictEqual(unitIn("Change recipes", "Settings key").audience, ["write", "verify"]);
		deepStrictEqual(unitIn("Git and release", "Bump").audience, ["git"]);
		deepStrictEqual(unitIn("Operating the agent on this repository", "scout").audience, ["orchestrator"]);
	});

	it("keeps continuation lines and a trailing fence with their rule, and leaves one-segment paths unscoped", () => {
		const gui = unitIn("Change recipes", "GUI logic");
		ok(gui.text.includes("Register the test file"));
		ok(gui.text.includes("pnpm --filter web test"));
		deepStrictEqual(gui.paths, ["apps/web/**"]);
		strictEqual(unitIn("Conventions", ".js").paths, undefined);
	});

	it("lets a section comment override the derived audience and scope", () => {
		const vendored = unitIn("Pinned area", "Vendored");
		deepStrictEqual(vendored.audience, ["verify"]);
		deepStrictEqual(vendored.paths, ["vendor/**"]);
	});

	it("returns null for prose with no routable sections, so callers keep the verbatim path", () => {
		strictEqual(compileHandbook("Keep the tolerance unchanged.\n\nRun the focused tests.\n", PATH), null);
	});
});

describe("worker handbook selection", () => {
	const handbooks = compiled ? [compiled] : [];

	it("gives a coder in the GUI the invariants and the GUI recipe, but not release or orchestrator rules", () => {
		const selected = selectWorkerHandbook(handbooks, {
			audience: workerHandbookAudience("coder", "workspace-edit"),
			cwd: "/repo",
			workingPaths: ["apps/web/client/Strip.tsx"],
			maxChars: 4000,
		});
		ok(selected.text.includes("Only `src/engine/**` imports the SDK."));
		ok(selected.text.includes("Never write to the operator's real home"));
		ok(selected.text.includes("GUI logic"));
		ok(!selected.text.includes("Bump `package.json`"));
		ok(!selected.text.includes("Route scout"));
		ok(selected.text.includes("Git and release"), "omitted sections are named");
		ok(selected.text.includes(PATH), "omitted rules point at the full handbook");
	});

	it("routes release rules to git-master and verification rules to the verifier", () => {
		const git = selectWorkerHandbook(handbooks, {
			audience: workerHandbookAudience("git-master", "workspace-edit"),
			cwd: "/repo",
			workingPaths: [],
			maxChars: 4000,
		});
		ok(git.text.includes("Bump `package.json`"));
		const verifier = selectWorkerHandbook(handbooks, {
			audience: workerHandbookAudience("verifier", "verification"),
			cwd: "/repo",
			workingPaths: ["/repo/vendor/lib.c"],
			maxChars: 4000,
		});
		ok(verifier.text.includes("Vendored code is regenerated"));
	});

	it("fills invariants first under a tight budget and never exceeds it", () => {
		const selected = selectWorkerHandbook(handbooks, {
			audience: workerHandbookAudience("coder", "workspace-edit"),
			cwd: "/repo",
			workingPaths: ["src/core/defaults.ts"],
			maxChars: 470,
		});
		ok(selected.text.length <= 470);
		ok(selected.text.includes("imports the SDK"));
		ok(selected.text.includes("real home"));
		ok(!selected.text.includes("Relative imports"), "a convention never displaces an invariant");
		const starved = selectWorkerHandbook(handbooks, {
			audience: workerHandbookAudience("coder", "workspace-edit"),
			cwd: "/repo",
			workingPaths: [],
			maxChars: 420,
		});
		ok(!starved.text.includes("Relative imports"));
	});
});

describe("dispatch project context", () => {
	it("ships a bounded worker the compiled selection for its path scope", () => {
		const projectPrompt: ProjectPromptContext = {
			text: HANDBOOK,
			handbookSources: [{ path: PATH, source: HANDBOOK }],
			handbookFiles: [PATH],
			supportFragments: [],
			clioMd: null,
			warnings: [],
		};
		const messages = buildDynamicPromptMessages(
			{ agentId: "coder", task: "Extract the strip helpers.", executionRole: "builder" },
			{
				agentId: "coder",
				capabilityClass: "workspace-edit",
				projectContextTier: "bounded",
				projectPrompt,
				workingContextPaths: ["apps/web/client/Strip.tsx"],
				cwd: "/repo",
			},
		);
		const body = messages.find(({ id }) => id === "dispatch-project-context")?.body ?? "";
		ok(body.includes("GUI logic"));
		ok(!body.includes("Route scout"));
	});
});

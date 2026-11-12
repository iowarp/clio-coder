import { deepStrictEqual, doesNotMatch, ok, strictEqual } from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { judgeInstructionFiles } from "../../src/domains/context/bootstrap.js";
import type { ProjectPromptContext } from "../../src/domains/context/contract.js";
import {
	compileHandbook,
	selectWorkerHandbook,
	workerHandbookAudience,
} from "../../src/domains/context/handbook-units.js";
import { compilePeerHandbook } from "../../src/domains/context/peer-handbook.js";
import { treeFacts } from "../../src/domains/context/tree-facts.js";
import { buildDynamicPromptMessages } from "../../src/domains/dispatch/extension.js";
import { peerInstructionsStaleMessage, resolvePeerInstructions } from "../../src/domains/dispatch/peer-instructions.js";
import { opencodeCliRuntime, piCliRuntime } from "../../src/domains/providers/runtimes/external-cli-peers.js";

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

	it("sits the handbook's headings one level below the worker prompt's sections", () => {
		const selected = selectWorkerHandbook(handbooks, {
			audience: workerHandbookAudience("coder", "workspace-edit"),
			cwd: "/repo",
			workingPaths: ["apps/web/client/Strip.tsx"],
			maxChars: 4000,
		});
		const headings = selected.text.split("\n").filter((line) => line.startsWith("#"));
		ok(headings.includes("## Demo"));
		ok(headings.includes("### Hard invariants"));
		ok(
			headings.every((line) => line.startsWith("## ") || line.startsWith("### ")),
			headings.join(" | "),
		);
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
		ok(starved.text.length <= 420);
		ok(/Rules not selected[^\n]*invariants/i.test(starved.text), "a skipped invariant is signposted");
	});

	it("keeps packing the worker's own sections after invariants that overflow the budget", () => {
		const invariants = Array.from(
			{ length: 20 },
			(_, index) => `${index + 1}. Invariant ${index + 1}: ${"keep the boundary intact. ".repeat(15).trim()}`,
		).join("\n");
		const big = compileHandbook(
			`# Big\n\n## Hard invariants\n\n${invariants}\n\n## Change recipes\n\n- New tool: register it in the tool table.\n\n## Tests\n\n- Add each new test file to the curated list.\n`,
			PATH,
		);
		ok(big);
		const selected = selectWorkerHandbook([big], {
			audience: workerHandbookAudience("coder", "workspace-edit"),
			cwd: "/repo",
			workingPaths: [],
			maxChars: 6000,
		});
		ok(selected.text.length > 0 && selected.text.length <= 6000);
		ok(selected.text.includes("register it in the tool table"));
		ok(selected.text.includes("curated list"));
		const order = [...selected.text.matchAll(/Invariant (\d+):/g)].map((match) => Number(match[1]));
		ok(order.length > 0);
		deepStrictEqual(
			order,
			[...order].sort((a, b) => a - b),
		);
		ok(
			/Rules not selected for this task, from: Hard invariants\. Read [^\n]+\n<\/project-handbook>$/.test(selected.text),
		);
	});

	it("renders a handbook that fits whole in document order, headings one level down", () => {
		const small = compileHandbook(
			"# Small\n\nSmall is a tool.\n\n## Hard invariants\n\n1. Never touch home.\n\n## Conventions\n\n- Imports end in `.js`.\n",
			PATH,
		);
		ok(small);
		const selected = selectWorkerHandbook([small], {
			audience: workerHandbookAudience("coder", "workspace-edit"),
			cwd: "/repo",
			workingPaths: [],
			maxChars: 6000,
		});
		strictEqual(
			selected.text,
			`<project-handbook path="${PATH}" rules="2/2">\n## Small\nSmall is a tool.\n\n### Hard invariants\n1. Never touch home.\n\n### Conventions\n- Imports end in \`.js\`.\n</project-handbook>`,
		);
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

describe("peer handbook compile", () => {
	it("gives a delegated peer one rule set: its own rules that hold, the tree's value for a stale one, nothing about its file", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "clio-peer-handbook-"));
		try {
			writeFileSync(
				join(cwd, "package.json"),
				JSON.stringify({ name: "demo", scripts: { test: "node --test", build: "tsc" } }),
			);
			writeFileSync(join(cwd, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
			mkdirSync(join(cwd, "src"));
			writeFileSync(join(cwd, "src", "cart.ts"), "export const cents = (value: number): number => value;\n");
			const handbook = [
				"# Demo",
				"",
				"Demo prices carts.",
				"",
				"## Hard invariants",
				"",
				"1. Never write to the operator's real home from tests.",
				"",
				"## Conventions",
				"",
				"- Cart prices live in `src/cart.ts`.",
				"- Fan reviews out with the `dispatch` tool.",
				"",
				"## Operating rules",
				"",
				"- Route scout before planner.",
				"",
			].join("\n");
			const peerFile = [
				"# Notes",
				"",
				"- Money is integer cents; see `src/cart.ts`.",
				"- Run `pnpm run test:all` before committing.",
				"- Never write to the operator's real home from tests.",
				"",
			].join("\n");
			writeFileSync(join(cwd, "CLIO-CODER.md"), handbook);
			writeFileSync(join(cwd, "CLAUDE.md"), peerFile);
			const peerRules = await judgeInstructionFiles(
				cwd,
				[{ file: "CLAUDE.md", path: join(cwd, "CLAUDE.md"), content: peerFile }],
				"adopted",
			);
			const compiled = compileHandbook(handbook, join(cwd, "CLIO-CODER.md"));
			ok(compiled);
			const peer = compilePeerHandbook([compiled], {
				audience: workerHandbookAudience("coder", "workspace-edit"),
				cwd,
				workingPaths: [],
				maxChars: 6000,
				peerRules,
				facts: treeFacts(cwd),
				clioNames: ["dispatch", "context", "scout"],
			});
			strictEqual(peer.text.split("Never write to the operator's real home from tests").length - 1, 1, peer.text);
			ok(peer.text.includes("Money is integer cents; see `src/cart.ts`."), peer.text);
			ok(peer.text.includes("The test command is `pnpm run test`, from `package.json` `scripts.test`."), peer.text);
			ok(!peer.text.includes("test:all"), peer.text);
			// Rules that only make sense inside Clio stay out.
			ok(!peer.text.includes("`dispatch`"), peer.text);
			ok(!peer.text.includes("Route scout"), peer.text);
			doesNotMatch(peer.text, /CLAUDE\.md|\bignore|\boverrid|\bcorrect/iu);
			deepStrictEqual(
				{ carried: peer.carried, stale: peer.stale, facts: peer.facts, notCarried: peer.notCarried },
				{ carried: 2, stale: 1, facts: 1, notCarried: 0 },
			);
			// Deterministic for unchanged inputs.
			strictEqual(
				compilePeerHandbook([compiled], {
					audience: workerHandbookAudience("coder", "workspace-edit"),
					cwd,
					workingPaths: [],
					maxChars: 6000,
					peerRules,
					facts: treeFacts(cwd),
					clioNames: ["dispatch", "context", "scout"],
				}).text,
				peer.text,
			);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("keeps the handbook's summary and invariants when a peer's file overflows the bound, and counts every rule left out", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "clio-peer-handbook-"));
		try {
			writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "demo", scripts: { test: "node --test" } }));
			const conventions = Array.from({ length: 60 }, (_, n) => `- Convention ${n}: keep module ${n}'s exports sorted.`);
			const handbook = [
				"# Demo",
				"",
				"Demo prices carts.",
				"",
				"## Hard invariants",
				"",
				"1. Never write to the operator's real home from tests.",
				"",
				"## Conventions",
				"",
				...conventions,
				"",
			].join("\n");
			const notes = Array.from(
				{ length: 150 },
				(_, n) => `- Peer note ${n}: the widget ${n} stays aligned with its frame.`,
			);
			const peerFile = ["# Notes", "", ...notes, ""].join("\n");
			const peerRules = await judgeInstructionFiles(
				cwd,
				[{ file: "AGENTS.md", path: join(cwd, "AGENTS.md"), content: peerFile }],
				"adopted",
			);
			const compiled = compileHandbook(handbook, join(cwd, "CLIO-CODER.md"));
			ok(compiled);
			const peer = compilePeerHandbook([compiled], {
				audience: workerHandbookAudience("coder", "workspace-edit"),
				cwd,
				workingPaths: [],
				maxChars: 6000,
				peerRules,
				facts: treeFacts(cwd),
				clioNames: [],
			});
			ok(peer.text.length <= 6000, String(peer.text.length));
			ok(peer.text.includes("Demo prices carts."), peer.text);
			ok(peer.text.includes("Never write to the operator's real home from tests."), peer.text);
			const carriedNotes = peer.text.match(/Peer note \d+:/g)?.length ?? 0;
			const carriedConventions = peer.text.match(/Convention \d+:/g)?.length ?? 0;
			ok(carriedNotes > 0 && carriedNotes < notes.length, String(carriedNotes));
			ok(carriedConventions > 0, peer.text);
			strictEqual(peer.carried, carriedNotes);
			strictEqual(peer.notCarried, notes.length - carriedNotes + conventions.length - carriedConventions);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("gives a peer every invariant a native worker gets when the invariants overflow, the peer's rules taking audience room", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "clio-peer-handbook-"));
		try {
			const invariants = Array.from(
				{ length: 14 },
				(_, index) => `${index + 1}. Invariant ${index + 1}: ${"keep the boundary intact. ".repeat(17).trim()}`,
			);
			const recipes = Array.from({ length: 30 }, (_, n) => `- Recipe ${n}: register tool ${n} in the tool table.`);
			const handbook = [
				"# Demo",
				"",
				"## Hard invariants",
				"",
				...invariants,
				"",
				"## Change recipes",
				"",
				...recipes,
				"",
			];
			const compiled = compileHandbook(handbook.join("\n"), join(cwd, "CLIO-CODER.md"));
			ok(compiled);
			const audience = workerHandbookAudience("coder", "workspace-edit");
			const native = selectWorkerHandbook([compiled], { audience, cwd, workingPaths: [], maxChars: 6000 });
			const carried = (text: string): number[] => [
				...new Set([...text.matchAll(/Invariant (\d+):/g)].map((match) => Number(match[1]))),
			];
			const nativeInvariants = carried(native.text);
			ok(nativeInvariants.length > 0 && nativeInvariants.length < invariants.length, native.text);
			const notes = Array.from({ length: 40 }, (_, n) => `- Peer note ${n}: widget ${n} stays aligned with its frame.`);
			const peerRules = await judgeInstructionFiles(
				cwd,
				[{ file: "AGENTS.md", path: join(cwd, "AGENTS.md"), content: ["# Notes", "", ...notes, ""].join("\n") }],
				"adopted",
			);
			const peer = compilePeerHandbook([compiled], {
				audience,
				cwd,
				workingPaths: [],
				maxChars: 6000,
				peerRules,
				facts: treeFacts(cwd),
				clioNames: [],
			});
			ok(peer.text.length <= 6000, String(peer.text.length));
			deepStrictEqual(carried(peer.text), nativeInvariants);
			ok(/Peer note \d+:/.test(peer.text), peer.text);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("overlays the files OpenCode reads: the first name found from the run's directory up, in every directory", async () => {
		const root = mkdtempSync(join(tmpdir(), "clio-opencode-files-"));
		const resolveIn = async (cwd: string) =>
			resolvePeerInstructions({
				declared: opencodeCliRuntime.repositoryInstructions,
				cwd,
				handbookSources: [{ source: HANDBOOK, path: join(root, "CLIO-CODER.md") }],
				audience: workerHandbookAudience("coder", "workspace-edit"),
				workingPaths: [],
				maxChars: 6000,
				clioNames: [],
				taskWorktree: root,
				declaredPaths: [],
			});
		try {
			execFileSync("git", ["init", "-q", root]);
			mkdirSync(join(root, "sub"));
			writeFileSync(join(root, "CONTEXT.md"), "# Context\n\n- Prices are integer cents.\n");
			writeFileSync(join(root, "sub", "CLAUDE.md"), "# Sub\n\n- Keep the API stable.\n");
			execFileSync("git", ["-C", root, "add", "."]);
			// OpenCode takes AGENTS.md, else CLAUDE.md, else CONTEXT.md: one name for the whole walk, not one per directory.
			const claude = await resolveIn(join(root, "sub"));
			deepStrictEqual(claude?.files, ["sub/CLAUDE.md"]);
			writeFileSync(join(root, "AGENTS.md"), "# Notes\n\n- Money is integer cents.\n");
			execFileSync("git", ["-C", root, "add", "."]);
			const agents = await resolveIn(join(root, "sub"));
			deepStrictEqual(agents?.files, ["AGENTS.md"]);
			strictEqual(agents?.delivery, "overlay");
			ok(agents?.overlay?.[0]?.content.includes("Never write to the operator's real home from tests."));
			rmSync(join(root, "AGENTS.md"));
			rmSync(join(root, "sub"), { recursive: true });
			execFileSync("git", ["-C", root, "add", "-A"]);
			deepStrictEqual((await resolveIn(root))?.files, ["CONTEXT.md"]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("lets a harness read its own files when their holding rules do not all fit the bound, and says why", async () => {
		const root = mkdtempSync(join(tmpdir(), "clio-peer-over-bound-"));
		const resolveWith = async (notes: number) => {
			const lines = Array.from({ length: notes }, (_, n) => `- Peer note ${n}: widget ${n} stays aligned with its frame.`);
			writeFileSync(join(root, "AGENTS.md"), ["# Notes", "", ...lines, ""].join("\n"));
			return resolvePeerInstructions({
				declared: piCliRuntime.repositoryInstructions,
				cwd: root,
				handbookSources: [{ source: HANDBOOK, path: join(root, "CLIO-CODER.md") }],
				audience: workerHandbookAudience("coder", "workspace-edit"),
				workingPaths: [],
				maxChars: 1500,
				clioNames: [],
				declaredPaths: [],
			});
		};
		try {
			execFileSync("git", ["init", "-q", root]);
			const fits = await resolveWith(2);
			strictEqual(fits?.delivery, "single-source");
			strictEqual(fits?.reason, undefined);
			const over = await resolveWith(60);
			strictEqual(over?.delivery, "coexist");
			strictEqual(over?.reason, "over-bound");
			ok((over?.notCarried ?? 0) > 0);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("names each stale file with its own count and says nothing when every rule holds", () => {
		strictEqual(peerInstructionsStaleMessage("Codex", []), null);
		strictEqual(
			peerInstructionsStaleMessage("Claude Code", [{ file: "CLAUDE.md", stale: 2 }]),
			"CLAUDE.md has 2 rules that no longer match the repository; Claude Code read them in this run.",
		);
		strictEqual(
			peerInstructionsStaleMessage("Pi CLI", [
				{ file: "AGENTS.md", stale: 1 },
				{ file: "CLAUDE.md", stale: 3 },
			]),
			"AGENTS.md has 1 rule and CLAUDE.md has 3 rules that no longer match the repository; Pi CLI read them in this run.",
		);
	});
});

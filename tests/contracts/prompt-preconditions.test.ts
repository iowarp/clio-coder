import { deepStrictEqual, ok, strictEqual, throws } from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ToolNames } from "../../src/core/tool-names.js";
import { compile, type SessionPromptInputs } from "../../src/domains/prompts/compiler.js";
import { type FragmentTable, type LoadedFragment, loadFragments } from "../../src/domains/prompts/fragment-loader.js";
import { guidanceForDocs } from "../../src/domains/prompts/runtime-guidance.js";

function withFragments(files: Record<string, string>, run: (root: string) => void): void {
	const root = mkdtempSync(join(tmpdir(), "clio-prompt-preconditions-"));
	try {
		for (const [name, text] of Object.entries(files)) {
			mkdirSync(join(root, name, ".."), { recursive: true });
			writeFileSync(join(root, name), text);
		}
		run(root);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

const header = (id: string, extra = ""): string =>
	`---\nid: ${id}\nversion: 1\ndescription: test fragment\n${extra}---\n`;

describe("fragment preconditions in frontmatter", () => {
	it("parses requires, surfaces and when", () => {
		withFragments(
			{
				"a.md": `${header("test.a", "requires: [job, panes]\nsurfaces: [attended, worker]\nwhen: { sandbox: active, autonomy: yolo-unconfined }\n")}body\n`,
			},
			(root) => {
				const fragment = loadFragments(root).byId.get("test.a");
				deepStrictEqual(fragment?.requires, ["job", "panes"]);
				deepStrictEqual(fragment?.surfaces, ["attended", "worker"]);
				deepStrictEqual(fragment?.when, { sandbox: "active", autonomy: "yolo-unconfined" });
			},
		);
	});

	it("rejects an unknown when key, an unknown capability and an unknown row condition", () => {
		for (const [extra, body, pattern] of [
			["when: { network: on }\n", "body\n", /a\.md: frontmatter\.when\.network is not a known condition/],
			["requires: [web_find]\n", "body\n", /a\.md: frontmatter\.requires names unknown "web_find"/],
			["surfaces: [gui]\n", "body\n", /a\.md: frontmatter\.surfaces names unknown "gui"/],
			["", "first\n- {pane} row\n", /a\.md: body line 2 has unknown row condition \{pane\}/],
		] as const) {
			withFragments({ "a.md": `${header("test.a", extra)}${body}` }, (root) => {
				throws(() => loadFragments(root), pattern);
			});
		}
	});
});

describe("fragment preconditions in the compiled prompt", () => {
	const real = loadFragments();
	// operating.user-control stands in for any attended fragment: it is replaced
	// by one that requires `job` and carries a `{panes}` row and an inline `{verify}`.
	const probe = (requires: string): FragmentTable => {
		const original = real.byId.get("operating.user-control") as LoadedFragment;
		const byId = new Map(real.byId);
		byId.set("operating.user-control", {
			...original,
			surfaces: ["attended"],
			requires: [requires],
			body: [
				"Probe opens. Wait with `job`.",
				"- {panes} Keep a server in `panes`, not a background",
				"  shell.",
				"- Always here. {verify} Run `verify` on the declared",
				"  check. Then stop.",
			].join("\n"),
		});
		return { byId, rootDir: real.rootDir };
	};
	const prompt = (table: FragmentTable, toolNames: string[], headless = false): string =>
		compile(table, {
			identity: "identity.clio",
			operatingContract: "operating.contract",
			safety: "safety.default",
			sessionInputs: {
				coordinatorCapabilities: toolNames,
				providerSupportsTools: true,
				toolNames,
				...(headless ? { headless: true } : {}),
			} satisfies SessionPromptInputs,
		}).systemPrompt;

	it("drops a fragment whose required capability or surface is missing", () => {
		const table = probe(ToolNames.Job);
		ok(prompt(table, [ToolNames.Read, ToolNames.Job]).includes("Probe opens."));
		ok(!prompt(table, [ToolNames.Read]).includes("Probe opens."));
		ok(!prompt(table, [ToolNames.Read, ToolNames.Job], true).includes("Probe opens."));
	});

	it("renders a row only when its condition holds, and strips the marker", () => {
		const table = probe(ToolNames.Read);
		const without = prompt(table, [ToolNames.Read]);
		ok(without.includes("Probe opens. Wait with `job`.\n- Always here. Then stop."), without);
		ok(!without.includes("panes"), without);
		const withBoth = prompt(table, [ToolNames.Read, ToolNames.Panes, ToolNames.Verify]);
		ok(
			withBoth.includes(
				"- Keep a server in `panes`, not a background\n  shell.\n- Always here. Run `verify` on the declared\n  check. Then stop.",
			),
			withBoth,
		);
		ok(!withBoth.includes("{"), withBoth);
	});

	it("records the preconditions that held in the fragment manifest", () => {
		const compiled = compile(probe(ToolNames.Job), {
			identity: "identity.clio",
			operatingContract: "operating.contract",
			safety: "safety.default",
			sessionInputs: { coordinatorCapabilities: [ToolNames.Job], providerSupportsTools: true, toolNames: [ToolNames.Job] },
		});
		const entry = compiled.fragmentManifest.find((fragment) => fragment.id === "operating.user-control");
		deepStrictEqual(entry?.preconditions, ["surface:attended", "requires:job"]);
		strictEqual(compiled.fragmentManifest.find((fragment) => fragment.id === "identity.clio")?.preconditions, undefined);
	});

	it("serves docs guidance with every row kept and no markers", () => {
		const memory = guidanceForDocs("remember this").find((entry) => entry.id === "operating.memory-guidance");
		ok(memory?.text.includes("tool. `memory_recall` only reads:"), memory?.text);
		ok(!memory?.text.includes("{memory_recall}"), memory?.text);
	});
});

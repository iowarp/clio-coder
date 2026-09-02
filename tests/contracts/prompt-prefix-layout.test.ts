import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";

import {
	type CompileInputs,
	compile,
	LEGACY_SESSION_PROMPT_SECTION_ORDER,
	SESSION_PROMPT_SECTION_ORDER,
	type SessionPromptInputs,
} from "../../src/domains/prompts/compiler.js";
import { loadFragments } from "../../src/domains/prompts/fragment-loader.js";

/**
 * The compiled main prompt is a cache prefix: every backend Clio targets
 * re-prefills from the earliest changed byte, so the section order is a
 * deliberate cache decision (issue #249) and identical inputs must produce
 * identical bytes. These contracts pin the layout, not the prose: a fragment
 * may be reworded freely, but a section may not move without this test
 * moving with it.
 */

const FULL_TOOL_SURFACE = [
	"artifact",
	"ask_user",
	"bash",
	"code_nav",
	"context",
	"dispatch",
	"edit",
	"find",
	"git",
	"grep",
	"ls",
	"monitor",
	"read",
	"steer",
	"tasks",
	"verify",
	"web_fetch",
	"write",
];

function sessionInputs(overrides: Partial<SessionPromptInputs> = {}): SessionPromptInputs {
	return {
		provider: "local",
		model: "stable-model",
		contextWindow: 32_768,
		providerSupportsTools: true,
		toolNames: FULL_TOOL_SURFACE,
		toolPromptHints: [
			{ tool: "tasks", hint: "Declare the board before the first edit." },
			{ tool: "context", hint: "Load a requested skill first." },
		],
		fleetRoster:
			"# Fleet\nDelegate when the task has two or more independent subtasks.\n- coder (workspace-edit, 50 calls)",
		contextFiles: "<project-type>typescript</project-type>",
		memorySection: "# Memory\n\n- stable fact",
		...overrides,
	};
}

function compileInputs(overrides: Partial<SessionPromptInputs> = {}): CompileInputs {
	return {
		identity: "identity.clio",
		operatingContract: "operating.contract",
		safety: "safety.auto-edit",
		sessionInputs: sessionInputs(overrides),
		additionalFragments: [
			{
				id: "context.workspace-root",
				relPath: "inline/workspace-root",
				body: "# Workspace\nAbsolute workspace root: /workspace",
				contentHash: "a".repeat(64),
				dynamic: true,
			},
			{
				id: "context.project-rules",
				relPath: "inline/project-rules",
				body: "# Project rules\n\nKeep imports sorted.",
				contentHash: "b".repeat(64),
				dynamic: true,
			},
		],
	};
}

const table = loadFragments();

describe("compiled main prompt: section layout", () => {
	it("lays every compiled section down in SESSION_PROMPT_SECTION_ORDER, then the operator-editable tail", () => {
		const inputs = compileInputs();
		const compiled = compile(table, inputs);
		const ids = compiled.sections.map((section) => section.id);
		const tailIds = (inputs.additionalFragments ?? []).map((fragment) => fragment.id);

		// With every input present, every compiled section renders, in exactly
		// the declared order, and the tail fragments follow in their own order.
		deepStrictEqual(ids, [...SESSION_PROMPT_SECTION_ORDER, ...tailIds]);
	});

	it("keeps the volatility rule: identity through fleet ahead of project context, memory, and runtime", () => {
		const order = [...SESSION_PROMPT_SECTION_ORDER];
		const at = (id: string): number => {
			const index = order.indexOf(id);
			ok(index >= 0, `section ${id} must be in SESSION_PROMPT_SECTION_ORDER`);
			return index;
		};
		// Constitutional text first, then role text, then the enforced posture,
		// then the tool surface and the roster that surface reaches.
		ok(at("identity") < at("operating-contract"));
		ok(at("operating-contract") < at("delegation"));
		ok(at("delegation") < at("skills"));
		ok(at("skills") < at("safety"));
		ok(at("safety") < at("tool-contract"));
		ok(at("tool-contract") < at("fleet"));
		// Everything that reads a mutable store or a probe comes after everything
		// that does not: project context is session-stable, memory rewrites
		// mid-session, and the runtime block's context window can move.
		ok(at("fleet") < at("project-context"));
		ok(at("project-context") < at("memory"));
		ok(at("memory") < at("runtime"));
		strictEqual(order[order.length - 1], "runtime", "runtime is the last compiled section");
	});

	it("is a pure permutation of the 0.3.8 order: no section added, none dropped", () => {
		deepStrictEqual([...SESSION_PROMPT_SECTION_ORDER].sort(), [...LEGACY_SESSION_PROMPT_SECTION_ORDER].sort());
	});

	it("renders section text in the same order as the section list", () => {
		const compiled = compile(table, compileInputs());
		// One marker per section, taken from the fragment table or from the
		// inputs this test supplies rather than from pinned prose, so a reworded
		// fragment cannot fail this while a moved section must.
		const markers: Array<[string, string]> = [
			["identity", firstLine(table.byId.get("identity.clio")?.body)],
			["operating-contract", firstLine(table.byId.get("operating.contract")?.body)],
			["delegation", firstLine(table.byId.get("operating.delegation")?.body)],
			["skills", firstLine(table.byId.get("operating.skills")?.body)],
			["safety", "Autonomy: auto-edit."],
			["tool-contract", "Direct tools:"],
			["fleet", "- coder (workspace-edit, 50 calls)"],
			["project-context", "<project-type>typescript</project-type>"],
			["memory", "- stable fact"],
			["runtime", "Provider: local"],
			["context.workspace-root", "Absolute workspace root: /workspace"],
			["context.project-rules", "Keep imports sorted."],
		];
		let cursor = -1;
		for (const [id, marker] of markers) {
			const at = compiled.systemPrompt.indexOf(marker, cursor + 1);
			ok(at > cursor, `section ${id} (marker ${JSON.stringify(marker)}) renders after the section before it`);
			cursor = at;
		}
	});
});

function firstLine(body: string | undefined): string {
	const line = (body ?? "")
		.split("\n")
		.map((entry) => entry.trim())
		.find((entry) => entry.length > 0);
	ok(line !== undefined, "fragment body has a first line");
	return line;
}

describe("compiled main prompt: determinism", () => {
	it("produces byte-identical text and hash for identical inputs", () => {
		const first = compile(table, compileInputs());
		const second = compile(table, compileInputs());
		strictEqual(second.systemPrompt, first.systemPrompt);
		strictEqual(second.systemPromptHash, first.systemPromptHash);
		deepStrictEqual(
			second.sections.map((section) => section.id),
			first.sections.map((section) => section.id),
		);
	});

	it("does not depend on tool-name or hint registration order", () => {
		const shuffledNames = [...FULL_TOOL_SURFACE].reverse();
		const shuffledHints = [...(sessionInputs().toolPromptHints ?? [])].reverse();
		const ordered = compile(table, compileInputs());
		const shuffled = compile(table, compileInputs({ toolNames: shuffledNames, toolPromptHints: shuffledHints }));
		strictEqual(shuffled.systemPrompt, ordered.systemPrompt);
	});
});

describe("compiled main prompt: surface-gated sections", () => {
	it("drops delegation and fleet together when dispatch leaves the surface, keeping the rest in order", () => {
		const withoutDispatch = compile(
			table,
			compileInputs({ toolNames: FULL_TOOL_SURFACE.filter((name) => name !== "dispatch") }),
		);
		const ids = withoutDispatch.sections.map((section) => section.id);
		ok(!ids.includes("delegation"), "delegation renders only with dispatch");
		ok(!ids.includes("fleet"), "fleet renders only with dispatch");
		const expected = SESSION_PROMPT_SECTION_ORDER.filter((id) => id !== "delegation" && id !== "fleet");
		deepStrictEqual(ids.slice(0, expected.length), [...expected]);
	});

	it("drops skills when context leaves the surface, and the tool-free contract drops both role sections", () => {
		// A hint counts as the tool being on the surface, so both go together.
		const withoutContext = compile(
			table,
			compileInputs({
				toolNames: FULL_TOOL_SURFACE.filter((name) => name !== "context"),
				toolPromptHints: (sessionInputs().toolPromptHints ?? []).filter((entry) => entry.tool !== "context"),
			}),
		);
		ok(!withoutContext.sections.some((section) => section.id === "skills"), "skills renders only with context");

		const toolFree = compile(table, compileInputs({ providerSupportsTools: false, toolPromptHints: [] }));
		const ids = toolFree.sections.map((section) => section.id);
		ok(!ids.includes("delegation"));
		ok(!ids.includes("skills"));
		ok(!ids.includes("fleet"));
		ok(ids.includes("tool-contract"), "a tool-free target still gets a tool contract saying so");
		const expected = SESSION_PROMPT_SECTION_ORDER.filter((id) => !["delegation", "skills", "fleet"].includes(id));
		deepStrictEqual(ids.slice(0, expected.length), [...expected]);
	});

	it("omits memory and project context when absent without disturbing the neighbours", () => {
		const { memorySection: _memory, contextFiles: _context, ...withoutStores } = sessionInputs();
		const bare = compile(table, { ...compileInputs(), sessionInputs: withoutStores });
		const ids = bare.sections.map((section) => section.id);
		ok(!ids.includes("memory"));
		ok(!ids.includes("project-context"));
		const expected = SESSION_PROMPT_SECTION_ORDER.filter((id) => id !== "memory" && id !== "project-context");
		deepStrictEqual(ids.slice(0, expected.length), [...expected]);
	});
});

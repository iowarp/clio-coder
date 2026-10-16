import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { narrowTurnConstraints, turnAllowsTool, turnDelegatesTool } from "../../src/core/turn-constraints.js";
import type { ResourcesContract } from "../../src/domains/resources/contract.js";
import { expandPromptTemplateInput, loadPromptTemplates } from "../../src/domains/resources/prompts/loader.js";
import { expandSubmitText } from "../../src/domains/resources/submit-expansion.js";

// A prompt template turn inherited the session's whole tool surface, so a host
// could not scope one action to the tools it declares (WTF-P records
// hostToolEnforcement.actionScoped: false). Frontmatter allowed-tools now rides
// the expansion as the turn constraint, which only narrows the session's limits.

test("a template's allowed-tools become the expanded turn's constraint and only narrow", async () => {
	const root = mkdtempSync(join(tmpdir(), "clio-coder-template-tools-"));
	try {
		const promptRoot = join(root, "prompts");
		mkdirSync(promptRoot, { recursive: true });
		writeFileSync(join(promptRoot, "review.md"), "---\nallowed-tools: Read, grep, write\n---\nReview $ARGUMENTS\n");
		writeFileSync(join(promptRoot, "plain.md"), "Plain $ARGUMENTS\n");
		const roots = [{ path: promptRoot, scope: "project" as const, trusted: true }];
		const resources = {
			parsePendingSkillRequests: (text: string) => ({ text, pendingSkillRequests: [] }),
			expandPromptTemplate: (text: string) => expandPromptTemplateInput(text, loadPromptTemplates({ roots })),
		} as unknown as ResourcesContract;

		const scoped = await expandSubmitText("/review src", resources, root);
		assert.equal(scoped.text, "Review src");
		assert.deepEqual(scoped.constraints, { allowedTools: ["read", "grep", "write"] });
		assert.deepEqual(narrowTurnConstraints({ allowedTools: ["read", "bash"] }, scoped.constraints)?.allowedTools, [
			"read",
		]);

		const plain = await expandSubmitText("/plain src", resources, root);
		assert.equal(plain.constraints, undefined);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// An imported Claude command speaks Claude's tool names: `Bash(git add:*)` grants
// a scoped shell there and named no Clio tool here, so `Bash(git add:*), Read`
// narrowed the turn to read alone and the imported commit command lost git.

function importedRoot(root: string, files: Record<string, string>) {
	const promptRoot = join(root, "commands");
	mkdirSync(promptRoot, { recursive: true });
	for (const [name, body] of Object.entries(files)) writeFileSync(join(promptRoot, name), body);
	return [{ path: promptRoot, scope: "package" as const, trusted: true, foreign: true }];
}

test("an imported command's Bash(...) entry maps to bash, so narrowing keeps every tool it grants", () => {
	const root = mkdtempSync(join(tmpdir(), "clio-coder-imported-tools-"));
	try {
		const roots = importedRoot(root, {
			"commit.md": "---\nallowed-tools: Bash(git add:*), Bash(git commit:*), Read\n---\nCommit $ARGUMENTS\n",
		});
		const loaded = loadPromptTemplates({ roots });
		const template = loaded.items.find((item) => item.name === "commit");
		assert.deepEqual(template?.allowedTools, ["bash", "read"]);
		assert.deepEqual(loaded.diagnostics, []);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("an imported command with an entry Clio cannot map is not narrowed and says why once", () => {
	const root = mkdtempSync(join(tmpdir(), "clio-coder-imported-tools-"));
	try {
		const roots = importedRoot(root, {
			"triage.md": "---\nallowed-tools: Bash(gh issue:*), Read, mcp__tracker__create_issue\n---\nTriage $ARGUMENTS\n",
		});
		const loaded = loadPromptTemplates({ roots });
		const template = loaded.items.find((item) => item.name === "triage");
		assert.equal(template?.allowedTools, undefined);
		const warnings = loaded.diagnostics.filter((entry) => entry.type === "warning");
		assert.equal(warnings.length, 1);
		assert.match(warnings[0]?.message ?? "", /triage.*mcp__tracker__create_issue/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// narrowTurnConstraints kept only the turn's mode, so a headless run started in
// answer mode lost it once a template supplied allowed-tools.

test("narrowing keeps the narrower mode of session and turn", () => {
	assert.equal(narrowTurnConstraints({ mode: "answer" }, { allowedTools: ["read"] })?.mode, "answer");
	assert.equal(narrowTurnConstraints({ mode: "proposal" }, { mode: "change" })?.mode, "proposal");
});

// A template's allowed-tools also capped its dispatched workers, so a
// dispatch-only template could not hand a worker write. delegated-tools sets
// that ceiling apart and still only narrows the session's --delegate-tools.

test("a template's delegated-tools become the worker ceiling and never widen the session's", async () => {
	const root = mkdtempSync(join(tmpdir(), "clio-coder-template-delegated-"));
	try {
		const promptRoot = join(root, "prompts");
		mkdirSync(promptRoot, { recursive: true });
		writeFileSync(
			join(promptRoot, "coordinate.md"),
			"---\nallowed-tools: dispatch\ndelegated-tools: read, write\n---\nCoordinate $ARGUMENTS\n",
		);
		const roots = [{ path: promptRoot, scope: "project" as const, trusted: true }];
		const resources = {
			parsePendingSkillRequests: (text: string) => ({ text, pendingSkillRequests: [] }),
			expandPromptTemplate: (text: string) => expandPromptTemplateInput(text, loadPromptTemplates({ roots })),
		} as unknown as ResourcesContract;

		const scoped = await expandSubmitText("/coordinate src", resources, root);
		const unbounded = narrowTurnConstraints(undefined, scoped.constraints);
		assert.equal(turnAllowsTool(unbounded, "write"), false);
		assert.equal(turnDelegatesTool(unbounded, "write"), true);

		const bounded = narrowTurnConstraints({ delegatedTools: ["read", "grep"] }, scoped.constraints);
		assert.deepEqual(bounded?.delegatedTools, ["read"]);
		assert.equal(turnDelegatesTool(bounded, "write"), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// Native template lists resolved only core names, so mcp_zulip__get_messages
// was dropped and the template could not reach the one MCP tool it named. They
// now resolve like --allow-tools: core names canonicalized, MCP names kept.

test("a native template's allowed-tools keep an MCP tool name and reach it through the gateway", () => {
	const root = mkdtempSync(join(tmpdir(), "clio-coder-template-mcp-"));
	try {
		const promptRoot = join(root, "prompts");
		mkdirSync(promptRoot, { recursive: true });
		writeFileSync(join(promptRoot, "chat.md"), "---\nallowed-tools: Read, mcp_zulip__get_messages\n---\nChat\n");
		const loaded = loadPromptTemplates({ roots: [{ path: promptRoot, scope: "project" as const, trusted: true }] });
		const allowedTools = loaded.items.find((item) => item.name === "chat")?.allowedTools;
		assert.deepEqual(allowedTools, ["read", "mcp_zulip__get_messages"]);
		assert.deepEqual(loaded.diagnostics, []);
		assert.equal(turnAllowsTool({ allowedTools }, "gateway"), true);
		assert.equal(turnAllowsTool({ allowedTools }, "mcp_zulip__get_messages"), true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

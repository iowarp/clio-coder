import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { OutputVerbosity } from "../../src/core/defaults.js";
import { ToolNames } from "../../src/core/tool-names.js";
import {
	policyRunningToolFold,
	policyThinkingFold,
	policyToolFold,
	policyWorkerFold,
	resolveFold,
	toggledFold,
	transcriptDetail,
} from "../../src/interactive/transcript-detail.js";
import { TOOL_PRESENTATION, toolPresentationPolicy } from "../../src/tools/presentation.js";

/**
 * The one table `/output` resolves to. Every row of the operator-facing policy
 * is pinned here so a renderer cannot quietly re-derive a different answer.
 */
describe("contracts/transcript detail policy", () => {
	it("maps each verbosity to the full table", () => {
		deepStrictEqual(transcriptDetail("minimal"), {
			toolBody: "folded",
			runningTool: "row",
			thinking: "marker",
			worker: "folded",
			receipt: "none",
			errors: "excerpt",
		});
		deepStrictEqual(transcriptDetail("default"), {
			toolBody: "per-tool",
			runningTool: "row",
			thinking: "folded",
			worker: "origin",
			receipt: "compact",
			errors: "excerpt",
		});
		deepStrictEqual(transcriptDetail("verbose"), {
			toolBody: "expanded",
			runningTool: "body",
			thinking: "rail",
			worker: "expanded",
			receipt: "full",
			errors: "body",
		});
	});

	it("treats an absent verbosity as the balanced default so callers never spell the literal", () => {
		strictEqual(transcriptDetail(undefined), transcriptDetail("default"));
	});

	it("returns the same policy object per level so a frame can key its caches on identity", () => {
		for (const level of ["minimal", "default", "verbose"] as const satisfies ReadonlyArray<OutputVerbosity>) {
			strictEqual(transcriptDetail(level), transcriptDetail(level));
		}
	});

	it("lets the override win and falls back to the policy otherwise", () => {
		strictEqual(resolveFold(undefined, "folded"), "folded");
		strictEqual(resolveFold(undefined, "expanded"), "expanded");
		strictEqual(resolveFold("expanded", "folded"), "expanded");
		strictEqual(resolveFold("folded", "expanded"), "folded");
		strictEqual(toggledFold("folded"), "expanded");
		strictEqual(toggledFold("expanded"), "folded");
	});

	it("routes the balanced tool body through the tool's own presentation and pins the other levels", () => {
		const read = toolPresentationPolicy(ToolNames.Read, { path: "src/a.ts" });
		const edit = toolPresentationPolicy(ToolNames.Edit, { path: "src/a.ts" });
		strictEqual(policyToolFold(transcriptDetail("default"), read), "folded");
		strictEqual(policyToolFold(transcriptDetail("default"), edit), "folded");
		strictEqual(policyToolFold(transcriptDetail("default"), { ...read, foldDefault: "expanded" }), "expanded");
		strictEqual(policyToolFold(transcriptDetail("minimal"), { ...read, foldDefault: "expanded" }), "folded");
		strictEqual(policyToolFold(transcriptDetail("verbose"), read), "expanded");
	});

	it("declares every builtin folded, with the diff kept on mutation rows and excerpts on every failure", () => {
		for (const name of Object.values(ToolNames)) {
			const policy = TOOL_PRESENTATION[name];
			strictEqual(policy?.foldDefault, "folded", name);
			strictEqual(policy?.failureExcerpt, true, name);
			strictEqual(policy?.showDiffWhenFolded, name === ToolNames.Edit || name === ToolNames.Write, name);
		}
		// Dynamic tools and resource reads fold the same way; nothing opens by name.
		strictEqual(toolPresentationPolicy("mcp_custom_tool", {}).foldDefault, "folded");
		strictEqual(toolPresentationPolicy(ToolNames.Read, { path: "skills/x/SKILL.md" }).foldDefault, "folded");
	});

	it("gives running tools, thinking, and workers their level's fold", () => {
		strictEqual(policyRunningToolFold(transcriptDetail("minimal")), "folded");
		strictEqual(policyRunningToolFold(transcriptDetail("default")), "folded");
		strictEqual(policyRunningToolFold(transcriptDetail("verbose")), "expanded");
		strictEqual(policyThinkingFold(transcriptDetail("minimal")), "folded");
		strictEqual(policyThinkingFold(transcriptDetail("default")), "folded");
		strictEqual(policyThinkingFold(transcriptDetail("verbose")), "expanded");
		strictEqual(policyWorkerFold(transcriptDetail("minimal"), false), "folded");
		strictEqual(policyWorkerFold(transcriptDetail("default"), true), "folded");
		strictEqual(policyWorkerFold(transcriptDetail("default"), false), "expanded");
		strictEqual(policyWorkerFold(transcriptDetail("verbose"), true), "expanded");
	});
});

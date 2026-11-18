import { match, ok, rejects, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { ToolNames } from "../../src/core/tool-names.js";
import { formatModelRejection, formatRejection } from "../../src/domains/safety/rejection-feedback.js";
import { createWorkerSafety, createWorkerToolRegistry } from "../../src/engine/worker-tools.js";
import { invokeRegisteredTool } from "../../src/tools/agent-tools.js";

const PIVOT_LINE =
	"Do not retry this action through another tool or a respelled command (other flags, quoting, or a wrapper) unless a hint above names one; pivot or report the blocker.";

describe("formatModelRejection composes the model-facing blocked text", () => {
	it("carries reason, detail lines, hints, and the standing pivot instruction", () => {
		const rejection = formatRejection({
			tool: "read",
			actionClass: "read",
			reasons: ["path .env matches zeroAccessPaths via project-policy"],
			ruleId: "path-policy:zeroAccessPaths",
		});
		const text = formatModelRejection(rejection.short, rejection);
		const lines = text.split("\n");
		strictEqual(lines[0], "read blocked: read", "the verdict reason leads");
		ok(text.includes("path .env matches zeroAccessPaths"), "the policy reason reaches the model");
		ok(text.includes("rule: path-policy:zeroAccessPaths"), "the rule id reaches the model");
		ok(text.includes("This is a hard block; confirmation cannot override it."), "the hard-block hint is included");
		strictEqual(lines[lines.length - 1], PIVOT_LINE, "the pivot instruction closes the message");
	});

	it("deduplicates lines the reason already carries, including bulleted duplicates", () => {
		const rejection = formatRejection({
			tool: "bash",
			actionClass: "execute",
			reasons: ["bash blocked: execute"],
		});
		// The verdict reason equals the short label AND the single detail reason.
		const text = formatModelRejection("bash blocked: execute", rejection);
		const occurrences = text.split("bash blocked: execute").length - 1;
		strictEqual(occurrences, 1, `the duplicate reason renders once, got: ${text}`);
	});

	it("keeps a loop-guard reason as the head when it replaced the generic reason", () => {
		const rejection = formatRejection({ tool: "grep", actionClass: "read", reasons: ["repeated identical call"] });
		const text = formatModelRejection("loop guard: identical call repeated 5 times, stop and change approach", rejection);
		ok(text.startsWith("loop guard: identical call repeated 5 times"), "the guard feedback stays first");
		ok(text.endsWith(PIVOT_LINE));
	});

	it("bounds hostile reason content and always closes with the pivot line", () => {
		const hugePath = "x".repeat(20_000);
		const rejection = formatRejection({
			tool: "read",
			actionClass: "read",
			reasons: [`path ${hugePath} is blocked`, "second\nthird\nfourth"],
		});
		const text = formatModelRejection(rejection.short, rejection);
		const lines = text.split("\n");
		ok(lines.length <= 16, `the message stays within the line cap, got ${lines.length}`);
		for (const line of lines) {
			ok(line.length <= 301, `every line stays within the char cap, got ${line.length}`);
		}
		strictEqual(lines[lines.length - 1], PIVOT_LINE, "the pivot closes the bounded message");
	});

	it("shortens a long quoted command, never the remedy after it", () => {
		const heredoc = `cat > verify_slug_edge.py << EOF\n${"print(slugify('a b'))\n".repeat(12)}EOF`.slice(0, 200);
		const remedy =
			"shell variables, unparsed shell scripts or interpreter source hide which paths it touches from the safety net, so each such command needs your approval";
		const reason = `permission denied by policy: bash \`${heredoc}…\` refused by rule bash-hidden-content; dispatched workers run non-interactively (fleet.permissions.mode=deny); bash requires execute confirmation. redirection \`<< EOF\` is recognized only to /dev/null or between descriptors ${remedy}`;
		// A parked call's answer restates the reason as its detail; the heredoc copy must fold and deduplicate.
		const answered = { short: "bash blocked: execute was not approved", detail: reason, hints: [] };
		const lines = formatModelRejection(reason, answered).split("\n");
		for (const line of lines) ok(line.length <= 300, `line within the cap: ${line}`);
		const text = lines.join("\n");
		ok(text.includes(`${remedy}`), `the remedy survives whole: ${text}`);
		strictEqual(text.split("verify_slug_edge.py").length, 2, `the refusal reads once: ${text}`);
		const cap = `permission refusal limit reached: 1) bash \`${heredoc}…\` refused by rule r; 2) bash \`${heredoc}…\` refused by rule r`;
		const capText = formatModelRejection(cap, { ...answered, detail: cap });
		strictEqual(capText.split("2) bash").length, 2, `each capped refusal reads once: ${capText}`);
		ok(text.includes("redirection `<< EOF` is recognized only to /dev/null"), text);
		ok(text.startsWith("permission denied by policy: bash `cat > verify_slug_edge.py << EOF ⏎ print("), text);
		ok(lines.length <= 4, `the heredoc body stays on its line: ${text}`);
	});

	it("keeps the pivot line last and single even when the detail pre-seeds it", () => {
		const rejection = formatRejection({
			tool: "bash",
			actionClass: "execute",
			reasons: [PIVOT_LINE, "trailing detail"],
		});
		const text = formatModelRejection("bash blocked: execute", rejection);
		const lines = text.split("\n");
		strictEqual(lines[lines.length - 1], PIVOT_LINE, `the pivot stays last, got: ${text}`);
		strictEqual(text.split(PIVOT_LINE).length - 1, 1, "the pivot renders exactly once");
		ok(text.includes("trailing detail"), text);
	});

	it("degrades to reason plus pivot when no rejection is attached", () => {
		const text = formatModelRejection("tool not registered: nope");
		strictEqual(text, `tool not registered: nope\n${PIVOT_LINE}`);
	});
});

describe("blocked tool errors surface recovery guidance to the model", () => {
	it("a zero-access read rejects with the policy reason, not just the short label", async () => {
		const registry = createWorkerToolRegistry(undefined, createWorkerSafety({ cwd: process.cwd() }), undefined, []);
		await rejects(
			invokeRegisteredTool(registry, ToolNames.Read, { path: ".env" }),
			(err: unknown) => {
				ok(err instanceof Error);
				match(err.message, /read blocked/, "the terse label still leads");
				ok(err.message.includes("\n"), `the model text carries more than the one-line label, got: ${err.message}`);
				ok(err.message.includes(PIVOT_LINE), "the pivot instruction reaches the model");
				return true;
			},
			"a blocked read must reject with composed model guidance",
		);
	});
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { labelsFor } from "./report-labels.mjs";

const block = (lines) =>
	`Body.\n\n<details>\n\n\`\`\`clio-coder-report\nv: 1\n${lines.join("\n")}\n\`\`\`\n\n</details>\n`;

test("a full block maps to its labels, and a repeat fingerprint gets one comment", () => {
	const body = block([
		"kind: bug",
		"area: tui",
		"os: macos",
		"bundle: gist:0a1b2c#bundle.json",
		"fingerprint: fp_0123456789ab",
	]);
	const result = labelsFor({ title: "fix: x", body, author_association: "NONE" }, { sameFingerprint: 12 });
	assert.deepEqual(result.add.sort(), [
		"area:tui",
		"bug",
		"has-bundle",
		"needs-repro",
		"needs-triage",
		"os:macos",
		"via:report",
	]);
	assert.equal(result.comment, "Same fingerprint as #12.");
});

test("a hostile body is text: unknown keys and values add nothing", () => {
	const body = block([
		"kind: $(rm -rf /)",
		"area: nonsense",
		// biome-ignore lint/suspicious/noTemplateCurlyInString: a literal workflow expression is the hostile input
		"os: ${{ secrets.X }}",
		"label: wontfix",
		"bundle: `$(id)`",
	]);
	const result = labelsFor({ title: "feat: y", body, author_association: "OWNER" });
	assert.deepEqual(result, { add: ["via:report"], comment: null });
});

test("a web-form issue with no block gets its surface and platform labels", () => {
	const body =
		"### What happened\n\nIt broke.\n\n### Steps, if you have them\n\n_No response_\n\n### Surface\n\nEditor over ACP\n\n### Operating system\n\nWindows\n";
	const result = labelsFor({ title: "fix: z", body, author_association: "COLLABORATOR" });
	assert.deepEqual(result.add.sort(), ["area:acp", "needs-repro", "os:windows"]);
});

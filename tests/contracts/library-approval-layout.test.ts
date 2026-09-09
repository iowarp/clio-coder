import { ok } from "node:assert/strict";
import { test } from "node:test";
import { stripTerminalSequences, visibleWidth } from "../../src/engine/tui.js";
import type { FleetRunPreview } from "../../src/interactive/fleet-run-preview.js";
import { formatFleetRunApprovalBody } from "../../src/interactive/overlays/fleet-run-approval.js";
import { formatLibraryInstallConfirmBody } from "../../src/interactive/overlays/library-install-confirm.js";

for (const columns of [80, 120, 160])
	test(`approval retains complete source, path, digest and argv at ${columns} columns`, () => {
		const path = `/project/${"long-directory/".repeat(20)}DESTINATION_SUFFIX`;
		const sourceUrl = `https://example.org/${"source/".repeat(20)}SOURCE_SUFFIX`;
		const sha256 = "1234567890abcdef".repeat(4);
		const rows = formatLibraryInstallConfirmBody(
			{
				entryRef: "plugin:fixture",
				writes: [{ ref: "plugin:fixture", path, sourceUrl, sha256 }],
				requirements: [],
				satisfied: [],
			},
			columns - 12,
		).map(stripTerminalSequences);
		for (const row of rows) ok(visibleWidth(row) <= columns - 12);
		const text = rows.join("").replace(/\s/g, "");
		for (const value of [path, sourceUrl, sha256]) ok(text.includes(value), `lost ${value}`);
		const argv = ["python3", path, "--scope", `${"review ".repeat(160)}ARGUMENT_SUFFIX`];
		const preview = {
			name: "fixture",
			planHash: "a".repeat(64),
			waves: [{ index: 0, steps: [{ kind: "code", stepId: "check", commandId: "check", scope: "readonly", argv }] }],
			budget: { contractUsd: null, ceilingUsd: 2, currentUsd: 0 },
		} as unknown as FleetRunPreview;
		const seen: string[] = [];
		for (let scroll = 0; scroll < 250; scroll += 10)
			seen.push(...formatFleetRunApprovalBody({ ok: true, preview }, columns - 12, scroll).map(stripTerminalSequences));
		for (const row of seen) ok(visibleWidth(row) <= columns - 12);
		ok(seen.join("").includes("DESTINATION_SUFFIX"));
		ok(seen.join("").includes("ARGUMENT_SUFFIX"));
	});

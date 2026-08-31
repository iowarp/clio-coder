import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import {
	dispatchSlashCommand,
	formatReceiptVerificationBlock,
	parseSlashCommand,
	type SlashCommandContext,
} from "../../src/interactive/slash-commands.js";

describe("contracts/view-verify-command", () => {
	it("renders an actionable block and warns on compromised trust", () => {
		const report = {
			ok: true as const,
			receiptPath: "/state/receipts/run-verify.json",
			sealedDigest: `sha256:${"a".repeat(64)}`,
			trustSummary:
				"trust v1: compromised; sealed; inferred: validation claimed, none observed; not independently reviewed; mediated; context recorded; completion not recorded",
			compromised: true,
			checks: [
				{ name: "receipt file", ok: true, evidence: "/state/receipts/run-verify.json" },
				{
					name: "trust validationGrounding",
					ok: false,
					evidence: "inferred: validation claimed, none observed; run_receipt:run-verify",
				},
			],
		};
		const notices: Array<{ level: string; text: string }> = [];
		const ctx = {
			verifyReceipt: () => report,
			notice: (level: string, text: string) => notices.push({ level, text }),
		} as unknown as SlashCommandContext;

		dispatchSlashCommand(parseSlashCommand("/view verify run-verify"), ctx);

		deepStrictEqual(notices, [{ level: "warn", text: formatReceiptVerificationBlock("run-verify", report) }]);
		strictEqual(
			notices[0]?.text,
			[
				"verify compromised run-verify",
				"receipt  /state/receipts/run-verify.json",
				`digest   sha256:${"a".repeat(64)}`,
				`evidence ${report.trustSummary}`,
				"checks",
				"  ✓ receipt file: /state/receipts/run-verify.json",
				"  ✗ trust validationGrounding: inferred: validation claimed, none observed; run_receipt:run-verify",
			].join("\n"),
		);
	});

	it("preserves the /view verify argument and refusal shapes", () => {
		deepStrictEqual(parseSlashCommand("/view verify run-verify"), { kind: "view-verify", runId: "run-verify" });
		deepStrictEqual(parseSlashCommand("/view verify"), { kind: "view-usage" });
		deepStrictEqual(parseSlashCommand("/view verify run-verify extra"), { kind: "view-usage" });
	});
});

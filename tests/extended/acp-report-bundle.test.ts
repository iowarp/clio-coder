import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TelemetryContext } from "../../src/core/telemetry/context.js";
import { consentText, createReportTextHost, readReportBundle } from "../../src/domains/report/index.js";
import { openCallJournal } from "../../src/domains/telemetry/call-journal.js";
import { telemetrySessionDirectory } from "../../src/domains/telemetry/index.js";
import { type AcpCommandHost, acpCommandControl } from "../../src/engine/acp/commands.js";

const SESSION = "acp-report-session";

/** A flushed telemetry journal for the session, so a bundle has something to carry. */
async function liveSession(stateDir: string): Promise<void> {
	const context = { sessionId: SESSION, agent: { role: "main", id: SESSION } } as TelemetryContext;
	const journal = await openCallJournal({
		directory: telemetrySessionDirectory(stateDir, SESSION),
		context,
		writer: { clioCoderVersion: "0.7.1", piVersion: "0.0.0-test" },
	});
	journal.enqueue({
		kind: "session.opened",
		data: {},
		ctx: context,
		wallMs: Date.now(),
		mono: performance.now(),
	} as Parameters<typeof journal.enqueue>[0]);
	await journal.flush();
	await journal.close();
}

function control(stateDir: string) {
	const reportHost = createReportTextHost({
		stateDir,
		cwd: () => stateDir,
		session: () => ({ id: SESSION }),
		env: {},
		findGh: () => null,
		browserAvailable: () => false,
		run: async () => ({ exitCode: 1, stdout: "", stderr: "", timedOut: false }),
	});
	return acpCommandControl({
		dispatch: {} as AcpCommandHost["dispatch"],
		bus: {} as AcpCommandHost["bus"],
		providers: {} as AcpCommandHost["providers"],
		reportHost,
	});
}

const SUMMARY = "the diff view is empty after every edit in a long session";
const argv = ["bug", "--bundle", "mechanics", "--consent", "debug", ...SUMMARY.split(" ")];

test("/report --bundle over ACP asks the client and attaches nothing without consent", async () => {
	const stateDir = mkdtempSync(join(tmpdir(), "acp-report-bundle-"));
	const asked: string[][] = [];
	const declined = await control(stateDir).invoke({
		command: "report",
		argv,
		askConsent: async (_title, consent) => {
			asked.push([...consent]);
			return false;
		},
	});
	assert.deepEqual(asked, [[consentText().debug]], "the client is shown the consent text");
	assert.equal(declined.level, "warn");
	assert.match(declined.lines.join("\n"), /Nothing was attached/);
	assert.equal(declined._meta, undefined, "no draft was made");

	const unsupported = await control(stateDir).invoke({ command: "report", argv });
	assert.match(unsupported.lines.join("\n"), /Nothing was attached/);
});

test("/report --bundle over ACP previews the bundle on consent and keeps it only on send", async () => {
	const stateDir = mkdtempSync(join(tmpdir(), "acp-report-bundle-"));
	const acp = control(stateDir);
	await liveSession(stateDir);
	const preview = await acp.invoke({ command: "report", argv, askConsent: async () => true });
	const text = preview.lines.join("\n");
	const draftId = preview._meta?.["clio-coder/report"].draftId ?? "";
	assert.match(draftId, /^rpt_/, text);
	assert.ok(preview.lines.includes(`Title: fix: ${SUMMARY}`), "flags are not summary text");
	assert.match(text, /A diagnostic bundle is attached/);
	assert.ok(text.includes(consentText().debug));
	assert.equal(readReportBundle(stateDir, draftId), null, "a preview writes no bundle");

	const sent = await acp.invoke({ command: "report", argv: ["send", draftId] });
	assert.notEqual(
		readReportBundle(stateDir, draftId),
		null,
		`sending keeps the consented bundle: ${sent.lines.join("\n")}`,
	);
});

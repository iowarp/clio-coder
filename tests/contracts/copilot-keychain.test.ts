import { deepStrictEqual, match, ok, strictEqual, throws } from "node:assert/strict";
import { after, before, test } from "node:test";
import * as realSdk from "@github/copilot-sdk";
import { runClioCommand } from "../../src/cli/clio.js";
import { copilotSignInFinding } from "../../src/cli/doctor-copilot.js";
import { COPILOT_HEADLESS_LOGIN_FIX, copilotKeychainAllowed } from "../../src/core/copilot-keychain.js";
import { CopilotLoginRequiredError, createCopilotClient } from "../../src/engine/copilot/client.js";
import type { CopilotSdkModule } from "../../src/engine/copilot/sdk-module.js";
import { type IsolatedClioEnv, isolateClioEnv } from "../harness/scratch-env.js";

let env: IsolatedClioEnv;
before(async () => {
	env = await isolateClioEnv("clio-copilot-keychain-");
});
after(() => env.restore());

type RuntimeEnv = Record<string, string | undefined>;
const runtimeEnv = (client: unknown): RuntimeEnv => (client as { buildRuntimeEnv(): RuntimeEnv }).buildRuntimeEnv();

// The real pinned SDK, constructed but never started: buildRuntimeEnv is the environment its runtime child gets.
test("the runtime child's environment opens the keychain only when allowed and keeps every other empty-mode setting", () => {
	const closed = runtimeEnv(createCopilotClient(realSdk, false));
	const open = runtimeEnv(createCopilotClient(realSdk, true));
	strictEqual(closed.COPILOT_DISABLE_KEYTAR, "1");
	strictEqual("COPILOT_DISABLE_KEYTAR" in open, false);
	strictEqual(open.COPILOT_RUNTIME_PROCESS_FILE_LOGGING, undefined);
	const { COPILOT_DISABLE_KEYTAR: _, ...rest } = closed;
	deepStrictEqual(open, rest);
});

test("an SDK that moved the keychain switch fails loudly instead of silently keeping the keychain closed", () => {
	const withoutMethod = { CopilotClient: class {} } as unknown as CopilotSdkModule;
	throws(() => createCopilotClient(withoutMethod, true), /no longer has buildRuntimeEnv/);
	const unexpectedEnv = {
		CopilotClient: class {
			buildRuntimeEnv() {
				return {};
			}
		},
	} as unknown as CopilotSdkModule;
	const client = createCopilotClient(unexpectedEnv, true);
	throws(() => runtimeEnv(client), /no longer sets COPILOT_DISABLE_KEYTAR/);
	// Closed needs no override, so an SDK change cannot break headless runs.
	strictEqual(runtimeEnv(createCopilotClient(unexpectedEnv, false)).COPILOT_DISABLE_KEYTAR, undefined);
});

// Module state is process-wide and only ever opens, so the closed surface is checked first.
test("headless `run` keeps the keychain closed even under the interactive marker; ACP opens it", async () => {
	const marker = process.env.CLIO_CODER_INTERACTIVE;
	process.env.CLIO_CODER_INTERACTIVE = "1";
	try {
		const seen: boolean[] = [];
		const boot = async () => {
			seen.push(copilotKeychainAllowed());
			return { exitCode: 0, bootTimeMs: 0 };
		};
		await runClioCommand({ headless: { prompt: "fixture" } }, { bootOrchestrator: boot });
		await runClioCommand({ acp: {} }, { bootOrchestrator: boot });
		deepStrictEqual(seen, [false, true]);
	} finally {
		if (marker === undefined) delete process.env.CLIO_CODER_INTERACTIVE;
		else process.env.CLIO_CODER_INTERACTIVE = marker;
	}
});

test("a closed keychain's not-signed-in error and doctor's keychain-only row name the exact headless fix", () => {
	const closed = new CopilotLoginRequiredError("Not authenticated", true).message;
	ok(closed.includes(COPILOT_HEADLESS_LOGIN_FIX));
	match(closed, /`clio-coder run`, fleet workers/);
	strictEqual(new CopilotLoginRequiredError("Not authenticated").message.includes(COPILOT_HEADLESS_LOGIN_FIX), false);
	const row = copilotSignInFinding({ kind: "keychain-only", login: "octo" });
	strictEqual(row.level, "warn");
	ok(row.detail.includes(COPILOT_HEADLESS_LOGIN_FIX));
	strictEqual(copilotSignInFinding({ kind: "signed-in", login: "octo", authType: "gh-cli" }).ok, true);
	match(copilotSignInFinding({ kind: "not-signed-in", keychainChecked: false }).detail, /keychain was not checked/);
	strictEqual(copilotSignInFinding({ kind: "not-signed-in", keychainChecked: true }).ok, false);
	strictEqual(copilotSignInFinding({ kind: "not-signed-in", keychainChecked: true }, false).level, "warn");
});

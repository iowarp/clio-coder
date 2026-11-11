import { ok, strictEqual } from "node:assert/strict";
import { it } from "node:test";
import { createRedactionTally } from "../../src/domains/evidence/redact.js";
import { redactTelemetryValue } from "../../src/domains/telemetry/objects.js";

it("a settings snapshot keeps the apiKeyEnvVar name and still withholds credential values", () => {
	const settings = {
		targets: [
			{
				id: "proxy",
				auth: { apiKeyEnvVar: "OPENAI_API_KEY", apiKey: "plain-words-passphrase" },
				headers: { Authorization: "Bearer abc" },
			},
		],
	};
	const out = redactTelemetryValue(settings, createRedactionTally(), true);
	const target = out.targets[0];
	strictEqual(target?.auth.apiKeyEnvVar, "OPENAI_API_KEY");
	ok(target?.auth.apiKey.startsWith("[redacted:"));
	strictEqual(target?.headers.Authorization, "[redacted:headers]");
});

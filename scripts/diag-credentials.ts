/**
 * Phase 4 slice 3 diag. Exercises the credentials reader/writer end-to-end
 * against a hermetic CLIO_HOME, asserts file mode 0600, verifies that key
 * values never leak to stderr/stdout, and cross-checks credentialsPresent()
 * wiring against the provider catalog.
 */

import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const failures: string[] = [];

function check(label: string, ok: boolean, detail?: string): void {
	if (ok) {
		process.stdout.write(`[diag-credentials] OK   ${label}\n`);
		return;
	}
	failures.push(detail ? `${label}: ${detail}` : label);
	process.stderr.write(`[diag-credentials] FAIL ${label}${detail ? ` — ${detail}` : ""}\n`);
}

async function run(): Promise<void> {
	const home = mkdtempSync(join(tmpdir(), "clio-diag-credentials-"));
	const ENV_KEYS = [
		"CLIO_HOME",
		"CLIO_DATA_DIR",
		"CLIO_CONFIG_DIR",
		"CLIO_CACHE_DIR",
		"ANTHROPIC_API_KEY",
		"OPENAI_API_KEY",
		"GOOGLE_API_KEY",
		"GROQ_API_KEY",
		"MISTRAL_API_KEY",
		"OPENROUTER_API_KEY",
	] as const;
	const snapshot = new Map<string, string | undefined>();
	for (const k of ENV_KEYS) snapshot.set(k, process.env[k]);
	for (const k of ENV_KEYS) {
		if (k !== "CLIO_HOME") delete process.env[k];
	}
	process.env.CLIO_HOME = home;

	// Capture stdout/stderr to audit for key leakage.
	const writes: string[] = [];
	const origStdoutWrite = process.stdout.write.bind(process.stdout);
	const origStderrWrite = process.stderr.write.bind(process.stderr);
	type WriteFn = typeof process.stdout.write;
	const wrap = (orig: WriteFn): WriteFn => {
		const wrapper = ((chunk: unknown, ...rest: unknown[]) => {
			if (typeof chunk === "string") writes.push(chunk);
			else if (chunk instanceof Uint8Array) writes.push(Buffer.from(chunk).toString("utf8"));
			// @ts-expect-error — passthrough to original
			return orig(chunk, ...rest);
		}) as unknown as WriteFn;
		return wrapper;
	};
	process.stdout.write = wrap(origStdoutWrite);
	process.stderr.write = wrap(origStderrWrite);

	const ANTHROPIC_KEY = "sk-ant-test-DIAGP4S3-do-not-log-this";
	const OPENAI_KEY = "sk-openai-test-DIAGP4S3-also-not-this";

	try {
		const { resetXdgCache } = await import("../src/core/xdg.js");
		resetXdgCache();

		const { openCredentialStore, credentialsPresent } = await import("../src/domains/providers/credentials.js");

		const store = openCredentialStore();
		const credsPath = join(home, "credentials.yaml");

		// 1. Fresh store — no entry.
		check("fresh:get-anthropic-null", store.get("anthropic") === null);

		// 2. set creates file with mode 0600.
		store.set("anthropic", ANTHROPIC_KEY);
		const modeAfterFirstSet = statSync(credsPath).mode & 0o777;
		check("set:file-mode-0600", modeAfterFirstSet === 0o600, `mode=${modeAfterFirstSet.toString(8)}`);

		// 3. get returns the entry with correct key.
		const got = store.get("anthropic");
		check(
			"get:entry-present",
			got !== null && got.providerId === "anthropic" && got.key === ANTHROPIC_KEY && got.source === "file",
			`got=${JSON.stringify(got === null ? null : { ...got, key: "<redacted>" })}`,
		);
		check("get:updatedAt-iso", got !== null && typeof got.updatedAt === "string" && got.updatedAt.length > 0);

		// 4. list omits key field.
		const listed = store.list();
		const listedAnthropic = listed.find((e) => e.providerId === "anthropic");
		check(
			"list:entry-present",
			listedAnthropic !== undefined && listedAnthropic.source === "file",
			`listed=${JSON.stringify(listed)}`,
		);
		// biome-ignore lint/suspicious/noExplicitAny: runtime shape audit — the type hides `key` on purpose.
		const listedAny = listedAnthropic as any;
		check("list:no-key-field", listedAny !== undefined && !("key" in listedAny));

		// 5. second set, file still mode 0600.
		store.set("openai", OPENAI_KEY);
		const modeAfterSecondSet = statSync(credsPath).mode & 0o777;
		check("set:file-mode-still-0600", modeAfterSecondSet === 0o600, `mode=${modeAfterSecondSet.toString(8)}`);
		check("get:openai-after-second-set", store.get("openai")?.key === OPENAI_KEY);
		check("get:anthropic-still-present", store.get("anthropic")?.key === ANTHROPIC_KEY);

		// 6. remove deletes entry.
		store.remove("anthropic");
		check("remove:anthropic-gone", store.get("anthropic") === null);
		check("remove:openai-retained", store.get("openai")?.key === OPENAI_KEY);

		// 7. credentialsPresent reports env-var names for providers with entries.
		const present = credentialsPresent();
		check(
			"credentialsPresent:openai-from-file",
			present.has("OPENAI_API_KEY"),
			`present=${JSON.stringify([...present])}`,
		);
		check("credentialsPresent:anthropic-absent", !present.has("ANTHROPIC_API_KEY"));

		// 7b. env-var present takes precedence / contributes independently.
		const groqEnv: string = "GROQ_API_KEY";
		process.env[groqEnv] = "sk-groq-env-DIAGP4S3";
		const presentWithEnv = credentialsPresent();
		check("credentialsPresent:groq-from-env", presentWithEnv.has("GROQ_API_KEY"));
		delete process.env[groqEnv];

		// 8. log output must not contain any key value.
		const captured = writes.join("");
		check(
			"audit:anthropic-key-absent-in-output",
			!captured.includes(ANTHROPIC_KEY),
			`found occurrence count=${(captured.match(new RegExp(ANTHROPIC_KEY.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) || []).length}`,
		);
		check(
			"audit:openai-key-absent-in-output",
			!captured.includes(OPENAI_KEY),
			`found occurrence count=${(captured.match(new RegExp(OPENAI_KEY.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) || []).length}`,
		);

		// 9. Source audit: credentials.ts atomic-writer must open the tmp file
		// at mode 0o600 so the secret never lives on disk under a wider mode.
		// Re-checking the file mode after set() is necessary but not sufficient
		// because umask leaves the tmp file 0o644 during the write/rename window.
		const { resolvePackageRoot } = await import("../src/core/package-root.js");
		const credsSource = readFileSync(join(resolvePackageRoot(), "src/domains/providers/credentials.ts"), "utf8");
		check(
			"credentials:tmp-opens-at-0o600",
			/openSync\([^)]*,\s*"wx",\s*0o600\)/.test(credsSource),
			"credentials.ts atomic writer not using 0o600 open mode",
		);
		check(
			"credentials:does-not-import-engine-atomicWrite",
			!/from\s+"\.\.\/\.\.\/engine\/session\.js"/.test(credsSource),
			"credentials.ts still imports atomicWrite from engine/session",
		);
	} finally {
		process.stdout.write = origStdoutWrite;
		process.stderr.write = origStderrWrite;
		for (const [k, v] of snapshot) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
		try {
			rmSync(home, { recursive: true, force: true });
		} catch {
			// best-effort cleanup
		}
	}
}

async function main(): Promise<void> {
	await run();
	if (failures.length > 0) {
		process.stderr.write(`[diag-credentials] FAILED ${failures.length} check(s)\n`);
		process.exit(1);
	}
	process.stdout.write("[diag-credentials] PASS\n");
}

main().catch((err) => {
	process.stderr.write(`[diag-credentials] crashed: ${err instanceof Error ? err.stack : String(err)}\n`);
	process.exit(1);
});

/**
 * What a live driver's scratch home gives the run, and what it refuses to
 * leave behind.
 *
 * Three guarantees are pinned here, each because getting it wrong is silent:
 *
 * 1. Credentials are scoped to the selected target. One entry, converted to
 *    the current store shape, and no other profile the operator has. A stored
 *    `!command` reference is resolved once here so the run never executes it,
 *    and the value it produced is known to the redactor.
 * 2. The environment is built, not inherited. Only BASE_ENV_PASSTHROUGH, the
 *    home's own directory variables, and the credential variables this
 *    target's resolver would actually consult reach the child. An ambient key
 *    for a provider this target does not use stays behind. What is retained
 *    for diagnosis (a failed run's tree, its transcripts) holds no secret.
 * 3. Cleanup is armed before the body and cannot be skipped. A thrown setup,
 *    a thrown body, or a terminating signal all remove the credentials, and a
 *    tree whose secrets cannot be removed is deleted rather than retained.
 *
 * The lease guards get their own section because they gate a recursive
 * delete. Nothing inside a candidate tree may authorize its own removal, so
 * the tests include a forged lease that names its own parent.
 *
 * The binary also enforces CLIO_CODER_REQUIRE_HOME_PREFIX: any resolved Clio
 * directory outside CLIO_CODER_HOME is fatal. The home therefore owns TMPDIR
 * as well as every CLIO_CODER_* directory.
 */
import { ok, strictEqual, throws } from "node:assert/strict";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { parse, stringify } from "yaml";
import { type IsolatedClioEnv, isolateClioEnv } from "../../../tests/harness/scratch-env.js";
import { runNodeScript } from "../../../tests/harness/spawn.js";
import {
	BASE_ENV_PASSTHROUGH,
	isLiveHomeDir,
	LAUNCHER_SHIM,
	LEASE_FILE,
	LIVE_HOME_PREFIX,
	type LiveHome,
	type LiveHomeOptions,
	LiveUsageError,
	parseLiveArgs,
	prepareLiveHome,
	REDACTED,
	releaseLiveHome,
	sweepExpiredLiveHomes,
	withLiveHome,
} from "../live-target.js";

const FAKE_TARGET = {
	id: "fake-live",
	runtime: "openai-compat",
	url: "http://127.0.0.1:9",
	defaultModel: "fake-model",
};

/** Unique per process so the config resolver's !command cache cannot serve a stale answer. */
const COMMAND_OUTPUT = `command-key-${process.pid}`;

describe("contracts/live home", { concurrency: false }, () => {
	let operator: IsolatedClioEnv;
	let configDir: string;
	/** Every scratch home a test makes lands here, so nothing touches the machine tmpdir. */
	let scratchRoot: string;
	const opened: LiveHome[] = [];

	function writeOperatorSettings(targets: ReadonlyArray<Record<string, unknown>>): void {
		writeFileSync(join(configDir, "settings.yaml"), stringify({ version: 1, targets }), "utf8");
	}

	function writeOperatorCredentials(store: Record<string, unknown>): void {
		writeFileSync(join(configDir, "credentials.yaml"), stringify(store), "utf8");
	}

	/** prepareLiveHome plus bookkeeping so a failing assertion still removes the tree. */
	function prepare(argv: ReadonlyArray<string>, options: Partial<LiveHomeOptions> = {}): LiveHome {
		const home = prepareLiveHome(parseLiveArgs(argv), { prefix: "clio-live-home-test-", ...options });
		opened.push(home);
		return home;
	}

	beforeEach(async () => {
		// The "operator" config the driver reads --target from.
		operator = await isolateClioEnv("clio-live-home-operator-");
		configDir = process.env.CLIO_CODER_CONFIG_DIR as string;
		mkdirSync(configDir, { recursive: true });
		writeOperatorSettings([FAKE_TARGET]);
		writeOperatorCredentials({ version: 2, entries: {} });
		// Scratch homes are made in os.tmpdir(); point it somewhere this test owns
		// so the lease sweep can never reach a real operator's home.
		scratchRoot = mkdtempSync(join(tmpdir(), "clio-live-home-root-"));
		process.env.TMPDIR = scratchRoot;
	});

	afterEach(() => {
		for (const home of opened.splice(0)) rmSync(home.dir, { recursive: true, force: true });
		rmSync(scratchRoot, { recursive: true, force: true });
		// Restores TMPDIR and every other variable a test set.
		operator.restore();
	});

	// -----------------------------------------------------------------------
	// The tree itself
	// -----------------------------------------------------------------------

	it("keeps the five Clio directories and TMPDIR under one scratch root", () => {
		const home = prepare(["--target", "fake-live"]);
		const root = home.dir;
		for (const key of [
			"CLIO_CODER_HOME",
			"CLIO_CODER_CONFIG_DIR",
			"CLIO_CODER_DATA_DIR",
			"CLIO_CODER_STATE_DIR",
			"CLIO_CODER_CACHE_DIR",
			"TMPDIR",
		]) {
			const value = home.env[key];
			ok(typeof value === "string" && resolve(value).startsWith(root), `${key}=${String(value)} must sit under ${root}`);
		}
		strictEqual(home.env.CLIO_CODER_REQUIRE_HOME_PREFIX, "1");
		ok(
			resolve(home.workspace).startsWith(root) && existsSync(home.workspace),
			"the default cwd is an empty dir under the home",
		);
		strictEqual(readdirSync(home.workspace).length, 0, "the workspace starts empty");
		ok(existsSync(home.env.TMPDIR as string), "TMPDIR is created, not merely named");
		strictEqual(home.target.id, "fake-live");
		strictEqual(home.model, "fake-model");
		// An operator store with no entry for this target's provider copies nothing.
		// The old harness copied the whole file; this one selects one entry or none.
		ok(!existsSync(join(home.configDir, "credentials.yaml")), "an unmatched provider copies no credential at all");
	});

	it("the home, its settings, and its credentials are readable only by the operator", () => {
		writeOperatorCredentials({ version: 2, entries: { "openai-compat": { type: "api_key", key: "sk-mode-check" } } });
		const home = prepare(["--target", "fake-live"]);
		const mode = (path: string): string => (statSync(path).mode & 0o777).toString(8);
		strictEqual(mode(home.dir), "700");
		strictEqual(mode(join(home.configDir, "settings.yaml")), "600");
		strictEqual(mode(join(home.configDir, "credentials.yaml")), "600");
		strictEqual(mode(join(home.dir, LEASE_FILE)), "600");
	});

	// -----------------------------------------------------------------------
	// Credential scoping
	// -----------------------------------------------------------------------

	function copiedEntries(home: LiveHome): Record<string, Record<string, unknown>> {
		const path = join(home.configDir, "credentials.yaml");
		const parsed = parse(readFileSync(path, "utf8")) as { version?: number; entries?: Record<string, never> };
		strictEqual(parsed.version, 2, "the copy is always written in the current store shape");
		return (parsed.entries ?? {}) as Record<string, Record<string, unknown>>;
	}

	it("copies the one entry apiKeyRef names and leaves every other profile at home", () => {
		writeOperatorCredentials({
			version: 2,
			entries: {
				"selected-provider": { type: "api_key", key: "sk-selected", updatedAt: "2026-01-01T00:00:00.000Z" },
				"other-provider": { type: "api_key", key: "sk-other-secret" },
				anthropic: { type: "oauth", access: "acc-other", refresh: "ref-other", expires: 1 },
			},
		});
		writeOperatorSettings([{ ...FAKE_TARGET, auth: { apiKeyRef: "selected-provider" } }]);
		const home = prepare(["--target", "fake-live"]);
		const entries = copiedEntries(home);
		strictEqual(Object.keys(entries).join(","), "selected-provider");
		strictEqual(entries["selected-provider"]?.key, "sk-selected");
		const text = readFileSync(join(home.configDir, "credentials.yaml"), "utf8");
		for (const foreign of ["sk-other-secret", "acc-other", "ref-other", "other-provider"]) {
			ok(!text.includes(foreign), `${foreign} reached the run's credential store`);
		}
	});

	it("oauthProfile wins over apiKeyRef, and the OAuth entry travels whole", () => {
		writeOperatorCredentials({
			version: 2,
			entries: {
				"by-key": { type: "api_key", key: "sk-not-this-one" },
				"by-oauth": { type: "oauth", access: "acc-live", refresh: "ref-live", expires: 4102444800000 },
			},
		});
		writeOperatorSettings([{ ...FAKE_TARGET, auth: { apiKeyRef: "by-key", oauthProfile: "by-oauth" } }]);
		const home = prepare(["--target", "fake-live"]);
		const entries = copiedEntries(home);
		strictEqual(Object.keys(entries).join(","), "by-oauth");
		strictEqual(entries["by-oauth"]?.type, "oauth");
		strictEqual(entries["by-oauth"]?.access, "acc-live");
		strictEqual(entries["by-oauth"]?.refresh, "ref-live");
		strictEqual(home.redact("saw acc-live and ref-live"), `saw ${REDACTED} and ${REDACTED}`);
	});

	it("falls back to the runtime's provider id when the target names no profile", () => {
		writeOperatorCredentials({
			version: 2,
			entries: {
				"openai-compat": { type: "api_key", key: "sk-runtime-default" },
				openai: { type: "api_key", key: "sk-wrong" },
			},
		});
		const home = prepare(["--target", "fake-live"]);
		strictEqual(Object.keys(copiedEntries(home)).join(","), "openai-compat");
		ok(!readFileSync(join(home.configDir, "credentials.yaml"), "utf8").includes("sk-wrong"));
	});

	it("reads a v1 entry and writes it back in the v2 shape", () => {
		writeOperatorCredentials({
			version: 1,
			entries: { "openai-compat": { key: "sk-v1-value", updatedAt: "2026-02-02T00:00:00.000Z" } },
		});
		const home = prepare(["--target", "fake-live"]);
		const entry = copiedEntries(home)["openai-compat"];
		strictEqual(entry?.type, "api_key");
		strictEqual(entry?.key, "sk-v1-value");
		strictEqual(entry?.updatedAt, "2026-02-02T00:00:00.000Z");
	});

	it("resolves a stored !command once and copies its output, never the command", () => {
		writeOperatorCredentials({
			version: 2,
			entries: { "openai-compat": { type: "api_key", key: `!printf %s ${COMMAND_OUTPUT}` } },
		});
		const home = prepare(["--target", "fake-live"]);
		const text = readFileSync(join(home.configDir, "credentials.yaml"), "utf8");
		strictEqual(copiedEntries(home)["openai-compat"]?.key, COMMAND_OUTPUT);
		ok(!text.includes("!printf"), "the run was handed a command to execute instead of a value");
		// The value the command produced is what the redactor now hides.
		strictEqual(home.redact(`key=${COMMAND_OUTPUT} end`), `key=${REDACTED} end`);
	});

	it("keeps an env-reference key as a reference and passes the variable it names", () => {
		// biome-ignore lint/suspicious/noTemplateCurlyInString: Clio's own config-value syntax, stored literally.
		const reference = "${CLIO_TEST_STORED_REF}";
		process.env.CLIO_TEST_STORED_REF = "sk-from-referenced-var";
		writeOperatorCredentials({
			version: 2,
			entries: { "openai-compat": { type: "api_key", key: reference } },
		});
		const home = prepare(["--target", "fake-live"]);
		// The reference travels; the run resolves it from the environment it is given.
		strictEqual(copiedEntries(home)["openai-compat"]?.key, reference);
		strictEqual(home.env.CLIO_TEST_STORED_REF, "sk-from-referenced-var");
		ok(home.authEnvNames.includes("CLIO_TEST_STORED_REF"));
		strictEqual(home.redact("sk-from-referenced-var"), REDACTED);
	});

	// -----------------------------------------------------------------------
	// Environment scoping
	// -----------------------------------------------------------------------

	it("an ambient key for a provider this target does not use never reaches the run", () => {
		process.env.OPENAI_API_KEY = "sk-ambient-openai";
		process.env.ANTHROPIC_API_KEY = "sk-ambient-anthropic";
		process.env.SOME_UNRELATED_TOKEN = "unrelated-token";
		const home = prepare(["--target", "fake-live"]);
		for (const name of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "SOME_UNRELATED_TOKEN", "NODE_OPTIONS"]) {
			strictEqual(home.env[name], undefined, `${name} reached a run that never asked for it`);
		}
		strictEqual(home.authEnvNames.length, 0);
		// Nothing was declared a secret, so unrelated text passes through intact.
		strictEqual(home.redact("sk-ambient-openai"), "sk-ambient-openai");
	});

	it("--pass-env is the one way to add a variable, and its value is redacted", () => {
		process.env.OPENAI_API_KEY = "sk-ambient-openai";
		const home = prepare(["--target", "fake-live", "--pass-env", "OPENAI_API_KEY"]);
		strictEqual(home.env.OPENAI_API_KEY, "sk-ambient-openai");
		ok(home.authEnvNames.includes("OPENAI_API_KEY"));
		strictEqual(home.redact("sk-ambient-openai"), REDACTED);
	});

	it("a target with an explicit apiKeyEnvVar gets that variable and refuses to start without it", () => {
		writeOperatorSettings([{ ...FAKE_TARGET, auth: { apiKeyEnvVar: "CLIO_TEST_EXPLICIT_KEY" } }]);
		throws(() => prepare(["--target", "fake-live"]), LiveUsageError);
		process.env.CLIO_TEST_EXPLICIT_KEY = "sk-explicit";
		const home = prepare(["--target", "fake-live"]);
		strictEqual(home.env.CLIO_TEST_EXPLICIT_KEY, "sk-explicit");
		strictEqual(home.redact("sk-explicit"), REDACTED);
	});

	it("the provider's conventional variable is consulted only when nothing is stored", () => {
		process.env.OPENAI_API_KEY = "sk-conventional";
		writeOperatorSettings([{ ...FAKE_TARGET, runtime: "openai" }]);
		const withoutStore = prepare(["--target", "fake-live"]);
		strictEqual(withoutStore.env.OPENAI_API_KEY, "sk-conventional");
		strictEqual(withoutStore.redact("sk-conventional"), REDACTED);

		writeOperatorCredentials({ version: 2, entries: { openai: { type: "api_key", key: "sk-stored-wins" } } });
		const withStore = prepare(["--target", "fake-live"]);
		// The explicit credentialsEnvVar is still offered; the conventional-name
		// sweep is what the stored entry turns off.
		strictEqual(copiedEntries(withStore).openai?.key, "sk-stored-wins");
	});

	it("BASE_ENV_PASSTHROUGH is exactly the plumbing the module documents", () => {
		// A change here changes what the child can see. It must be deliberate.
		ok(!BASE_ENV_PASSTHROUGH.includes("NODE_OPTIONS"), "NODE_OPTIONS can preload code into the child");
		for (const name of ["HOME", "PATH", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"]) {
			ok(BASE_ENV_PASSTHROUGH.includes(name), `${name} is documented as passed through`);
		}
		for (const name of ["HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "NO_PROXY"]) {
			ok(BASE_ENV_PASSTHROUGH.includes(name), `${name} is the network path to the target`);
		}
		strictEqual(new Set(BASE_ENV_PASSTHROUGH).size, BASE_ENV_PASSTHROUGH.length, "no duplicates");
	});

	it("HOME and the XDG roots are passed through, and Clio's own roots still point into the home", () => {
		process.env.HOME = "/home/operator-under-test";
		process.env.XDG_CONFIG_HOME = "/home/operator-under-test/.config";
		const home = prepare(["--target", "fake-live"]);
		strictEqual(home.env.HOME, "/home/operator-under-test", "the child needs the operator's dotfiles");
		strictEqual(home.env.XDG_CONFIG_HOME, "/home/operator-under-test/.config");
		// The documented reason that is safe: Clio's roots are named explicitly and
		// any escape from them is fatal in the child.
		strictEqual(home.env.CLIO_CODER_CONFIG_DIR, home.configDir);
		ok((home.env.CLIO_CODER_CONFIG_DIR as string).startsWith(home.dir));
		strictEqual(home.env.CLIO_CODER_REQUIRE_HOME_PREFIX, "1");
	});

	it("a proxy URL carrying a password is passed through and redacted whole; a bare one is not redacted", () => {
		process.env.HTTPS_PROXY = "http://user:hunter2@proxy.internal:3128";
		process.env.HTTP_PROXY = "http://proxy.internal:3128";
		const home = prepare(["--target", "fake-live"]);
		strictEqual(home.env.HTTPS_PROXY, "http://user:hunter2@proxy.internal:3128", "the run still needs the proxy");
		strictEqual(home.redact("via http://user:hunter2@proxy.internal:3128 ok"), `via ${REDACTED} ok`);
		strictEqual(home.redact("via http://proxy.internal:3128 ok"), "via http://proxy.internal:3128 ok");
	});

	it("a cloud-SDK runtime gets its credential family, and the selectors in it are not redacted", () => {
		process.env.AWS_ACCESS_KEY_ID = "AKIAEXAMPLEKEYID";
		process.env.AWS_SECRET_ACCESS_KEY = "aws-secret-value-here";
		process.env.AWS_PROFILE = "default";
		process.env.AWS_REGION = "us-east-1";
		writeOperatorSettings([{ ...FAKE_TARGET, runtime: "bedrock" }]);
		const home = prepare(["--target", "fake-live"]);
		strictEqual(home.env.AWS_SECRET_ACCESS_KEY, "aws-secret-value-here");
		strictEqual(home.env.AWS_PROFILE, "default");
		strictEqual(home.redact("aws-secret-value-here"), REDACTED);
		strictEqual(home.redact("AKIAEXAMPLEKEYID"), REDACTED);
		// A profile name or a region is a selector, not a secret. Redacting them
		// would corrupt the very output a failed run is read from.
		strictEqual(home.redact("workers.default at us-east-1"), "workers.default at us-east-1");
	});

	// -----------------------------------------------------------------------
	// Inline headers
	// -----------------------------------------------------------------------

	it("inline auth headers reach the run's settings, are redacted in output, and are blanked on cleanup", () => {
		writeOperatorSettings([{ ...FAKE_TARGET, auth: { headers: { "x-api-token": "header-secret-value" } } }]);
		const home = prepare(["--target", "fake-live"]);
		const settingsPath = join(home.configDir, "settings.yaml");
		ok(readFileSync(settingsPath, "utf8").includes("header-secret-value"), "the run needs the header to authenticate");
		strictEqual(home.redact("sent header-secret-value"), `sent ${REDACTED}`);

		home.scrubSecrets();
		const scrubbed = parse(readFileSync(settingsPath, "utf8")) as { targets: Array<{ auth: { headers: never } }> };
		strictEqual((scrubbed.targets[0]?.auth.headers as unknown as Record<string, string>)["x-api-token"], REDACTED);
		ok(!readFileSync(settingsPath, "utf8").includes("header-secret-value"));
	});

	// -----------------------------------------------------------------------
	// Cleanup and retention
	// -----------------------------------------------------------------------

	function storedHome(argv: ReadonlyArray<string>, options: Partial<LiveHomeOptions> = {}): LiveHome {
		writeOperatorCredentials({ version: 2, entries: { "openai-compat": { type: "api_key", key: "sk-cleanup" } } });
		return prepare(argv, options);
	}

	it("a passing run removes the whole tree; --keep retains it without its credentials", () => {
		const removed = storedHome(["--target", "fake-live"]);
		removed.cleanup(true);
		ok(!existsSync(removed.dir), "a passing run left its tree behind");

		const kept = storedHome(["--target", "fake-live", "--keep"]);
		kept.cleanup(true);
		ok(existsSync(kept.dir), "--keep did not retain the tree");
		ok(!existsSync(join(kept.configDir, "credentials.yaml")), "a kept tree still holds credentials");
	});

	it("a failed run retains its tree for diagnosis and removes the credentials anyway", () => {
		const home = storedHome(["--target", "fake-live"]);
		ok(existsSync(join(home.configDir, "credentials.yaml")));
		home.cleanup(false);
		ok(existsSync(home.dir), "a failed run must keep its tree and print the path");
		ok(!existsSync(join(home.configDir, "credentials.yaml")), "a retained tree holds no credentials");
	});

	it("a body that throws still loses its credentials, and the throw reaches the caller", async () => {
		writeOperatorCredentials({ version: 2, entries: { "openai-compat": { type: "api_key", key: "sk-body-throw" } } });
		let seen: LiveHome | null = null;
		let caught: unknown;
		try {
			await withLiveHome(parseLiveArgs(["--target", "fake-live"]), { prefix: "clio-live-home-test-" }, async (home) => {
				seen = home;
				opened.push(home);
				ok(existsSync(join(home.configDir, "credentials.yaml")));
				throw new Error("body blew up");
			});
		} catch (error) {
			caught = error;
		}
		strictEqual((caught as Error).message, "body blew up");
		const home = seen as unknown as LiveHome;
		ok(home !== null, "the body never ran");
		ok(!existsSync(join(home.configDir, "credentials.yaml")), "a thrown body skipped the credential removal");
		ok(existsSync(home.dir), "a thrown body is a failed run; its tree is retained");
	});

	it("setup that fails after the tree exists leaves nothing behind", () => {
		writeOperatorCredentials({ version: 2, entries: { "openai-compat": { type: "api_key", key: "sk-setup-throw" } } });
		const before = readdirSync(scratchRoot).filter((name) => name.startsWith(LIVE_HOME_PREFIX));
		throws(
			() =>
				prepareLiveHome(parseLiveArgs(["--target", "fake-live"]), {
					prefix: "clio-live-home-test-",
					settings() {
						throw new Error("settings hook blew up");
					},
				}),
			/settings hook blew up/u,
		);
		const after = readdirSync(scratchRoot).filter((name) => name.startsWith(LIVE_HOME_PREFIX));
		strictEqual(after.length, before.length, `a half-built home survived: ${after.join(", ")}`);
	});

	it("refuses a prefix the lease sweep would not recognise", () => {
		throws(() => prepareLiveHome(parseLiveArgs(["--target", "fake-live"]), { prefix: "unswept-" }), /clio-live-/u);
	});

	it("refuses to start inside a live home", () => {
		const nested = join(scratchRoot, `${LIVE_HOME_PREFIX}nested`);
		mkdirSync(nested, { recursive: true });
		writeFileSync(join(nested, LEASE_FILE), "{}\n", "utf8");
		process.env.CLIO_CODER_HOME = nested;
		throws(() => prepare(["--target", "fake-live"]), /inside the live home/u);
	});

	// -----------------------------------------------------------------------
	// Lease guards: everything that gates a recursive delete
	// -----------------------------------------------------------------------

	/** A tree that looks exactly like a live home, at `parent`, expiring at `expiresAt`. */
	function fakeHome(parent: string, name: string, expiresAt: string, root = parent): string {
		const dir = join(parent, name);
		mkdirSync(join(dir, "config"), { recursive: true });
		writeFileSync(join(dir, "config", "credentials.yaml"), "version: 2\nentries: {}\n", "utf8");
		writeFileSync(
			join(dir, LEASE_FILE),
			`${JSON.stringify({
				version: 1,
				driver: "clio-live-fake-",
				target: "fake-live",
				pid: process.pid,
				root,
				createdAt: new Date(0).toISOString(),
				expiresAt,
				retainsSecrets: false,
			})}\n`,
			"utf8",
		);
		return dir;
	}

	const PAST = new Date(Date.now() - 60_000).toISOString();
	const FUTURE = new Date(Date.now() + 3_600_000).toISOString();

	it("the sweep removes expired homes in the temp root and leaves live ones alone", () => {
		const expired = fakeHome(scratchRoot, `${LIVE_HOME_PREFIX}expired`, PAST);
		const live = fakeHome(scratchRoot, `${LIVE_HOME_PREFIX}live`, FUTURE);
		const foreign = join(scratchRoot, "not-a-live-home");
		mkdirSync(foreign, { recursive: true });

		const removed = sweepExpiredLiveHomes();
		strictEqual(removed.join(","), expired);
		ok(!existsSync(expired));
		ok(existsSync(live), "an unexpired home was swept");
		ok(existsSync(foreign), "the sweep touched a directory that is not ours");
	});

	it("release removes a genuine home and refuses everything that is not one", () => {
		const home = fakeHome(scratchRoot, `${LIVE_HOME_PREFIX}releasable`, FUTURE);
		releaseLiveHome(home);
		ok(!existsSync(home));

		// No lease file.
		const bare = join(scratchRoot, `${LIVE_HOME_PREFIX}bare`);
		mkdirSync(bare, { recursive: true });
		throws(() => releaseLiveHome(bare), LiveUsageError);
		ok(existsSync(bare));

		// Right shape, wrong name.
		const misnamed = fakeHome(scratchRoot, "totally-unrelated", FUTURE);
		throws(() => releaseLiveHome(misnamed), LiveUsageError);
		ok(existsSync(misnamed));

		// A symlink that points at a real home is not a home.
		const real = fakeHome(scratchRoot, `${LIVE_HOME_PREFIX}real`, FUTURE);
		const link = join(scratchRoot, `${LIVE_HOME_PREFIX}link`);
		symlinkSync(real, link);
		throws(() => releaseLiveHome(link), LiveUsageError);
		ok(existsSync(real), "following a symlink deleted the tree it pointed at");
		ok(existsSync(link));

		throws(() => releaseLiveHome(""), LiveUsageError);
		throws(() => releaseLiveHome(join(scratchRoot, `${LIVE_HOME_PREFIX}missing`)), LiveUsageError);
	});

	it("a forged lease cannot name its own parent and authorize its own deletion", () => {
		// The lease lives inside the candidate, so its `root` is written by whoever
		// owns the candidate. A tree planted outside the temp root that points its
		// lease at its own parent must not be deletable.
		const elsewhere = mkdtempSync(join(scratchRoot, "outside-the-temp-root-"));
		const forged = fakeHome(elsewhere, `${LIVE_HOME_PREFIX}forged`, FUTURE, elsewhere);
		strictEqual(isLiveHomeDir(forged), false, "lease.root authorized a delete outside the temp root");
		throws(() => releaseLiveHome(forged), LiveUsageError);
		ok(existsSync(forged), "a forged lease got its own tree deleted");

		// The same tree pointing its lease at an unrelated directory is refused too.
		const lyingRoot = fakeHome(elsewhere, `${LIVE_HOME_PREFIX}lying`, FUTURE, scratchRoot);
		strictEqual(isLiveHomeDir(lyingRoot), false);
		ok(existsSync(lyingRoot));
	});

	it("release works from a shell whose TMPDIR is the home's own tmp directory", () => {
		const home = fakeHome(scratchRoot, `${LIVE_HOME_PREFIX}sourced`, FUTURE);
		mkdirSync(join(home, "tmp"), { recursive: true });
		const sibling = fakeHome(scratchRoot, `${LIVE_HOME_PREFIX}sibling`, FUTURE);

		// What a sourced shell or a launcher-started pane sees.
		process.env.TMPDIR = join(home, "tmp");
		try {
			strictEqual(isLiveHomeDir(home), true, "the home TMPDIR points into is not releasable from inside it");
			// It authorizes that one tree and nothing else, not even its own sibling.
			strictEqual(isLiveHomeDir(sibling), false, "a nested TMPDIR authorized a tree it does not point into");
			releaseLiveHome(home);
			ok(!existsSync(home));
			ok(existsSync(sibling));
		} finally {
			process.env.TMPDIR = scratchRoot;
		}
	});

	it("a real home is releasable, and releasing it takes the credentials with it", () => {
		const home = storedHome(["--target", "fake-live", "--keep"]);
		ok(existsSync(join(home.configDir, "credentials.yaml")));
		releaseLiveHome(home.dir);
		ok(!existsSync(home.dir));
	});

	// -----------------------------------------------------------------------
	// The live:home launcher
	// -----------------------------------------------------------------------

	function launcherHome(argv: ReadonlyArray<string> = ["--target", "fake-live"]): LiveHome {
		writeOperatorCredentials({ version: 2, entries: { "openai-compat": { type: "api_key", key: "sk-launcher" } } });
		return prepare(argv, { prefix: "clio-live-home-test-", retainSecrets: true, launcher: true });
	}

	it("the launcher names the credential variables it needs and holds none of their values", () => {
		process.env.CLIO_TEST_LAUNCH_KEY = "sk-must-not-be-on-disk";
		const home = launcherHome(["--target", "fake-live", "--pass-env", "CLIO_TEST_LAUNCH_KEY"]);
		const script = readFileSync(join(home.dir, "launch.mjs"), "utf8");
		ok(script.includes("CLIO_TEST_LAUNCH_KEY"), "the launcher must name the variable to read it at start");
		ok(!script.includes("sk-must-not-be-on-disk"), "the launcher wrote a secret value to disk");
		ok(!script.includes("sk-launcher"), "the launcher wrote the stored key to disk");
		strictEqual(home.launcher, join(home.dir, LAUNCHER_SHIM));
		strictEqual((statSync(home.launcher as string).mode & 0o777).toString(8), "700");
		strictEqual((statSync(join(home.dir, "launch.mjs")).mode & 0o777).toString(8), "700");
	});

	it("the launcher starts the binary under the filtered environment and nothing else", async () => {
		process.env.CLIO_TEST_LAUNCH_KEY = "sk-read-from-the-shell";
		process.env.CLIO_TEST_LAUNCH_AMBIENT = "must-not-be-passed";
		const home = launcherHome(["--target", "fake-live", "--pass-env", "CLIO_TEST_LAUNCH_KEY"]);
		const scriptPath = join(home.dir, "launch.mjs");
		// Point the generated launcher at a stub that reports what it was given.
		// Everything else about the script, including how it builds the
		// environment, is exactly what live:home wrote.
		const stub = join(home.dir, "stub-entry.mjs");
		writeFileSync(stub, "process.stdout.write(JSON.stringify(process.env));\n", "utf8");
		const script = readFileSync(scriptPath, "utf8");
		const replaced = script.replace(/^const ENTRY = .*$/mu, `const ENTRY = ${JSON.stringify(stub)};`);
		ok(replaced !== script, "the launcher no longer declares ENTRY; this test needs updating");
		writeFileSync(scriptPath, replaced, "utf8");

		const result = await runNodeScript(scriptPath, [], { timeoutMs: 20_000 });
		strictEqual(result.code, 0, result.stderr);
		const seen = JSON.parse(result.stdout) as Record<string, string>;
		strictEqual(seen.CLIO_TEST_LAUNCH_KEY, "sk-read-from-the-shell", "the launcher did not read the named variable");
		strictEqual(seen.CLIO_TEST_LAUNCH_AMBIENT, undefined, "the launcher passed a variable nobody asked for");
		strictEqual(seen.CLIO_CODER_HOME, home.dir);
		strictEqual(seen.CLIO_CODER_CONFIG_DIR, home.configDir);
		strictEqual(seen.CLIO_CODER_REQUIRE_HOME_PREFIX, "1");
		strictEqual(seen.TMPDIR, join(home.dir, "tmp"));
		ok(typeof seen.TERM === "string" && seen.TERM.length > 0, "an interactive pane needs a TERM");
	});

	it("the launcher refuses to start once the lease has expired", async () => {
		const home = launcherHome();
		const leasePath = join(home.dir, LEASE_FILE);
		const lease = JSON.parse(readFileSync(leasePath, "utf8")) as Record<string, unknown>;
		writeFileSync(leasePath, JSON.stringify({ ...lease, expiresAt: PAST }), "utf8");

		const result = await runNodeScript(join(home.dir, "launch.mjs"), [], { timeoutMs: 20_000 });
		strictEqual(result.code, 2);
		ok(result.stderr.includes("expired"), result.stderr);
		strictEqual(result.stdout, "");
	});

	it("--lease bounds the tree and rejects a duration it cannot read", () => {
		const home = prepare(["--target", "fake-live", "--lease", "90m"]);
		const span = Date.parse(home.lease.expiresAt) - Date.parse(home.lease.createdAt);
		strictEqual(span, 90 * 60_000);
		strictEqual(home.lease.version, 1);
		strictEqual(home.lease.target, "fake-live");
		for (const bad of ["90", "0h", "forever", "-2d"]) {
			throws(() => parseLiveArgs(["--target", "fake-live", "--lease", bad]), LiveUsageError, `--lease ${bad}`);
		}
	});

	it("live:home marks its tree as one that keeps its credentials on purpose", () => {
		const retained = launcherHome();
		strictEqual(retained.lease.retainsSecrets, true);
		ok(existsSync(join(retained.configDir, "credentials.yaml")), "the pane has not started yet; the key must stay");
		const driverHome = storedHome(["--target", "fake-live"]);
		strictEqual(driverHome.lease.retainsSecrets, false);
		strictEqual(driverHome.launcher, null, "a driver home has no launcher");
	});
});

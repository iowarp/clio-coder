/**
 * One clock and one locale for every gate process, on a developer's machine and in CI.
 *
 * A fixture dated 2026-01-01T00:00Z printed "Jan 1" on the UTC runners and "Dec 31" in
 * America/Chicago, so local qualification passed twice and both CI legs failed. Tests, builds
 * and release checks now read the same zone and locale everywhere, and a clock or collation
 * bug fails on the developer's machine first.
 *
 * Node reads the zone again whenever process.env.TZ is assigned, but fixes its default locale when
 * the process starts, and `node --test` runs a preload only in each test child, never in the runner
 * (Node 22.22 and 24.22). So `tests/harness/tmp-root.ts` pins the zone inside every test process
 * however it was launched, and the launchers pin both in the environment they start: `scripts/ci-tests.mjs`
 * (`pnpm test`, `pnpm test:gui`), `scripts/check-lane.mjs` and `scripts/release-candidate.mjs` (preparation,
 * tests and the install boot, locally and in CI). A bare `pnpm run test:file` keeps the shell's locale.
 * CLIO_CODER_TEST_TZ and CLIO_CODER_TEST_LC_ALL choose another zone or locale for a sweep, such
 * as `CLIO_CODER_TEST_TZ=Pacific/Kiritimati pnpm test`.
 */
export const GATE_TZ = "UTC";

/** glibc and musl both carry C.UTF-8; macOS has no such locale and Windows reads none from the environment. */
export const GATE_LOCALE = { linux: "C.UTF-8", darwin: "en_US.UTF-8" };

export function pinGateEnv(env = process.env, platform = process.platform) {
	// Assigning process.env.TZ re-reads the zone in this process; children inherit it at start.
	env.TZ = env.CLIO_CODER_TEST_TZ || GATE_TZ;
	const locale = env.CLIO_CODER_TEST_LC_ALL || GATE_LOCALE[platform];
	if (locale) {
		// LANGUAGE outranks LC_ALL for message catalogs and the other LC_* only matter without LC_ALL.
		for (const name of Object.keys(env)) if (name === "LANGUAGE" || /^LC_[A-Z]+$/u.test(name)) delete env[name];
		env.LC_ALL = locale;
		env.LANG = locale;
	}
	return env;
}

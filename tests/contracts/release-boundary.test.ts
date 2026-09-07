import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { shippedAdvisoryFindings } from "../../scripts/release-audit.mjs";
import { readmeInstallVersion, releaseVersionErrors } from "../../scripts/release-version-policy.mjs";

describe("published dependency advisory boundary", () => {
	const clean = () => ({
		advisories: {},
		metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0 } },
	});
	it("accepts a complete clean pnpm report and refuses an unknown advisory state", () => {
		assert.deepEqual(shippedAdvisoryFindings(clean()), { notes: [], errors: [] });
		for (const report of [null, {}, { error: { code: "ERR_PNPM_AUDIT_BAD_RESPONSE" } }, { advisories: {} }]) {
			assert.throws(() => shippedAdvisoryFindings(report), /unknown/);
		}
		const missing = clean();
		missing.metadata.vulnerabilities.high = 1;
		assert.throws(() => shippedAdvisoryFindings(missing), /without advisory details/);
	});
	it("blocks high and critical advisories while keeping lesser findings visible", () => {
		const report = clean();
		report.advisories = Object.fromEntries(
			["moderate", "high", "critical"].map((severity) => [
				severity,
				{
					module_name: `dependency-${severity}`,
					severity,
					vulnerable_versions: "<2.0.0",
					recommendation: "Upgrade to 2.0.0",
				},
			]),
		);
		const result = shippedAdvisoryFindings(report);
		assert.equal(result.notes.length, 1);
		assert.match(result.notes[0] ?? "", /moderate.*dependency-moderate/);
		assert.equal(result.errors.length, 2);
		assert.match(result.errors.join("\n"), /Upgrade to 2.0.0/);
	});
});

describe("release version boundary", () => {
	it("keeps local development installs pinned to the latest dated stable release", () => {
		const changelog =
			"# Changelog\n\n## Unreleased\n\n## 0.4.5-beta.1 - 2026-09-07\n\n## 0.4.4 - 2026-09-05\n\n## 0.4.3 - 2026-09-01\n";
		assert.equal(readmeInstallVersion({ version: "0.4.5-dev.0", changelog }), "0.4.4");
		assert.equal(readmeInstallVersion({ version: "0.4.5", changelog }), "0.4.4");
		assert.equal(readmeInstallVersion({ version: "0.4.5-beta.1", changelog }), "0.4.4");
		assert.equal(readmeInstallVersion({ version: "0.4.5", changelog: "## 0.4.5 - 2026-09-07\n" }), "0.4.5");
	});

	it("does not excuse a missing release or a development version with named release notes", () => {
		assert.throws(
			() => readmeInstallVersion({ version: "0.4.5-dev.0", changelog: "## Unreleased\n" }),
			/dated stable release/,
		);
		assert.equal(readmeInstallVersion({ version: "0.4.5-dev.0", changelog: "## 0.4.4 - 2026-09-05\n" }), "0.4.5-dev.0");
		assert.notDeepEqual(
			releaseVersionErrors({ version: "0.4.5-dev.0", changelog: "## Unreleased\n", releaseContext: true }),
			[],
		);
	});

	it("allows an Unreleased section during development", () => {
		assert.deepEqual(
			releaseVersionErrors({
				version: "0.4.2",
				changelog: "# Changelog\n\n## Unreleased\n\n- Work in progress.\n",
				releaseContext: false,
			}),
			[],
		);
	});

	it("refuses Unreleased notes for a tag or publish", () => {
		const errors = releaseVersionErrors({
			version: "0.4.2",
			changelog: "# Changelog\n\n## Unreleased\n",
			releaseContext: true,
		});
		assert.equal(errors.length, 1);
		assert.match(errors[0] ?? "", /before publishing/);
	});

	it("requires the exact package version and a release date when immutable", () => {
		assert.match(
			releaseVersionErrors({
				version: "0.4.2",
				changelog: "# Changelog\n\n## 0.4.1 - 2026-09-01\n",
				releaseContext: true,
			})[0] ?? "",
			/must name the same release/,
		);
		assert.match(
			releaseVersionErrors({
				version: "0.4.2",
				changelog: "# Changelog\n\n## 0.4.2 - Unreleased\n",
				releaseContext: true,
			})[0] ?? "",
			/YYYY-MM-DD/,
		);
		assert.deepEqual(
			releaseVersionErrors({
				version: "0.4.2",
				changelog: "# Changelog\n\n## 0.4.2 - 2026-09-01\n",
				releaseContext: true,
			}),
			[],
		);
	});
});

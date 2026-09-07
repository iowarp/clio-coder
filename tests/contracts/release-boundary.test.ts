import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readmeInstallVersion, releaseVersionErrors } from "../../scripts/release-version-policy.mjs";

describe("release version boundary", () => {
	it("keeps local development installs pinned to the latest dated stable release", () => {
		const changelog =
			"# Changelog\n\n## Unreleased\n\n## 0.4.5-beta.1 - 2026-09-07\n\n## 0.4.4 - 2026-09-05\n\n## 0.4.3 - 2026-09-01\n";
		assert.equal(readmeInstallVersion({ version: "0.4.5-dev.0", changelog }), "0.4.4");
		assert.equal(readmeInstallVersion({ version: "0.4.5", changelog }), "0.4.5");
		assert.equal(readmeInstallVersion({ version: "0.4.5-beta.1", changelog }), "0.4.5-beta.1");
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

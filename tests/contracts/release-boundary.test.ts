import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { releaseVersionErrors } from "../../scripts/release-version-policy.mjs";

describe("release version boundary", () => {
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

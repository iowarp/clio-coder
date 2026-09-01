/**
 * Validate the relationship between package.json and the first release section
 * in CHANGELOG.md. Development trees may open with `## Unreleased`; immutable
 * release contexts must name and date the package version.
 *
 * @param {{ version: unknown, changelog: unknown, releaseContext: boolean }} input
 * @returns {string[]}
 */
export function releaseVersionErrors({ version, changelog, releaseContext }) {
	const errors = [];
	if (typeof version !== "string" || version.length === 0) {
		return ["package.json has no version"];
	}
	if (typeof changelog !== "string") {
		return ["CHANGELOG.md is not text"];
	}

	const heading = changelog.split(/\r?\n/).find((line) => line.startsWith("## "));
	if (heading === undefined) return ["CHANGELOG.md has no '## <version>' heading"];

	const named = heading.slice(3).split(" - ")[0].trim();
	if (named === "Unreleased") {
		if (!releaseContext) return errors;
		return [
			`CHANGELOG.md still opens with '## Unreleased'; retitle that section '## ${version} - <date>' before publishing`,
		];
	}
	if (named !== version) {
		return [
			`package.json version ${version} does not match the top CHANGELOG.md heading '${heading.trim()}'; the release notes and the published version must name the same release`,
		];
	}
	const escapedVersion = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	if (releaseContext && !new RegExp(`^## ${escapedVersion} - \\d{4}-\\d{2}-\\d{2}$`).test(heading.trim())) {
		errors.push(`release heading '${heading.trim()}' must read '## ${version} - YYYY-MM-DD'`);
	}
	return errors;
}

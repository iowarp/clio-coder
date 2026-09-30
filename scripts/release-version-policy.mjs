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

/**
 * A development tree with Unreleased notes may advance its package version
 * before a tag exists. Its installation instructions still name the latest
 * dated stable release. Once the release is named, instructions pin that version.
 * @param {{ version: string, changelog: string }} input
 * @returns {string}
 */
export function readmeInstallVersion({ version, changelog }) {
	const headings = changelog.split(/\r?\n/).filter((line) => line.startsWith("## "));
	if (headings[0]?.trim() !== "## Unreleased") return version;
	for (const heading of headings.slice(1)) {
		const released = /^## (\d+\.\d+\.\d+) - \d{4}-\d{2}-\d{2}$/.exec(heading.trim());
		if (released?.[1] !== undefined) return released[1];
	}
	throw new Error("local development install instructions need a dated stable release in CHANGELOG.md");
}

/**
 * Pre-releases ship under the `beta` dist-tag only. A bare `npm publish` of an
 * rc would move `latest`, and every stable install would be offered the rc.
 * npm exports `--tag` to lifecycle scripts as `npm_config_tag`.
 * @param {{ version: unknown, tag: unknown }} input
 * @returns {string[]}
 */
export function publishTagErrors({ version, tag }) {
	if (typeof version !== "string" || !/^\d+\.\d+\.\d+-/.test(version) || tag === "beta") return [];
	const seen = typeof tag === "string" && tag.length > 0 ? `'${tag}'` : "unset";
	return [
		`package.json version ${version} is a pre-release; publish it with 'npm publish --tag beta' (npm_config_tag is ${seen})`,
	];
}

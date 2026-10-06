/** `0.6.0-dev` and `0.6.0-dev.N` are checkout versions with no published artifact. Mirrors src/core/build-info.ts. */
export const DEV_VERSION = /^\d+\.\d+\.\d+-dev(?:[.+]|$)/;

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
	if (releaseContext && DEV_VERSION.test(version)) {
		return [`package.json version ${version} is a development version; set the release version before publishing`];
	}
	if (typeof changelog !== "string") {
		return ["CHANGELOG.md is not text"];
	}

	const heading = changelog.split(/\r?\n/).find((line) => line.startsWith("## "));
	if (heading === undefined) return ["CHANGELOG.md has no '## <version>' heading"];

	const named = heading.slice(3).split(" - ")[0].trim();
	if (named === "Unreleased") {
		if (SNAPSHOT_VERSION.test(version)) return errors;
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
	if (headings[0]?.trim() !== "## Unreleased" && !RC_VERSION.test(version) && !SNAPSHOT_VERSION.test(version))
		return version;
	for (const heading of headings) {
		const released = /^## (\d+\.\d+\.\d+) - \d{4}-\d{2}-\d{2}$/.exec(heading.trim());
		if (released?.[1] !== undefined) return released[1];
	}
	throw new Error("local development install instructions need a dated stable release in CHANGELOG.md");
}

/** Published channel versions; checkout -dev versions never enter npm. */
export const RC_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-rc\.(0|[1-9]\d*)$/;
export const SNAPSHOT_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-snapshot\.([0-9]{12})\.g[a-f0-9]{7}$/;

export function publishTagErrors({ version, tag }) {
	if (typeof version !== "string") return ["package.json has no version"];
	if (DEV_VERSION.test(version))
		return [`package.json version ${version} is a development version and is never published, under any dist-tag`];
	const required = RC_VERSION.test(version)
		? "beta"
		: SNAPSHOT_VERSION.test(version)
			? "dev"
			: /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)
				? "latest"
				: null;
	if (required === null)
		return [
			`Unsupported published version ${version}; use a stable, -rc.N or -snapshot.<UTC yyyymmddHHMM>.g<sha7> version`,
		];
	// npm's default publish tag is latest, including when the env variable is absent.
	if ((tag || "latest") === required) return [];
	return [
		`package.json version ${version} must publish with 'npm publish --tag ${required}' (npm_config_tag is ${tag || "unset"})`,
	];
}

/** The commit's UTC minute makes retries publish the same snapshot version and bytes. */
export function snapshotVersion(version, commit, timestamp) {
	if (!/^\d+\.\d+\.\d+-dev$/.test(version) || !/^[a-f0-9]{40}$/.test(commit))
		throw new Error("Dev snapshots require an X.Y.Z-dev version and an exact source commit.");
	const date = new Date(timestamp);
	if (!Number.isFinite(date.getTime())) throw new Error("Invalid snapshot commit timestamp.");
	return `${version.slice(0, -4)}-snapshot.${date.toISOString().slice(0, 16).replace(/[-T:]/g, "")}.g${commit.slice(0, 7)}`;
}

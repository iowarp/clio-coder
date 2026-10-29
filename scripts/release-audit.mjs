/**
 * Audit the exact bundled versions, without pulling unbundled dependency
 * subtrees into the GUI audit. pnpm's audit tree keys each node by package
 * name, so a second version of one name (the bundle ships two d3-array, two
 * cose-base) would silently replace the first; every extra version goes into
 * its own lockfile so each version is sent to the registry.
 */
export function bundledGuiAuditLockfiles(lockfile, licenses) {
	if (!lockfile?.packages || !lockfile?.snapshots || typeof licenses !== "string") {
		throw new Error("Cannot establish bundled GUI dependencies from the lockfile and license inventory");
	}
	const layers = [];
	const versionsByName = new Map();
	const seen = new Set();
	const snapshotKeys = Object.keys(lockfile.snapshots);
	for (const line of licenses.split(/\r?\n/)) {
		if (!line.startsWith("## ") || !line.includes(" - ")) continue;
		const match = line.match(
			/^## ((?:@[a-z0-9._-]+\/)?[a-z0-9._-]+) - (\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?(?:\+[a-zA-Z0-9.-]+)?)(?: \(.+\))?$/,
		);
		if (!match) throw new Error(`Invalid bundled GUI dependency heading: ${line}`);
		const [, name, version] = match;
		const key = `${name}@${version}`;
		if (
			!Object.hasOwn(lockfile.packages, key) ||
			!snapshotKeys.some((snapshot) => snapshot === key || snapshot.startsWith(`${key}(`))
		) {
			throw new Error(`Bundled GUI dependency ${key} is missing from or mismatched with pnpm-lock.yaml`);
		}
		if (seen.has(key)) continue;
		seen.add(key);
		const rank = versionsByName.get(name) ?? 0;
		versionsByName.set(name, rank + 1);
		if (layers[rank] === undefined) layers[rank] = { dependencies: {}, packages: {}, snapshots: {} };
		const layer = layers[rank];
		layer.dependencies[`gui-bundle-${seen.size}`] = { specifier: `npm:${key}`, version: key };
		layer.packages[key] = lockfile.packages[key];
		layer.snapshots[key] = {};
	}
	if (seen.size === 0) throw new Error("Bundled GUI license inventory contains no dependencies");
	return layers.map((layer) => ({
		lockfileVersion: lockfile.lockfileVersion,
		settings: lockfile.settings,
		importers: { ".": { dependencies: layer.dependencies } },
		packages: layer.packages,
		snapshots: layer.snapshots,
	}));
}

/** Interpret pnpm's advisory report; registry errors must never look like a clean audit. */
export function shippedAdvisoryFindings(report) {
	if (
		!report ||
		typeof report !== "object" ||
		report.error ||
		!report.advisories ||
		typeof report.advisories !== "object" ||
		Array.isArray(report.advisories) ||
		!report.metadata?.vulnerabilities
	) {
		throw new Error("pnpm audit returned an invalid report; advisory state is unknown");
	}
	const counts = report.metadata.vulnerabilities;
	for (const severity of ["info", "low", "moderate", "high", "critical"]) {
		if (!Number.isSafeInteger(counts[severity]) || counts[severity] < 0) {
			throw new Error("pnpm audit returned invalid vulnerability counts");
		}
	}
	const notes = [];
	const errors = [];
	for (const advisory of Object.values(report.advisories)) {
		if (
			!advisory ||
			typeof advisory.module_name !== "string" ||
			typeof advisory.vulnerable_versions !== "string" ||
			!["info", "low", "moderate", "high", "critical"].includes(advisory.severity)
		) {
			throw new Error("pnpm audit returned an invalid advisory");
		}
		const message = `${advisory.severity} advisory in shipped dependency ${advisory.module_name} (${advisory.vulnerable_versions})`;
		if (advisory.severity === "high" || advisory.severity === "critical") {
			errors.push(`${message}; ${advisory.recommendation || "review the advisory and update the dependency"}`);
		} else {
			notes.push(message);
		}
	}
	if ((counts.high > 0 || counts.critical > 0) && errors.length === 0) {
		throw new Error("pnpm audit reports blocking vulnerabilities without advisory details");
	}
	return { notes, errors };
}

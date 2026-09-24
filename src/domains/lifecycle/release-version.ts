/** Strict SemVer at the registry boundary; metadata never becomes a shell argument. */
export function parseReleaseVersion(value: unknown): { core: number[]; pre: string[] } | null {
	if (typeof value !== "string" || value.length > 128) return null;
	const match =
		/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*))?(?:\+[\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*)?$/.exec(
			value,
		);
	if (!match) return null;
	const core = match.slice(1, 4).map(Number);
	const pre = match[4]?.split(".") ?? [];
	if (
		core.some((n) => !Number.isSafeInteger(n)) ||
		pre.some((s) => /^\d+$/.test(s) && s.length > 1 && s.startsWith("0"))
	)
		return null;
	return { core, pre };
}

export function compareReleaseVersions(left: string, right: string): number | null {
	const a = parseReleaseVersion(left);
	const b = parseReleaseVersion(right);
	if (!a || !b) return null;
	for (let i = 0; i < 3; i++) {
		const diff = (a.core[i] ?? 0) - (b.core[i] ?? 0);
		if (diff !== 0) return Math.sign(diff);
	}
	if (!a.pre.length || !b.pre.length) return a.pre.length === b.pre.length ? 0 : a.pre.length ? -1 : 1;
	for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
		const l = a.pre[i];
		const r = b.pre[i];
		if (l === r) continue;
		if (l === undefined || r === undefined) return l === undefined ? -1 : 1;
		const ln = /^\d+$/.test(l);
		const rn = /^\d+$/.test(r);
		if (ln && rn) return l.length === r.length ? (l < r ? -1 : 1) : l.length < r.length ? -1 : 1;
		if (ln !== rn) return ln ? -1 : 1;
		return l < r ? -1 : 1;
	}
	return 0;
}

export async function fetchReleaseVersion(channel: string, signal?: AbortSignal): Promise<string | null> {
	if (!["latest", "beta", "dev"].includes(channel)) return null;
	try {
		const timeout = AbortSignal.timeout(2500);
		const response = await fetch(`https://registry.npmjs.org/@iowarp/clio-coder/${channel}`, {
			headers: { Accept: "application/json" },
			signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
		});
		if (!response.ok) return null;
		const data = (await response.json()) as { version?: unknown };
		return parseReleaseVersion(data.version) ? (data.version as string) : null;
	} catch {
		return null;
	}
}

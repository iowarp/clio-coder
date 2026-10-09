let loading: Promise<typeof import("katex")> | null = null;

/** The typesetter is fetched only when a math token is mounted. */
export async function typesetMath(source: string, displayMode: boolean): Promise<string> {
	if (loading === null) {
		loading = import("katex");
		loading.catch(() => {
			loading = null;
		});
	}
	const katex = await loading;
	return katex.default.renderToString(source, {
		output: "mathml",
		displayMode,
		throwOnError: false,
		trust: false,
		maxSize: 50,
		strict: "ignore",
		errorColor: "currentColor",
	});
}

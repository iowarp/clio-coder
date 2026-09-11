/** Each app isolate denies ambient fetch. Only pinned tool downloads retain the capability. */
export function restrictNetwork() {
	const download = globalThis.fetch;
	globalThis.fetch = async () => {
		throw new Error("Web server network requests must use the pinned toolchain downloader.");
	};
	return download;
}

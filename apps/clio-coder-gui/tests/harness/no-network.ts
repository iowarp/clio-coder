globalThis.fetch = async () => {
	throw new Error("Uninjected network access is forbidden in the web test suite.");
};

declare const __CLIO_CODER_BUNDLE_VERSION__: string | undefined;

/** The Clio Coder version this bundle was built from; null where no build stamped it, such as a test run. */
export const BUNDLE_VERSION: string | null =
	typeof __CLIO_CODER_BUNDLE_VERSION__ === "string" ? __CLIO_CODER_BUNDLE_VERSION__ : null;

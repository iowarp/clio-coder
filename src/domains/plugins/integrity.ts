// Both package engines use the same exact-tree framing. Keeping the existing
// implementation preserves the pins of already installed legacy extensions.
export {
	extensionContentDigest as pluginContentDigest,
	extensionContentDigestWithCapture as pluginContentDigestWithCapture,
} from "../extensions/integrity.js";

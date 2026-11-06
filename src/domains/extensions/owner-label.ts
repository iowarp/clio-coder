/**
 * The name an extension is shown under on every terminal surface it draws on.
 *
 * The footer status, the band, cards, toasts and panels all name their owner.
 * Each used to print the package id ("local-status"), which is an identifier,
 * not what the operator installed ("Local status"). One resolver, bound once by
 * the interactive host, keeps every surface on the same label.
 */

let resolve: ((extensionId: string) => string | undefined) | undefined;

/** Bind the host's lookup of an installed package's display name. */
export function bindExtensionOwnerNames(resolver: ((extensionId: string) => string | undefined) | undefined): void {
	resolve = resolver;
}

/** The display name for an extension id, or the id when no name is known. */
export function extensionOwnerLabel(extensionId: string): string {
	try {
		const name = resolve?.(extensionId)?.trim();
		return name && name.length > 0 ? name : extensionId;
	} catch {
		// A failed inventory read must not break painting; the id still names the owner.
		return extensionId;
	}
}

/** What a launch link carried: a single-use launch ticket. */
export interface LaunchSecret {
	ticket?: string;
}
/**
 * Read once and cleared from the address bar. A reloaded or reopened window reconnects with its own
 * expiring credential (`credentials.ts`). A launch token 0.7.0 stored in this browser opens nothing
 * since the upgrade replaced it, so it is deleted unread.
 */
export function launchSecret(): LaunchSecret {
	for (const drop of [
		() => localStorage.removeItem("clio-coder-pwa-token"),
		() => sessionStorage.removeItem("clio-coder-token"),
	])
		try {
			drop();
		} catch {
			/* Storage may be disabled; then nothing was stored either. */
		}
	const ticket = new URLSearchParams(location.hash.slice(1)).get("ticket") ?? undefined;
	if (ticket === undefined) return {};
	history.replaceState(null, "", location.pathname + location.search);
	try {
		sessionStorage.removeItem(refusedKey);
	} catch {
		/* The fresh link still works without browser storage. */
	}
	return /^[\w-]{43}$/.test(ticket) ? { ticket } : {};
}
/**
 * A launch link pasted into the address bar of a window already on this origin is a same-document hash
 * change, so the page that read its secret at load would never see it. Reloading reads it the same way a
 * fresh document does, which is what a window left open across a server restart needs.
 */
export function listenForLaunchLink(reload: () => void = () => location.reload()) {
	addEventListener("hashchange", () => {
		// A pasted ticket adopted below reloads on its own; a second reload would abort the first.
		if (!adopting && new URLSearchParams(location.hash.slice(1)).has("ticket")) reload();
	});
}
let adopting = false;
/** This browser's latest live credential, which lets a reopened window open its own client while it lasts. */
export const rememberedCredentialKey = "clio-coder-credential";
const refusedKey = "clio-coder-token-refused";
/** Whether this browser can keep a connection across a reopened window. */
export function storageAvailable() {
	try {
		localStorage.setItem(`${rememberedCredentialKey}-probe`, "1");
		localStorage.removeItem(`${rememberedCredentialKey}-probe`);
		return true;
	} catch {
		return false;
	}
}
const forgetChannel = "clio-coder-forget";
// The channel also reaches this document's own listener, whose reload must not cut the sign-out short.
let forgetting = false;
/**
 * Forget this browser: every window of it signs its credential out on the server first, then drops the
 * remembered credential and its drafts and reloads to ask for a fresh link. `revoke` is the window's own
 * sign-out; a server that cannot be reached is not asked, and the credential lapses when it expires.
 */
export async function forgetBrowser(revoke: () => Promise<void>, others = true) {
	if (forgetting) return;
	forgetting = true;
	if (others)
		try {
			const channel = new BroadcastChannel(forgetChannel);
			channel.postMessage("forget");
			channel.close();
		} catch {
			/* Without the channel, other windows keep their credential until they close or it expires. */
		}
	await revoke().catch(() => {});
	try {
		for (let index = sessionStorage.length - 1; index >= 0; index -= 1) {
			const key = sessionStorage.key(index);
			if (key?.startsWith("clio-coder-draft:") || key === "clio-coder-draft-index") sessionStorage.removeItem(key);
		}
	} catch {
		/* Browser storage may be disabled. */
	}
	try {
		localStorage.removeItem(rememberedCredentialKey);
	} catch {
		/* Storage may be disabled. */
	}
	location.reload();
}
/** Another window of this browser was told to forget it; this one signs out the same way. */
export function listenForForget(revoke: () => Promise<void>) {
	if (typeof BroadcastChannel !== "function") return;
	new BroadcastChannel(forgetChannel).onmessage = () => void forgetBrowser(revoke, false);
}
/** What the server refused: a spent or expired launch ticket, or this browser's own credential. */
export type RefusalReason = "ticket" | "credential";
// Kept in memory too, so the page can name the refusal when browser storage is disabled.
let refusal: RefusalReason | null = null;
/** A refused credential is dropped at once, so a reload asks for a link instead of failing the same way again. */
export function dropStoredToken(reason: RefusalReason = "credential") {
	refusal = reason;
	for (const drop of [
		() => localStorage.removeItem(rememberedCredentialKey),
		// Survives a reload, so the page still says why it is disconnected rather than "no token yet".
		() => sessionStorage.setItem(refusedKey, reason),
	])
		try {
			drop();
		} catch {
			/* Storage may be disabled. */
		}
}
/**
 * Adopt a ticket the operator pasted. It goes through the same launch path as a link, so it is
 * validated once.
 */
export function adoptLaunchSecret(secret: { ticket: string }, origin = location.origin) {
	const hash = `ticket=${encodeURIComponent(secret.ticket)}`;
	if (origin !== location.origin) {
		location.assign(`${origin}/#${hash}`);
		return;
	}
	adopting = true;
	location.hash = hash;
	location.reload();
}
export function refusalReason(): RefusalReason | null {
	try {
		const stored = sessionStorage.getItem(refusedKey);
		// "1" is what builds before the reason was recorded stored.
		if (stored !== null) return stored === "ticket" ? "ticket" : "credential";
	} catch {
		/* Storage may be disabled; the in-memory reason still holds for this document. */
	}
	return refusal;
}
export function lastTokenWasRefused() {
	return refusalReason() !== null;
}

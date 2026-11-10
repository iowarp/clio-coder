/** What a launch link carried: a single-use launch ticket, or a launch token from a link made before 0.7.1. */
export interface LaunchSecret {
	ticket?: string;
	token?: string;
	/** The launch token an earlier version stored in this browser, already deleted; it opens one client. */
	legacy?: string;
}
/**
 * Read once and cleared from the address bar. The launch token is never stored: a reloaded or reopened
 * window reconnects with its own expiring credential (`credentials.ts`), and a stored token from an
 * earlier version is deleted here and handed over once, so an upgraded browser stays connected.
 */
export function launchSecret(): LaunchSecret {
	const params = new URLSearchParams(location.hash.slice(1));
	const ticket = params.get("ticket") ?? undefined;
	const token = params.get("token") ?? undefined;
	let legacy: string | null = null;
	try {
		legacy = localStorage.getItem(legacyTokenKey);
	} catch {
		/* Storage may be disabled; then nothing was stored either. */
	}
	for (const drop of [
		() => localStorage.removeItem(legacyTokenKey),
		() => sessionStorage.removeItem("clio-coder-token"),
	])
		try {
			drop();
		} catch {
			/* Storage may be disabled; then nothing was stored either. */
		}
	if (ticket === undefined && token === undefined)
		return legacy !== null && /^[\w-]{1,256}$/.test(legacy) ? { legacy } : {};
	history.replaceState(null, "", location.pathname + location.search);
	try {
		sessionStorage.removeItem(refusedKey);
	} catch {
		/* The fresh link still works without browser storage. */
	}
	if (ticket !== undefined) return /^[\w-]{43}$/.test(ticket) ? { ticket } : {};
	if (token === undefined || !/^[\w-]{1,256}$/.test(token)) return {};
	console.warn("Clio Coder: #token= links are deprecated; open the app with clio-coder gui.");
	return { token };
}
const legacyTokenKey = "clio-coder-pwa-token";
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
/** A refused token is dropped at once, so a reload asks for a link instead of failing the same way again. */
export function dropStoredToken() {
	for (const drop of [
		() => localStorage.removeItem(rememberedCredentialKey),
		// Survives a reload, so the page still says why it is disconnected rather than "no token yet".
		() => sessionStorage.setItem(refusedKey, "1"),
	])
		try {
			drop();
		} catch {
			/* Storage may be disabled. */
		}
}
/** Adopt a token the operator pasted. It goes through the same launch path as a link, so it is validated once. */
export function adoptToken(token: string, origin = location.origin) {
	if (origin !== location.origin) {
		location.assign(`${origin}/#token=${encodeURIComponent(token)}`);
		return;
	}
	location.hash = `token=${encodeURIComponent(token)}`;
	location.reload();
}
export function lastTokenWasRefused() {
	try {
		return sessionStorage.getItem(refusedKey) === "1";
	} catch {
		return false;
	}
}

export function launchToken() {
	const token = new URLSearchParams(location.hash.slice(1)).get("token");
	if (token) {
		history.replaceState(null, "", location.pathname + location.search);
		if (!/^[\w-]{1,256}$/.test(token)) return "";
		try {
			sessionStorage.setItem("clio-coder-token", token);
			sessionStorage.removeItem(refusedKey);
		} catch {
			/* The launch link still works without browser storage. */
		}
		return token;
	}
	try {
		return sessionStorage.getItem("clio-coder-token") ?? localStorage.getItem(rememberedTokenKey) ?? "";
	} catch {
		return "";
	}
}
export const rememberedTokenKey = "clio-coder-pwa-token";
const refusedKey = "clio-coder-token-refused";
/** Only a successfully authenticated background endpoint may request persistence. */
export function rememberBrowser(token: string) {
	try {
		localStorage.setItem(rememberedTokenKey, token);
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
 * stored launch token and its drafts and reloads to ask for a fresh link. `revoke` is the window's own
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
		localStorage.removeItem(rememberedTokenKey);
	} catch {
		/* Storage may be disabled. */
	}
	try {
		sessionStorage.removeItem("clio-coder-token");
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
		() => sessionStorage.removeItem("clio-coder-token"),
		() => localStorage.removeItem(rememberedTokenKey),
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

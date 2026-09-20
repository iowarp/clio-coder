export function launchToken() {
	const token = new URLSearchParams(location.hash.slice(1)).get("token");
	if (token) {
		history.replaceState(null, "", location.pathname + location.search);
		if (!/^[\w-]{1,256}$/.test(token)) return "";
		try {
			sessionStorage.setItem("clio-coder-token", token);
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
/** Only a successfully authenticated background endpoint may request persistence. */
export function rememberBrowser(token: string) {
	try {
		localStorage.setItem(rememberedTokenKey, token);
		return true;
	} catch {
		return false;
	}
}
export function forgetBrowser() {
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

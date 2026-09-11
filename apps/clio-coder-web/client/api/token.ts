export function launchToken() {
	const token = new URLSearchParams(location.hash.slice(1)).get("token");
	if (token) {
		sessionStorage.setItem("clio-coder-token", token);
		history.replaceState(null, "", location.pathname + location.search);
	}
	return token ?? sessionStorage.getItem("clio-coder-token") ?? "";
}

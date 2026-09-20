const button = document.getElementById("retry"),
	status = document.getElementById("status");
let pending = false,
	timer;
async function reconnect() {
	if (pending) return;
	pending = true;
	button.disabled = true;
	try {
		const response = await fetch("/manifest.webmanifest", { cache: "no-store", signal: AbortSignal.timeout(2000) });
		if (response.ok && (await response.json()).name === "Clio Coder") {
			location.reload();
			return;
		}
	} catch {
		/* An unavailable local service is expected during restart or sleep. */
	}
	status.textContent = "Still waiting for Clio. Your work stays in Clio; nothing has been sent.";
	pending = false;
	button.disabled = false;
	clearTimeout(timer);
	timer = setTimeout(reconnect, 3000);
}
button.addEventListener("click", reconnect);
window.addEventListener("online", reconnect);
window.addEventListener("pagehide", () => clearTimeout(timer));
void reconnect();

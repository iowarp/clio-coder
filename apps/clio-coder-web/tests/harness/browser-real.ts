import { processServer } from "./process-server.js";
import { realAcpHome } from "./real-acp.js";

const fixture = await realAcpHome();
const server = await processServer(fixture.env);
console.log(`workspace=${fixture.home.path}`);
console.log(server.url);
let closing = false;
const close = async () => {
	if (closing) return;
	closing = true;
	await server.close();
	await fixture.close();
};
process.once("SIGINT", () => {
	void close();
});
process.once("SIGTERM", () => {
	void close();
});

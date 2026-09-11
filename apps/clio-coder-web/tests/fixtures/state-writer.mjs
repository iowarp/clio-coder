import { AppFiles } from "../../server/state/files.js";

const files = new AppFiles(process.argv[2]);
for (let i = 0; i < 15; i++)
	await files.update("children", (current) => ({ value: [...current, `${process.pid}:${i}`], result: null }));

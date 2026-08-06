import { strictEqual } from "node:assert/strict";
import { readFileSync } from "node:fs";

strictEqual(readFileSync("planted-fact.txt", "utf8"), "CLIO-CONTINUITY-7F4C2A91\n");
process.stdout.write("compaction-continuity: planted fact intact\n");

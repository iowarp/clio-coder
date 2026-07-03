import { strictEqual } from "node:assert/strict";
import { add } from "./math.js";

strictEqual(add(2, 3), 5);
strictEqual(add(-4, 9), 5);

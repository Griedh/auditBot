import test from "node:test";
import assert from "node:assert/strict";
import { inForbiddenPath } from "./gates.js";

test("matches when file is inside forbidden directory", () => {
  assert.equal(inForbiddenPath("src/app/index.ts", ["src/app"]), true);
});

test("does not match sibling directory sharing prefix", () => {
  assert.equal(inForbiddenPath("src/application/index.ts", ["src/app"]), false);
});

test("matches exact forbidden file entry", () => {
  assert.equal(inForbiddenPath("src/app/index.ts", ["src/app/index.ts"]), true);
});

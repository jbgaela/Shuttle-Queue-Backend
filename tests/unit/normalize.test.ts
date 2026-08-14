import assert from "node:assert/strict";
import test from "node:test";
import { normalizeName, normalizeText } from "../../src/lib/normalize.js";

test("player display names are stored with compatibility-normalized whitespace", () => {
  assert.equal(normalizeText("  Ａｌｉｃｅ   Santos  "), "Alice Santos");
});

test("player duplicate keys are case-insensitive", () => {
  assert.equal(normalizeName("  ALICE   Santos  "), "alice santos");
});

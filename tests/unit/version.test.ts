import assert from "node:assert/strict";
import test from "node:test";
import { parseBodyVersion, parseIfMatchVersion, resolveProxySafeVersion } from "../../src/lib/version.js";

test("workspace version parser accepts legacy and quoted If-Match values", () => {
  assert.equal(parseIfMatchVersion("42"), 42);
  assert.equal(parseIfMatchVersion('"42"'), 42);
  assert.equal(parseIfMatchVersion("  \"42\"  "), 42);
});

test("workspace version parser rejects malformed or unsafe If-Match values", () => {
  assert.equal(parseIfMatchVersion(undefined), undefined);
  assert.equal(parseIfMatchVersion(""), undefined);
  assert.equal(parseIfMatchVersion('W/"42"'), undefined);
  assert.equal(parseIfMatchVersion('"42,43"'), undefined);
  assert.equal(parseIfMatchVersion("9007199254740992"), undefined);
});

test("body version fallback accepts only safe integers", () => {
  assert.equal(parseBodyVersion(42), 42);
  assert.equal(parseBodyVersion(undefined), undefined);
  assert.equal(parseBodyVersion("42"), undefined);
  assert.equal(parseBodyVersion(42.5), undefined);
  assert.equal(parseBodyVersion(Number.MAX_SAFE_INTEGER + 1), undefined);
});

test("proxy-safe version resolution falls back to the body when the proxy omits If-Match", () => {
  assert.deepEqual(resolveProxySafeVersion(undefined, 42), {
    headerPresent: false,
    bodyPresent: true,
    mismatch: false,
    version: 42,
  });
});

test("proxy-safe version resolution requires matching header and body versions", () => {
  assert.equal(resolveProxySafeVersion('"42"', 42).version, 42);
  assert.equal(resolveProxySafeVersion('"42"', 43).mismatch, true);
  assert.equal(resolveProxySafeVersion("not-a-version", 42).version, undefined);
  assert.equal(resolveProxySafeVersion(undefined, undefined).version, undefined);
});

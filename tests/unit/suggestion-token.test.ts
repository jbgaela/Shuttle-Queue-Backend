import test from "node:test";
import assert from "node:assert/strict";
import {
  parseAndVerifySuggestionToken,
  signSuggestionToken,
} from "../../src/lib/suggestion-token.js";

const secret = "unit-test-secret";
const payload = {
  queueMasterId: "master-1",
  revision: 4,
  mode: "GUIDED",
  key: "a,b|c,d",
  teamA: ["a", "b"],
  teamB: ["c", "d"],
  expiresAt: Date.now() + 60_000,
};

test("suggestion tokens round-trip with strict payload validation", () => {
  const token = signSuggestionToken(payload, secret, "v11-guided-matchmaking-optimized-search");
  const parsed = parseAndVerifySuggestionToken(token, secret);
  assert.equal(parsed.algorithmVersion, "v11-guided-matchmaking-optimized-search");
  assert.equal(parsed.mode, "GUIDED");
  assert.deepEqual(parsed.teamA, ["a", "b"]);
});

test("suggestion tokens reject tampering, extra segments, malformed base64url, and invalid teams", () => {
  const token = signSuggestionToken(payload, secret, "v11-guided-matchmaking-optimized-search");
  const [body, signature] = token.split(".");
  assert.throws(() => parseAndVerifySuggestionToken(`${body}.${signature}.extra`, secret));
  assert.throws(() => parseAndVerifySuggestionToken(`${body}!.${signature}`, secret));
  const alteredSignature = `${signature!.slice(0, -1)}${signature!.endsWith("A") ? "B" : "A"}`;
  assert.throws(() => parseAndVerifySuggestionToken(`${body}.${alteredSignature}`, secret));
  const invalid = signSuggestionToken(
    { ...payload, teamB: ["a", "d"], key: "a,b|a,d" },
    secret,
    "v11-guided-matchmaking-optimized-search",
  );
  assert.throws(() => parseAndVerifySuggestionToken(invalid, secret));
});

test("balanced tokens require a valid strength gap and non-balanced tokens reject one", () => {
  const balanced = signSuggestionToken(
    { ...payload, mode: "BALANCED", strengthGap: 2 },
    secret,
    "v11-guided-matchmaking-optimized-search",
  );
  assert.equal(parseAndVerifySuggestionToken(balanced, secret).strengthGap, 2);
  const missing = signSuggestionToken(
    { ...payload, mode: "BALANCED" },
    secret,
    "v11-guided-matchmaking-optimized-search",
  );
  assert.throws(() => parseAndVerifySuggestionToken(missing, secret));
  const extra = signSuggestionToken(
    { ...payload, strengthGap: 1 },
    secret,
    "v11-guided-matchmaking-optimized-search",
  );
  assert.throws(() => parseAndVerifySuggestionToken(extra, secret));
});

test("Auto Create tokens require valid Open-mode priority and skill metadata", () => {
  const autoCreate = {
    ...payload,
    mode: "OPEN",
    strategy: "AUTO_CREATE",
    priorityPlayerId: "a",
    skillRange: 2,
  };
  const token = signSuggestionToken(autoCreate, secret, "v1-auto-create");
  const parsed = parseAndVerifySuggestionToken(token, secret);
  assert.equal(parsed.strategy, "AUTO_CREATE");
  assert.equal(parsed.priorityPlayerId, "a");
  assert.equal(parsed.skillRange, 2);
  assert.throws(() =>
    parseAndVerifySuggestionToken(
      signSuggestionToken({ ...autoCreate, mode: "BALANCED" }, secret, "v1-auto-create"),
      secret,
    ),
  );
  assert.throws(() =>
    parseAndVerifySuggestionToken(
      signSuggestionToken({ ...autoCreate, priorityPlayerId: undefined }, secret, "v1-auto-create"),
      secret,
    ),
  );
  assert.throws(() =>
    parseAndVerifySuggestionToken(
      signSuggestionToken({ ...autoCreate, skillRange: 6 }, secret, "v1-auto-create"),
      secret,
    ),
  );
});

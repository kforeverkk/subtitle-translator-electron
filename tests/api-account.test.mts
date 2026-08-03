import assert from "node:assert/strict";
import test from "node:test";
import {
  createApiAccountIdentity,
  getFirstValidApiKey,
  normalizeApiBaseUrl,
} from "../electron/main/utils/api-account.ts";

test("selects and trims the first non-empty API key", () => {
  assert.equal(getFirstValidApiKey(["  ", " key-one ", "key-two"]), "key-one");
  assert.throws(
    () => getFirstValidApiKey(["", "  "]),
    /ERR_NO_VALID_API_KEYS/
  );
});

test("normalizes equivalent API base URLs to one account URL", () => {
  assert.equal(
    normalizeApiBaseUrl("HTTPS://API.Example.com:443/v1/"),
    "https://api.example.com/v1"
  );
  assert.equal(
    normalizeApiBaseUrl("http://LOCALHOST:80/"),
    "http://localhost"
  );
});

test("uses a stable digest without exposing the raw API key", () => {
  const identity = createApiAccountIdentity(
    "https://api.example.com/v1/",
    "super-secret-key"
  );

  assert.equal(identity.includes("super-secret-key"), false);
  assert.match(identity, /^https:\/\/api\.example\.com\/v1\n[a-f\d]{64}$/);
  assert.equal(
    identity,
    createApiAccountIdentity("https://api.example.com/v1", "super-secret-key")
  );
  assert.notEqual(
    identity,
    createApiAccountIdentity("https://api.example.com/v1", "other-key")
  );
});

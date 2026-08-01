import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { assertReleaseVersion } from "../scripts/verify-release-version.mjs";
import { isNewerVersion } from "../src/utils/version.ts";

test("accepts a release tag that exactly matches the source version", () => {
  assert.doesNotThrow(() => assertReleaseVersion("2.1.1", "2.1.1"));
});

test("rejects missing or mismatched release tags", () => {
  assert.throws(
    () => assertReleaseVersion("2.1.1", undefined),
    /RELEASE_VERSION is required/
  );
  assert.throws(
    () => assertReleaseVersion("2.1.1", "2.1.2"),
    /does not match package\.json version/
  );
  assert.throws(
    () => assertReleaseVersion("2.1.1", "v2.1.1"),
    /does not match package\.json version/
  );
});

test("CI installs the pnpm version declared by packageManager", () => {
  const packageJson = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8")
  );
  assert.match(packageJson.packageManager, /^pnpm@\d+\.\d+\.\d+$/);

  for (const workflowName of ["build.yml", "quality.yml"]) {
    const workflow = readFileSync(
      new URL(`../.github/workflows/${workflowName}`, import.meta.url),
      "utf8"
    );
    assert.match(
      workflow,
      /- name: Setup pnpm\r?\n\s+uses: pnpm\/action-setup@v6\r?\n\r?\n\s+- name: Setup Node\.js/
    );
    assert.doesNotMatch(workflow, /npm\s+(?:i|install)\s+-g\s+pnpm/);
  }
});

test("only treats a greater release as newer", () => {
  assert.equal(isNewerVersion("2.0.0", "2.0.1"), true);
  assert.equal(isNewerVersion("2.0.0", "2.0.0"), false);
  assert.equal(isNewerVersion("2.0.0", "1.8.0"), false);
});

test("normalizes a v-prefixed release tag for comparison", () => {
  assert.equal(isNewerVersion("2.0.0", "v2.0.0"), false);
  assert.equal(isNewerVersion("2.0.0", "v2.1.0"), true);
});

test("follows SemVer pre-release precedence and ignores build metadata", () => {
  assert.equal(isNewerVersion("2.0.0-beta.1", "2.0.0-beta.2"), true);
  assert.equal(isNewerVersion("2.0.0-beta.2", "2.0.0"), true);
  assert.equal(isNewerVersion("2.0.0", "2.0.0-beta.3"), false);
  assert.equal(isNewerVersion("2.0.0+build.1", "2.0.0+build.2"), false);
});

test("ignores malformed versions instead of showing a false update", () => {
  assert.equal(isNewerVersion("2.0", "3.0.0"), false);
  assert.equal(isNewerVersion("2.0.0", "latest"), false);
  assert.equal(isNewerVersion("2.0.0", "2.0.0-01"), false);
});

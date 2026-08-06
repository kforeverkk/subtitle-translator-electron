import assert from "node:assert/strict";
import test from "node:test";
import {
  getExclusivePathClaimConflicts,
  getPathClaimKey,
  hasSharedPathClaim,
  hasPathClaimConflict,
  registerSharedPathClaims,
} from "../electron/main/utils/path-claims.ts";

test("case-folds path claims on case-insensitive desktop platforms", () => {
  assert.equal(
    getPathClaimKey("/tmp/Output/Foo.srt", "darwin"),
    getPathClaimKey("/tmp/output/foo.srt", "darwin")
  );
  assert.equal(
    getPathClaimKey("/tmp/Output/Foo.srt", "win32"),
    getPathClaimKey("/tmp/output/foo.srt", "win32")
  );
});

test("preserves case on Linux", () => {
  assert.notEqual(
    getPathClaimKey("/tmp/Output/Foo.srt", "linux"),
    getPathClaimKey("/tmp/output/foo.srt", "linux")
  );
});

test("keeps request-wide claims after an active writer releases", () => {
  const outputKey = getPathClaimKey("/tmp/output/episode.srt", "darwin");
  const batchClaims = new Set([outputKey]);
  const activeClaims = new Set<string>();

  assert.equal(
    hasPathClaimConflict([outputKey], batchClaims, activeClaims),
    true
  );
});

test("allows shared readers and releases only one batch registration", () => {
  const inputKey = getPathClaimKey("/tmp/input/movie.srt", "linux");
  const activeInputClaims = new Map<string, number>();
  const releaseFirst = registerSharedPathClaims(
    [inputKey, inputKey],
    activeInputClaims
  );
  const releaseSecond = registerSharedPathClaims(
    [inputKey],
    activeInputClaims
  );

  assert.equal(activeInputClaims.get(inputKey), 2);
  assert.equal(hasSharedPathClaim(inputKey, activeInputClaims), true);

  releaseFirst();
  assert.equal(activeInputClaims.get(inputKey), 1);
  assert.equal(hasSharedPathClaim(inputKey, activeInputClaims), true);

  releaseSecond();
  assert.equal(activeInputClaims.has(inputKey), false);
  assert.equal(hasSharedPathClaim(inputKey, activeInputClaims), false);
});

test("finds only new inputs already owned by active writers", () => {
  const safeInput = getPathClaimKey("/tmp/input/movie.srt", "linux");
  const changingInput = getPathClaimKey(
    "/tmp/input/movie.en.srt",
    "linux"
  );
  const activeOutputClaims = new Set([changingInput]);

  assert.deepEqual(
    getExclusivePathClaimConflicts(
      [safeInput, changingInput, changingInput],
      activeOutputClaims
    ),
    new Set([changingInput])
  );
});

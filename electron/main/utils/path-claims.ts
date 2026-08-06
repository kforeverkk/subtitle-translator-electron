import path from "node:path";

export function getPathClaimKey(
  filePath: string,
  platform: NodeJS.Platform = process.platform
): string {
  const normalizedPath = path.resolve(filePath).normalize("NFC");
  return platform === "win32" || platform === "darwin"
    ? normalizedPath.toLowerCase()
    : normalizedPath;
}

export function hasPathClaimConflict(
  keys: readonly string[],
  batchClaims: ReadonlySet<string>,
  activeClaims: ReadonlySet<string>
): boolean {
  return (
    new Set(keys).size !== keys.length ||
    keys.some((key) => batchClaims.has(key) || activeClaims.has(key))
  );
}

export function registerSharedPathClaims(
  keys: readonly string[],
  activeClaimCounts: Map<string, number>
): () => void {
  const uniqueKeys = new Set(keys);
  for (const key of uniqueKeys) {
    activeClaimCounts.set(key, (activeClaimCounts.get(key) ?? 0) + 1);
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const key of uniqueKeys) {
      const remaining = (activeClaimCounts.get(key) ?? 0) - 1;
      if (remaining > 0) {
        activeClaimCounts.set(key, remaining);
      } else {
        activeClaimCounts.delete(key);
      }
    }
  };
}

export function hasSharedPathClaim(
  key: string,
  activeClaimCounts: ReadonlyMap<string, number>
): boolean {
  return (activeClaimCounts.get(key) ?? 0) > 0;
}

export function getExclusivePathClaimConflicts(
  keys: readonly string[],
  activeExclusiveClaims: ReadonlySet<string>
): Set<string> {
  return new Set(keys.filter((key) => activeExclusiveClaims.has(key)));
}

import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const packageJsonUrl = new URL("../package.json", import.meta.url);

export function assertReleaseVersion(sourceVersion, releaseVersion) {
  if (!releaseVersion) {
    throw new Error("RELEASE_VERSION is required");
  }

  if (sourceVersion !== releaseVersion) {
    throw new Error(
      `Release tag "${releaseVersion}" does not match package.json version "${sourceVersion}". ` +
        "Update and commit package.json before creating the release tag."
    );
  }
}

function run() {
  const packageJson = JSON.parse(readFileSync(packageJsonUrl, "utf8"));

  try {
    assertReleaseVersion(packageJson.version, process.env.RELEASE_VERSION);
    console.log(`Release version verified: ${packageJson.version}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`::error title=Release version mismatch::${message}`);
    process.exitCode = 1;
  }
}

const entryPointUrl = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : undefined;

if (entryPointUrl === import.meta.url) {
  run();
}

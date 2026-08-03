import { constants, accessSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      const isMissingRelativeModule =
        error?.code === "ERR_MODULE_NOT_FOUND" &&
        (specifier.startsWith("./") || specifier.startsWith("../")) &&
        !/\.[cm]?[jt]s$/.test(specifier);
      if (!isMissingRelativeModule || !context.parentURL) throw error;

      const typescriptUrl = new URL(`${specifier}.ts`, context.parentURL);
      try {
        accessSync(fileURLToPath(typescriptUrl), constants.R_OK);
      } catch {
        throw error;
      }
      return nextResolve(typescriptUrl.href, context);
    }
  },
});

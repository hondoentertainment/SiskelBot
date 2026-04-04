/**
 * Fail if package.json dependency keys are missing from package-lock.json root
 * (catches forgotten npm install after editing package.json).
 */
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));

const rootLock = lock.packages?.[""];
if (!rootLock) {
  console.error("verify-package-sync: lock root package missing");
  process.exit(1);
}

const deps = {
  ...pkg.dependencies,
  ...pkg.devDependencies,
  ...pkg.optionalDependencies,
};
const lockDeps = {
  ...rootLock.dependencies,
  ...rootLock.devDependencies,
  ...rootLock.optionalDependencies,
};

const missing = Object.keys(deps).filter((name) => !(name in lockDeps));
if (missing.length) {
  console.error("verify-package-sync: in package.json but not lockfile root:", missing.join(", "));
  process.exit(1);
}

console.log("verify-package-sync: ok");

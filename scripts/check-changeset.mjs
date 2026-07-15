/* global console */
import { spawnSync } from "node:child_process";
import process from "node:process";

const [base] = process.argv.slice(2).filter((argument) => argument !== "--");
if (!base) {
  console.error("Usage: pnpm changeset:check -- <base-ref>");
  process.exit(2);
}

const result = spawnSync("git", ["diff", "--name-only", "--diff-filter=ACMR", `${base}...HEAD`], {
  encoding: "utf8",
});
if (result.status !== 0) {
  process.stderr.write(result.stderr);
  process.exit(result.status ?? 1);
}

const changesets = result.stdout
  .split("\n")
  .filter((path) => /^\.changeset\/[^/]+\.md$/.test(path) && path !== ".changeset/README.md");

if (changesets.length === 0) {
  console.error(
    "This pull request has no release intent. Run `pnpm changeset` for a package release "
    + "or `pnpm changeset --empty` for an explicit no-release change.",
  );
  process.exit(1);
}

console.log(`Release intent recorded in ${changesets.join(", ")}`);

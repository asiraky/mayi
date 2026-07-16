#!/usr/bin/env node
// Preflight guard for `pnpm deploy:site`. `wrangler deploy` publishes the
// working tree straight to the production custom domain (mayi.sh), ignoring
// git and CI. That is how docs that only ever lived on a branch reached
// production once — and how a later main deploy silently wiped them. This
// guard refuses to run unless the deploy would reflect exactly what is on
// origin/main: on the main branch, a clean tree, and in sync with the remote.
//
// It is intentionally strict. CI (the main-gated deploy-site job) remains the
// normal path; this only protects the manual escape hatch. For a deliberate,
// eyes-open override (e.g. an emergency hotfix from a branch), set
// MAYI_ALLOW_UNSAFE_SITE_DEPLOY=1 — it is loud on purpose.

/* global console, process */
import { execFileSync } from "node:child_process";

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function fail(reason, remedy) {
  console.error(`\n✘ deploy:site refused: ${reason}`);
  if (remedy) console.error(`  ${remedy}`);
  console.error(
    "\n  This command publishes your working tree directly to production (mayi.sh).",
  );
  console.error(
    "  Land your change on main and let CI deploy it, or fix the above and retry.",
  );
  console.error(
    "  Deliberate override: MAYI_ALLOW_UNSAFE_SITE_DEPLOY=1 pnpm deploy:site\n",
  );
  process.exit(1);
}

if (process.env.MAYI_ALLOW_UNSAFE_SITE_DEPLOY === "1") {
  console.warn(
    "\n⚠️  MAYI_ALLOW_UNSAFE_SITE_DEPLOY=1 — skipping the main/clean/in-sync guard.",
  );
  console.warn("   You are publishing the current working tree to production.\n");
  process.exit(0);
}

const branch = git("rev-parse", "--abbrev-ref", "HEAD");
if (branch !== "main") {
  fail(`current branch is "${branch}", not main`, "Run: git switch main");
}

const dirty = git("status", "--porcelain");
if (dirty) {
  fail(
    "the working tree has uncommitted changes",
    "Commit or stash them so production reflects committed history.",
  );
}

// Compare against the remote's actual tip, not a stale remote-tracking ref.
try {
  execFileSync("git", ["fetch", "--quiet", "origin", "main"], { stdio: "inherit" });
} catch {
  fail("could not fetch origin/main", "Check your network/remote and retry.");
}

const local = git("rev-parse", "HEAD");
const remote = git("rev-parse", "origin/main");
if (local !== remote) {
  const ahead = git("rev-list", "--count", "origin/main..HEAD");
  const behind = git("rev-list", "--count", "HEAD..origin/main");
  fail(
    `local main is out of sync with origin/main (ahead ${ahead}, behind ${behind})`,
    behind !== "0"
      ? "Run: git pull --ff-only  (so you deploy what is actually merged)"
      : "Push your commits and let CI deploy them, rather than deploying locally.",
  );
}

console.log(`✔ deploy:site preflight passed — main @ ${local.slice(0, 9)}, clean, in sync with origin.`);

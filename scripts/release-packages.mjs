/* global console */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import process from "node:process";

const PUBLIC_PACKAGES = ["packages/sdk", "packages/eve"];
const EXPECTED_REPOSITORY = "https://github.com/asiraky/mayi";
const dryRun = process.argv.includes("--dry-run");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    env: process.env,
    stdio: options.capture ? "pipe" : "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}`);
  }
  return result;
}

function packageManifest(directory) {
  return JSON.parse(readFileSync(`${directory}/package.json`, "utf8"));
}

function major(version) {
  return Number.parseInt(version.split(".")[0] ?? "0", 10);
}

const packages = PUBLIC_PACKAGES.map((directory) => {
  const manifest = packageManifest(directory);
  if (manifest.private === true || manifest.publishConfig?.access !== "public") {
    throw new Error(`${manifest.name} must be a public package`);
  }
  if (manifest.repository?.url !== EXPECTED_REPOSITORY) {
    throw new Error(`${manifest.name} repository.url must remain exactly ${EXPECTED_REPOSITORY}`);
  }
  return { directory, name: manifest.name, version: manifest.version };
});

const workspace = JSON.parse(run("pnpm", ["list", "--recursive", "--depth", "-1", "--json"], { capture: true }).stdout);
const accidentallyPublic = workspace.filter((entry) => {
  if (!entry.path || entry.path === process.cwd()) return false;
  const manifest = packageManifest(`${entry.path}`);
  return manifest.private !== true && !packages.some((item) => item.name === manifest.name);
});
if (accidentallyPublic.length > 0) {
  throw new Error(`Only @mayi/sdk and @mayi/eve may be public; found ${accidentallyPublic.map((item) => item.name).join(", ")}`);
}

const prerelease = packages.filter((item) => item.version.includes("-"));
const channel = prerelease.length > 0 ? "next" : "latest";

console.log(`Release plan (${channel}):`);
for (const item of packages) console.log(`- ${item.name}@${item.version}`);

if (dryRun) {
  console.log("Dry run complete. This code path never invokes changeset publish, npm publish, git push, or gh release create.");
  process.exit(0);
}

if (process.env.GITHUB_ACTIONS !== "true"
  || process.env.GITHUB_EVENT_NAME !== "pull_request"
  || process.env.GITHUB_HEAD_REF !== "changeset-release/main"
  || process.env.GITHUB_REF !== "refs/heads/main"
  || !process.env.GITHUB_WORKFLOW_REF?.includes("/.github/workflows/release.yml@")) {
  throw new Error("Publishing is allowed only for the merged Changesets version PR in release.yml");
}
if (process.env.NPM_TOKEN || process.env.NODE_AUTH_TOKEN) {
  throw new Error("Token-based npm publishing is forbidden; use GitHub Actions OIDC");
}
if (!process.env.ACTIONS_ID_TOKEN_REQUEST_URL || !process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) {
  throw new Error("The GitHub Actions OIDC request environment is unavailable");
}
if (major(process.versions.node) < 24) throw new Error("Publishing requires Node.js 24 or later");
const npmVersion = run("npm", ["--version"], { capture: true }).stdout.trim();
const [npmMajor, npmMinor] = npmVersion.split(".").map(Number);
if (npmMajor < 11 || (npmMajor === 11 && npmMinor < 5)) {
  throw new Error(`Publishing requires npm >=11.5.1; found ${npmVersion}`);
}
const head = run("git", ["rev-parse", "HEAD"], { capture: true }).stdout.trim();
if (!process.env.GITHUB_SHA || head !== process.env.GITHUB_SHA) {
  throw new Error("The checkout must be the exact merged commit from the workflow event");
}

const intended = packages.filter((item) => {
  const previous = run("git", ["show", `${head}^:${item.directory}/package.json`], { capture: true });
  return JSON.parse(previous.stdout).version !== item.version;
});
if (intended.length === 0) {
  throw new Error("The merged Changesets PR did not change a public package version");
}
for (const item of packages.filter((candidate) => !intended.includes(candidate))) {
  const existing = run("npm", ["view", `${item.name}@${item.version}`, "version", "--json"], {
    capture: true,
    allowFailure: true,
  });
  if (existing.status !== 0 || JSON.parse(existing.stdout) !== item.version) {
    throw new Error(`Refusing to publish: unchanged package ${item.name}@${item.version} is missing from npm`);
  }
}

const unpublished = [];
const existingRemoteTags = new Set();
for (const item of intended) {
  const result = run("npm", ["view", `${item.name}@${item.version}`, "version", "--json"], {
    capture: true,
    allowFailure: true,
  });
  const tag = `${item.name}@${item.version}`;
  const remoteTag = run("git", ["ls-remote", "--exit-code", "--tags", "origin", `refs/tags/${tag}`], {
    capture: true,
    allowFailure: true,
  });
  if (remoteTag.status === 0) {
    const remoteCommit = remoteTag.stdout.trim().split(/\s+/)[0];
    if (remoteCommit !== head) throw new Error(`Immutable tag ${tag} does not point to this version commit`);
    existingRemoteTags.add(tag);
  } else if (remoteTag.status !== 2) {
    throw new Error(`Could not verify remote tag ${tag}`);
  }

  if (result.status === 0) {
    if (JSON.parse(result.stdout) !== item.version) throw new Error(`npm returned an unexpected version for ${tag}`);
    continue;
  }
  if (!`${result.stdout}\n${result.stderr}`.includes("E404")) {
    throw new Error(`Could not verify ${item.name}@${item.version} against npm`);
  }
  if (remoteTag.status === 0) throw new Error(`Refusing to publish because immutable tag ${tag} already exists`);
  unpublished.push(item);
}

const channels = new Set(unpublished.map((item) => item.version.includes("-") ? "next" : "latest"));

if (unpublished.length > 0) {
  if (channels.size !== 1) throw new Error("Refusing to mix latest and next publications");
  const publishArgs = ["exec", "changeset", "publish"];
  if ([...channels][0] === "next") publishArgs.push("--tag", "next");
  run("pnpm", publishArgs);
} else {
  console.log("All intended npm versions already exist; reconciling immutable tags and GitHub releases only.");
}

for (const item of intended) {
  const published = run("npm", ["view", `${item.name}@${item.version}`, "version", "--json"], { capture: true });
  if (JSON.parse(published.stdout) !== item.version) throw new Error(`npm did not return ${item.name}@${item.version}`);

  const tag = `${item.name}@${item.version}`;
  if (!existingRemoteTags.has(tag)) {
    const localTag = run("git", ["rev-parse", "--verify", `refs/tags/${tag}`], {
      capture: true,
      allowFailure: true,
    });
    if (localTag.status !== 0) run("git", ["tag", tag, head]);
    const tagCommit = run("git", ["rev-list", "-n", "1", tag], { capture: true }).stdout.trim();
    if (tagCommit !== head) throw new Error(`${tag} does not point to the published commit`);
    run("git", ["push", "origin", `refs/tags/${tag}:refs/tags/${tag}`]);
  }

  const changelog = readFileSync(`${item.directory}/CHANGELOG.md`, "utf8");
  const heading = `## ${item.version}\n`;
  const start = changelog.indexOf(heading);
  if (start === -1) throw new Error(`Missing ${item.name} ${item.version} changelog entry`);
  const contentStart = start + heading.length;
  const nextHeading = changelog.indexOf("\n## ", contentStart);
  const notes = changelog.slice(contentStart, nextHeading === -1 ? undefined : nextHeading).trim();
  if (!notes) throw new Error(`Empty ${item.name} ${item.version} changelog entry`);
  const existingRelease = run("gh", ["release", "view", tag, "--json", "tagName"], {
    capture: true,
    allowFailure: true,
  });
  if (existingRelease.status !== 0) {
    run("gh", [
      "release", "create", tag,
      "--verify-tag",
      "--target", head,
      "--title", tag,
      "--notes", notes,
    ]);
  }
}

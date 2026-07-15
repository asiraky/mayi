/* global console */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(packageDirectory, "../..");
const temporaryRoot = await mkdtemp(join(tmpdir(), "mayi-eve-package-"));
const packDirectory = join(temporaryRoot, "pack");
const fixtureDirectory = join(temporaryRoot, "fixture");

function run(command, arguments_, options = {}) {
  const result = spawnSync(command, arguments_, {
    cwd: options.cwd ?? packageDirectory,
    encoding: "utf8",
    env: process.env,
    stdio: options.capture ? "pipe" : "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${arguments_.join(" ")} failed with exit code ${result.status}\n${result.stdout ?? ""}${result.stderr ?? ""}`);
  }
  return result.stdout ?? "";
}

async function onlyArchive(prefix) {
  const archives = (await readdir(packDirectory))
    .filter((name) => name.startsWith(prefix) && name.endsWith(".tgz"));
  assert.equal(archives.length, 1, `expected one ${prefix} archive`);
  return join(packDirectory, archives[0]);
}

try {
  await Promise.all([
    mkdir(packDirectory, { recursive: true }),
    mkdir(fixtureDirectory, { recursive: true }),
  ]);

  console.log("\nPacking @mayi/sdk and @mayi/eve with pnpm pack...");
  run("corepack", ["pnpm", "--filter", "@mayi/sdk", "pack", "--pack-destination", packDirectory], {
    cwd: repositoryRoot,
  });
  run("corepack", ["pnpm", "pack", "--pack-destination", packDirectory]);
  const sdkArchive = await onlyArchive("mayi-sdk-");
  const eveArchive = await onlyArchive("mayi-eve-");

  const tarListing = run("tar", ["-tzf", eveArchive], { capture: true })
    .trim().split("\n").filter(Boolean);
  console.log("\n@mayi/eve tarball contents:");
  console.log(tarListing.join("\n"));
  assert.deepEqual(tarListing.sort(), [
    "package/LICENSE",
    "package/README.md",
    "package/dist/index.d.ts",
    "package/dist/index.js",
    "package/dist/index.js.map",
    "package/package.json",
  ].sort());
  for (const entry of tarListing) {
    assert(!/(?:^|\/)(?:src|scripts|test|tests)(?:\/|$)/i.test(entry), `source or test material was packed: ${entry}`);
    assert(!/(?:^|\/)(?:\.env(?:\.|$)|[^/]*\.(?:pem|key|jwk)|id_rsa)/i.test(entry), `possible secret material was packed: ${entry}`);
  }

  const inspectDirectory = join(temporaryRoot, "inspect");
  await mkdir(inspectDirectory);
  run("tar", ["-xzf", eveArchive, "-C", inspectDirectory]);
  const packedPackage = JSON.parse(await readFile(join(inspectDirectory, "package/package.json"), "utf8"));
  assert.deepEqual(packedPackage.dependencies, { "@mayi/sdk": "^0.1.0" });
  assert.deepEqual(packedPackage.peerDependencies, { eve: "0.24.2" });
  assert.equal(packedPackage.repository.url, "https://github.com/asiraky/mayi");
  assert.equal(packedPackage.publishConfig.access, "public");
  assert.equal(packedPackage.types, "./dist/index.d.ts");
  assert.deepEqual(packedPackage.files, ["dist", "README.md", "LICENSE"]);
  assert.equal(packedPackage.sideEffects, false);
  assert.equal(packedPackage.license, "Apache-2.0");
  assert.equal(packedPackage.engines.node, ">=24");
  assert.deepEqual(Object.keys(packedPackage.exports).sort(), [".", "./package.json"]);
  assert(!JSON.stringify(packedPackage).includes("workspace:"), "published manifest contains a workspace dependency");
  assert(!JSON.stringify(packedPackage.exports).includes("src/"), "published exports point to source files");

  for (const entry of ["package/dist/index.js", "package/dist/index.d.ts"]) {
    const contents = await readFile(join(inspectDirectory, entry), "utf8");
    assert(!contents.includes("@mayi/contracts"), `${entry} references internal contracts`);
    assert(!contents.includes("packages/sdk/src"), `${entry} reaches into SDK source`);
    assert(!contents.includes(repositoryRoot), `${entry} contains an absolute monorepo path`);
    assert(!/(?:\.\.\/)+src\//.test(contents), `${entry} reaches into a source tree`);
  }
  const map = JSON.parse(await readFile(join(inspectDirectory, "package/dist/index.js.map"), "utf8"));
  assert(!("sourcesContent" in map), "source map embeds source content");
  assert(map.sources.every((source) => /^https:\/\/raw\.githubusercontent\.com\//.test(source)), "source map contains a non-public source path");
  assert(!JSON.stringify(map).includes(repositoryRoot), "source map contains an absolute monorepo path");

  await writeFile(join(fixtureDirectory, "package.json"), JSON.stringify({ private: true, type: "module" }, null, 2));
  console.log(`\nInstalling both Mayi tarballs and eve@0.24.2 in a clean fixture: ${fixtureDirectory}`);
  run("npm", [
    "install",
    "--ignore-scripts",
    "--no-package-lock",
    "--no-audit",
    "--no-fund",
    sdkArchive,
    eveArchive,
    "eve@0.24.2",
    "@types/node@26.1.1",
    "@types/json-schema@7.0.15",
  ], { cwd: fixtureDirectory });

  const runtimeFixture = `
    import { MAYI_CALLBACK_PATH, mayiChannel, resolvePublicOrigin } from "@mayi/eve";
    import manifest from "@mayi/eve/package.json" with { type: "json" };
    const channel = mayiChannel({ getAccessToken: async () => "fabricated-token" });
    if (channel.routes[0]?.path !== "/eve/v1/mayi/approval-resolved") throw new Error("route import failed");
    if (MAYI_CALLBACK_PATH !== channel.routes[0].path) throw new Error("callback constant mismatch");
    if (resolvePublicOrigin({ environment: { EVE_PUBLIC_ORIGIN: "https://agent.example" } }) !== "https://agent.example") throw new Error("origin resolver failed");
    if (manifest.peerDependencies?.eve !== "0.24.2") throw new Error("eve peer is not pinned");
    console.log("Runtime imports passed: channel, route, origin resolver, package.json");
  `;
  await writeFile(join(fixtureDirectory, "runtime.mjs"), runtimeFixture);
  run(process.execPath, ["runtime.mjs"], { cwd: fixtureDirectory });

  const installedEve = JSON.parse(await readFile(join(fixtureDirectory, "node_modules/eve/package.json"), "utf8"));
  assert.equal(installedEve.version, "0.24.2", "clean install did not use the tested Eve peer");

  const typeFixture = `
    import {
      mayiChannel,
      type MayiChannelConfig,
      type MayiReceiveTarget,
    } from "@mayi/eve";
    import type { Channel } from "eve/channels";

    const config: MayiChannelConfig = { getAccessToken: async () => "fabricated-token" };
    const channel: Channel<unknown, MayiReceiveTarget> = mayiChannel(config);
    const target: MayiReceiveTarget = { mayiUserId: "ApproverAbcd" };
    void [channel, target];
  `;
  await writeFile(join(fixtureDirectory, "types.ts"), typeFixture);
  await writeFile(join(fixtureDirectory, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      strict: true,
      noEmit: true,
      skipLibCheck: false,
      types: ["node"],
      lib: ["ES2022", "DOM", "DOM.Iterable", "ESNext.Disposable"],
    },
    files: ["types.ts"],
  }, null, 2));
  run(process.execPath, [join(repositoryRoot, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.json"], {
    cwd: fixtureDirectory,
  });
  console.log("TypeScript resolution passed for @mayi/eve and its Eve peer");
  console.log("\n@mayi/eve package artifact verification passed.");
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

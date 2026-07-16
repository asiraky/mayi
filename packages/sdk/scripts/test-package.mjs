/* global console */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(packageDirectory, "../..");
const temporaryRoot = await mkdtemp(join(tmpdir(), "mayi-sdk-package-"));
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

try {
  await Promise.all([
    mkdir(packDirectory, { recursive: true }),
    mkdir(fixtureDirectory, { recursive: true }),
  ]);

  console.log("\nPacking @mayiapp/sdk with pnpm pack...");
  run("pnpm", ["pack", "--pack-destination", packDirectory]);
  const archives = (await readdir(packDirectory)).filter((name) => name.endsWith(".tgz"));
  assert.equal(archives.length, 1, "pnpm pack must create exactly one tarball");
  const archive = join(packDirectory, archives[0]);

  const tarListing = run("tar", ["-tzf", archive], { capture: true }).trim().split("\n").filter(Boolean);
  console.log("\nTarball contents:");
  console.log(tarListing.join("\n"));
  assert(tarListing.length > 0, "tarball must not be empty");
  for (const entry of tarListing) {
    assert.match(entry, /^package\/(?:dist\/[^/]+|package\.json|README\.md|LICENSE)$/, `unexpected tarball entry: ${entry}`);
    assert(!/(?:^|\/)(?:src|scripts|test|tests)(?:\/|$)/i.test(entry), `source or test material was packed: ${entry}`);
    assert(!/(?:^|\/)(?:\.env(?:\.|$)|[^/]*\.(?:pem|key|jwk)|id_rsa)/i.test(entry), `possible secret or key material was packed: ${entry}`);
  }
  for (const required of [
    "package/package.json",
    "package/README.md",
    "package/LICENSE",
    "package/dist/index.js",
    "package/dist/index.js.map",
    "package/dist/index.d.ts",
    "package/dist/callback-state.js",
    "package/dist/callback-state.js.map",
    "package/dist/callback-state.d.ts",
    "package/dist/webhook-verifier.js",
    "package/dist/webhook-verifier.js.map",
    "package/dist/webhook-verifier.d.ts",
    "package/dist/cli.js",
    "package/dist/cli.js.map",
    "package/dist/cli.d.ts",
  ]) assert(tarListing.includes(required), `missing required tarball entry: ${required}`);

  const inspectDirectory = join(temporaryRoot, "inspect");
  await mkdir(inspectDirectory);
  run("tar", ["-xzf", archive, "-C", inspectDirectory]);
  const packedPackage = JSON.parse(await readFile(join(inspectDirectory, "package/package.json"), "utf8"));
  assert.deepEqual(packedPackage.dependencies, { jose: "^6.2.3" });
  assert.equal(packedPackage.repository.url, "https://github.com/asiraky/mayi");
  assert.equal(packedPackage.publishConfig.access, "public");
  assert.equal(packedPackage.types, "./dist/index.d.ts");
  assert.equal(packedPackage.bin.mayi, "./dist/cli.js");
  assert.deepEqual(packedPackage.files, ["dist", "README.md", "LICENSE"]);
  assert.equal(packedPackage.sideEffects, false);
  assert.equal(packedPackage.license, "Apache-2.0");
  assert.equal(packedPackage.engines.node, ">=22");
  assert.deepEqual(Object.keys(packedPackage.exports).sort(), [".", "./callback-state", "./package.json", "./webhook-verifier"]);
  assert(!JSON.stringify(packedPackage).includes("workspace:"), "published manifest contains a workspace dependency");
  assert(!JSON.stringify(packedPackage.exports).includes("src/"), "published exports point to source files");

  const packedCli = await readFile(join(inspectDirectory, "package/dist/cli.js"), "utf8");
  assert(packedCli.startsWith("#!/usr/bin/env node\n"), "built CLI is missing its Node shebang");

  const distFiles = tarListing.filter((entry) => entry.endsWith(".js") || entry.endsWith(".d.ts"));
  for (const entry of distFiles) {
    const contents = await readFile(join(inspectDirectory, entry), "utf8");
    assert(!contents.includes("@mayi/contracts"), `${entry} references @mayi/contracts`);
    assert(!contents.includes("packages/contracts"), `${entry} references the contracts source tree`);
    assert(!contents.includes(repositoryRoot), `${entry} contains an absolute monorepo path`);
    if (entry.endsWith(".js") || entry.endsWith(".d.ts")) {
      assert(!/(?:\.\.\/)+src\//.test(contents), `${entry} reaches into a source tree`);
    }
  }
  const sourceMaps = tarListing.filter((entry) => entry.endsWith(".js.map"));
  for (const entry of sourceMaps) {
    const map = JSON.parse(await readFile(join(inspectDirectory, entry), "utf8"));
    assert(!("sourcesContent" in map), `${entry} embeds source content`);
    assert(map.sources.every((source) => /^https:\/\/(?:raw\.githubusercontent\.com|unpkg\.com)\//.test(source)), `${entry} contains a non-public source path`);
    assert(!JSON.stringify(map).includes(repositoryRoot), `${entry} contains an absolute monorepo path`);
  }

  await writeFile(join(fixtureDirectory, "package.json"), JSON.stringify({ private: true, type: "module" }, null, 2));
  console.log(`\nInstalling tarball in clean fixture outside the monorepo: ${fixtureDirectory}`);
  run("npm", ["install", "--ignore-scripts", "--no-package-lock", "--no-audit", "--no-fund", archive], { cwd: fixtureDirectory });

  const runtimeFixture = `
    import * as sdk from "@mayiapp/sdk";
    import * as callbackState from "@mayiapp/sdk/callback-state";
    import * as webhookVerifier from "@mayiapp/sdk/webhook-verifier";
    import manifest from "@mayiapp/sdk/package.json" with { type: "json" };
    if (typeof sdk.MayiClient !== "function") throw new Error("main entry import failed");
    if (typeof callbackState.createCallbackStateCodec !== "function") throw new Error("callback-state import failed");
    if (typeof webhookVerifier.createWebhookVerifier !== "function") throw new Error("webhook-verifier import failed");
    if (manifest.dependencies?.jose !== "^6.2.3") throw new Error("jose is not a published runtime dependency");
    console.log("Runtime imports passed: main, callback-state, webhook-verifier, package.json");
  `;
  await writeFile(join(fixtureDirectory, "runtime.mjs"), runtimeFixture);
  run(process.execPath, ["runtime.mjs"], { cwd: fixtureDirectory });

  const installedJose = JSON.parse(await readFile(join(fixtureDirectory, "node_modules/jose/package.json"), "utf8"));
  assert.match(installedJose.version, /^6\./, "clean install did not resolve a compatible jose runtime dependency");
  console.log(`Resolved jose ${installedJose.version} from the clean install`);

  const typeFixture = `
    import { MayiClient, type InputResolvedEvent, type PendingApproval, type PendingInput } from "@mayiapp/sdk";
    import { createCallbackStateCodec, type CallbackStateCodec } from "@mayiapp/sdk/callback-state";
    import { createWebhookVerifier, type WebhookVerifier } from "@mayiapp/sdk/webhook-verifier";

    const client = new MayiClient({ origin: "https://mayi.example.com" });
    const pending: Promise<PendingApproval> = client.approvals.request({
      action: { kind: "tool-call", toolName: "deploy", callId: "call-1", input: {} },
      explanation: "Deploy",
      expiresInSeconds: 300,
      callback: { url: "https://agent.example.com/callback", state: "sealed-state" },
    }, { idempotencyKey: "request-1" });
    const pendingInput: Promise<PendingInput> = client.inputs.request({
      type: "select",
      prompt: "Which environment should receive this release?",
      options: [
        { id: "staging", label: "Staging" },
        { id: "production", label: "Production", style: "danger" },
      ],
      expiresInSeconds: 300,
      callback: { url: "https://agent.example.com/callback", state: "sealed-state" },
    }, { idempotencyKey: "input-1" });
    const codec: Promise<CallbackStateCodec> = createCallbackStateCodec({
      currentKey: { kid: "current", key: new Uint8Array(32) },
      maximumRetryWindowSeconds: 60,
    });
    const verifier: WebhookVerifier = createWebhookVerifier({
      mayiOrigin: "https://mayi.example.com",
      maximumEventAgeSeconds: 300,
    });
    const narrowInputEvent = async (): Promise<string | undefined> => {
      const result = await verifier.verify({ body: "{}", signature: "a.b.c" });
      if (result.duplicate || result.event.type !== "input.resolved") return undefined;
      const event: InputResolvedEvent = result.event;
      return event.status === "answered" ? event.answer.optionId ?? event.answer.text : event.status;
    };
    void [pending, pendingInput, codec, verifier, narrowInputEvent];
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
      lib: ["ES2022", "DOM", "DOM.Iterable"],
    },
    files: ["types.ts"],
  }, null, 2));
  run(process.execPath, [join(repositoryRoot, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.json"], { cwd: fixtureDirectory });
  console.log("TypeScript resolution passed for main and both subpath exports");
  console.log("\nPackage artifact verification passed.");
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

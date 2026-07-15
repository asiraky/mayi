import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { MAYI_CALLBACK_PATH } from "./origin";

interface CompiledRoute {
  readonly kind: "channel";
  readonly method: string;
  readonly urlPath: string;
}

describe("Eve compiler and Nitro route fixture", () => {
  it("compiles and mounts the authored callback path verbatim with Eve 0.24.2", async () => {
    const eveManifestPath = fileURLToPath(import.meta.resolve("eve/package.json"));
    const eveRoot = dirname(eveManifestPath);
    const normalizeChannel = await import(pathToFileURL(join(
      eveRoot,
      "dist/src/compiler/normalize-channel.js",
    )).href) as {
      compileChannelDefinition: (
        agentRoot: string,
        source: Record<string, string>,
      ) => Promise<CompiledRoute | readonly CompiledRoute[]>;
    };
    const channelRoutes = await import(pathToFileURL(join(
      eveRoot,
      "dist/src/internal/nitro/host/channel-routes.js",
    )).href) as {
      computeChannelRouteRegistrations: (host: unknown) => readonly { method: string; route: string }[];
      registerChannelVirtualHandlers: (nitro: unknown, input: unknown) => void;
    };
    const agentRoot = resolve(fileURLToPath(new URL("../test/fixtures/agent", import.meta.url)));
    const compiledValue = await normalizeChannel.compileChannelDefinition(agentRoot, {
      logicalPath: "channels/mayi.ts",
      sourceId: "channels/mayi.ts",
      sourceKind: "module",
    });
    const compiled = Array.isArray(compiledValue) ? compiledValue : [compiledValue];

    expect(compiled).toContainEqual(expect.objectContaining({
      kind: "channel",
      method: "POST",
      urlPath: MAYI_CALLBACK_PATH,
    }));

    const registrations = channelRoutes.computeChannelRouteRegistrations({
      compileResult: { manifest: { channels: compiled } },
    });
    const registration = registrations.find((item) => (
      item.method === "POST" && item.route === MAYI_CALLBACK_PATH
    ));
    expect(registration).toEqual({ method: "POST", route: MAYI_CALLBACK_PATH });

    const nitro = { options: { handlers: [] as unknown[], virtual: {} as Record<string, string> } };
    channelRoutes.registerChannelVirtualHandlers(nitro, {
      artifactsConfig: { kind: "production" },
      registrations: [registration],
    });
    expect(nitro.options.handlers).toContainEqual(expect.objectContaining({
      method: "POST",
      route: MAYI_CALLBACK_PATH,
    }));
  }, 30_000);
});

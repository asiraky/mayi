/* global console */
import { readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(packageDirectory, "../..");
const distDirectory = resolve(packageDirectory, "dist");
const pnpmMarker = `${sep}node_modules${sep}.pnpm${sep}`;

function dependencySourceUrl(absolutePath) {
  const dependencyPath = absolutePath.slice(absolutePath.indexOf(pnpmMarker) + pnpmMarker.length);
  const [packageDirectoryName, ...remainder] = dependencyPath.split(sep);
  const versionSeparator = packageDirectoryName.lastIndexOf("@");
  if (versionSeparator < 1) throw new Error(`Cannot identify dependency source: ${absolutePath}`);
  const packageName = packageDirectoryName.slice(0, versionSeparator).replace("+", "/");
  const version = packageDirectoryName.slice(versionSeparator + 1).split("_")[0];
  const nestedModules = remainder.indexOf("node_modules");
  if (nestedModules < 0) throw new Error(`Cannot identify dependency source path: ${absolutePath}`);
  const packageParts = packageName.startsWith("@") ? 2 : 1;
  const sourcePath = remainder.slice(nestedModules + 1 + packageParts).join("/");
  return `https://unpkg.com/${packageName}@${version}/${sourcePath}`;
}

function sourceUrl(source) {
  const absolutePath = resolve(distDirectory, source);
  if (absolutePath.includes(pnpmMarker)) return dependencySourceUrl(absolutePath);
  const repositoryPath = relative(repositoryRoot, absolutePath);
  if (repositoryPath.startsWith(`..${sep}`) || repositoryPath === "..") {
    throw new Error(`Source map reaches outside known sources: ${source}`);
  }
  return `https://raw.githubusercontent.com/asiraky/mayi/main/${repositoryPath.split(sep).join("/")}`;
}

const maps = (await readdir(distDirectory)).filter((name) => name.endsWith(".js.map"));
for (const name of maps) {
  const path = resolve(distDirectory, name);
  const map = JSON.parse(await readFile(path, "utf8"));
  map.sources = map.sources.map(sourceUrl);
  delete map.sourceRoot;
  delete map.sourcesContent;
  await writeFile(path, JSON.stringify(map));
}

console.log(`Normalized ${maps.length} source maps to public source URLs`);

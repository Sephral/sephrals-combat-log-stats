import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walk(fullPath));
      continue;
    }

    if (entry.isFile() && fullPath.endsWith(".js")) files.push(fullPath);
  }

  return files;
}

const scriptFiles = await walk(path.join(rootDir, "scripts"));
const buildFiles = [
  path.join(rootDir, "build", "check.mjs"),
  path.join(rootDir, "build", "prepare-release.mjs"),
  path.join(rootDir, "build", "validate-manifest.mjs")
];

for (const filePath of [...buildFiles, ...scriptFiles]) {
  const result = spawnSync(process.execPath, ["--check", filePath], { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

console.log(`Syntax-checked ${scriptFiles.length} script files.`);

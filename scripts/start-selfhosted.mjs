import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const wrangler = fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url));
const config = fileURLToPath(new URL("../selfhost/wrangler.jsonc", import.meta.url));
const dataDir = process.env.DATA_DIR || "/data";
const host = process.env.HOST || "0.0.0.0";
const port = process.env.PORT || "3000";

const migration = spawnSync(process.execPath, [
  wrangler,
  "d1", "migrations", "apply", "DB",
  "--local",
  "--config", config,
  "--persist-to", dataDir,
], { cwd: root, stdio: "inherit", env: { ...process.env, CI: "true" } });

if (migration.error) throw migration.error;
if (migration.status !== 0) process.exit(migration.status ?? 1);

const server = spawn(process.execPath, [
  wrangler,
  "dev",
  "--config", config,
  "--local",
  "--persist-to", dataDir,
  "--ip", host,
  "--port", port,
  "--inspector-port", "0",
], { cwd: root, stdio: "inherit", env: process.env });

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.kill(signal));
}

server.on("error", error => {
  console.error(error);
  process.exit(1);
});
server.on("exit", code => process.exit(code ?? 0));

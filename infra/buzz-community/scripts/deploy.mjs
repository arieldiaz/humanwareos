import { spawnSync } from "node:child_process";
import { assertEnvironment } from "./config.mjs";

assertEnvironment();

const cwd = new URL("..", import.meta.url);
const env = {
  ...process.env,
  CLOUDFLARE_API_TOKEN: process.env.CF_HUMANWAREOS_PLATFORM_TOKEN,
  CLOUDFLARE_ACCOUNT_ID: process.env.CF_ACCOUNT_ID,
};

for (const script of ["provision:r2", "sync:secrets"]) {
  const result = spawnSync("npm", ["run", script], { cwd, env, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const deploy = spawnSync("npx", ["wrangler", "deploy"], { cwd, env, stdio: "inherit" });
if (deploy.status !== 0) process.exit(deploy.status ?? 1);

const restart = spawnSync("npm", ["run", "restart:relay"], {
  cwd,
  env,
  stdio: "inherit",
});
process.exit(restart.status ?? 1);

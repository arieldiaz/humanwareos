import { spawnSync } from "node:child_process";
import { assertEnvironment, workerSecrets } from "./config.mjs";

assertEnvironment();

const result = spawnSync("npx", ["wrangler", "secret", "bulk"], {
  cwd: new URL("..", import.meta.url),
  input: JSON.stringify(workerSecrets()),
  encoding: "utf8",
  stdio: ["pipe", "inherit", "inherit"],
  env: {
    ...process.env,
    CLOUDFLARE_API_TOKEN: process.env.CF_HUMANWAREOS_PLATFORM_TOKEN,
    CLOUDFLARE_ACCOUNT_ID: process.env.CF_ACCOUNT_ID,
  },
});

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

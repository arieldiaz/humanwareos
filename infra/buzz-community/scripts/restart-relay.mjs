import { createHmac } from "node:crypto";
import { assertEnvironment } from "./config.mjs";

assertEnvironment();

const timestamp = Date.now().toString();
const signature = createHmac(
  "sha256",
  process.env.BUZZ_COMMUNITY_GIT_HOOK_HMAC_SECRET,
)
  .update(timestamp)
  .digest("hex");

const response = await fetch(
  "https://community.humanwareos.com/_alpha/relay-restart",
  {
    method: "POST",
    headers: {
      "X-Buzz-Timestamp": timestamp,
      "X-Buzz-Signature": signature,
    },
  },
);

if (!response.ok) {
  throw new Error(`relay restart failed with HTTP ${response.status}`);
}

console.log("Relay container restart requested.");

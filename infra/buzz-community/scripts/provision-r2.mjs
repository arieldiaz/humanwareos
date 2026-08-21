import { assertEnvironment, r2Buckets } from "./config.mjs";

assertEnvironment();

const api = `https://api.cloudflare.com/client/v4/accounts/${process.env.CF_ACCOUNT_ID}/r2/buckets`;
const headers = {
  Authorization: `Bearer ${process.env.CF_HUMANWAREOS_PLATFORM_TOKEN}`,
  "Content-Type": "application/json",
};

const listResponse = await fetch(api, { headers });
const listBody = await listResponse.json();
if (!listResponse.ok || !listBody.success) {
  throw new Error(`Could not list R2 buckets (HTTP ${listResponse.status})`);
}

const existing = new Set(listBody.result.buckets.map(({ name }) => name));
for (const name of r2Buckets) {
  if (existing.has(name)) {
    console.log(`R2 bucket already exists: ${name}`);
    continue;
  }
  const response = await fetch(api, {
    method: "POST",
    headers,
    body: JSON.stringify({ name }),
  });
  const body = await response.json();
  if (!response.ok || !body.success) {
    throw new Error(`Could not create R2 bucket ${name} (HTTP ${response.status})`);
  }
  console.log(`Created R2 bucket: ${name}`);
}

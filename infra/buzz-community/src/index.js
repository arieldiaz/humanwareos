import {
  Container,
  ContainerProxy,
  getContainer,
  switchPort,
} from "@cloudflare/containers";

export { ContainerProxy };

const REQUIRED_SECRETS = [
  "DATABASE_URL",
  "REDIS_URL",
  "BUZZ_RELAY_PRIVATE_KEY",
  "BUZZ_GIT_HOOK_HMAC_SECRET",
  "BUZZ_S3_ENDPOINT",
  "BUZZ_S3_ACCESS_KEY",
  "BUZZ_S3_SECRET_KEY",
  "RELAY_OWNER_PUBKEY",
];

const BUZZ_DESKTOP_ORIGINS = new Set([
  "tauri://localhost",
  "http://tauri.localhost",
]);

function hexToBytes(value) {
  if (!/^[0-9a-f]{64}$/i.test(value)) return null;
  return Uint8Array.from(value.match(/../g), (byte) => Number.parseInt(byte, 16));
}

async function authorizeRelayRestart(request, env) {
  const timestamp = request.headers.get("X-Buzz-Timestamp");
  const signature = hexToBytes(request.headers.get("X-Buzz-Signature") ?? "");
  const issuedAt = Number(timestamp);
  if (
    !timestamp ||
    !signature ||
    !Number.isInteger(issuedAt) ||
    Math.abs(Date.now() - issuedAt) > 5 * 60 * 1000
  ) {
    return false;
  }

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.BUZZ_GIT_HOOK_HMAC_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify(
    "HMAC",
    key,
    signature,
    new TextEncoder().encode(timestamp),
  );
}

function withDesktopCors(request, response) {
  const origin = request.headers.get("Origin");
  if (!origin || !BUZZ_DESKTOP_ORIGINS.has(origin)) return response;

  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", origin);
  headers.set("Access-Control-Allow-Methods", "*");
  headers.set("Access-Control-Allow-Headers", "*");
  headers.append("Vary", "Origin");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function requireSecrets(env) {
  const missing = REQUIRED_SECRETS.filter((name) => !env[name]);
  if (missing.length > 0) {
    throw new Error(`Missing Worker secrets: ${missing.join(", ")}`);
  }
}

export class BuzzRelay extends Container {
  defaultPort = 3000;
  requiredPorts = [3000, 8080];
  sleepAfter = "30m";
  enableInternet = true;

  constructor(ctx, env) {
    super(ctx, env);
    requireSecrets(env);
    this.envVars = {
      DATABASE_URL: env.DATABASE_URL,
      REDIS_URL: env.REDIS_URL,
      BUZZ_RELAY_PRIVATE_KEY: env.BUZZ_RELAY_PRIVATE_KEY,
      BUZZ_GIT_HOOK_HMAC_SECRET: env.BUZZ_GIT_HOOK_HMAC_SECRET,
      BUZZ_S3_ENDPOINT: env.BUZZ_S3_ENDPOINT,
      BUZZ_S3_ACCESS_KEY: env.BUZZ_S3_ACCESS_KEY,
      BUZZ_S3_SECRET_KEY: env.BUZZ_S3_SECRET_KEY,
      BUZZ_S3_BUCKET: "humanwareos-buzz-media-alpha",
      BUZZ_S3_REGION: "auto",
      BUZZ_GIT_S3_ENDPOINT: env.BUZZ_S3_ENDPOINT,
      BUZZ_GIT_S3_ACCESS_KEY: env.BUZZ_S3_ACCESS_KEY,
      BUZZ_GIT_S3_SECRET_KEY: env.BUZZ_S3_SECRET_KEY,
      BUZZ_GIT_S3_BUCKET: "humanwareos-buzz-git-alpha",
      BUZZ_GIT_S3_REGION: "auto",
      BUZZ_BIND_ADDR: "0.0.0.0:3000",
      BUZZ_HEALTH_PORT: "8080",
      RELAY_URL: "wss://community.humanwareos.com",
      BUZZ_MEDIA_BASE_URL: "https://community.humanwareos.com/media",
      BUZZ_CORS_ORIGINS:
        "https://community.humanwareos.com,tauri://localhost,http://tauri.localhost",
      BUZZ_INVITE_DEFAULT_CHANNELS: "general,welcome-everyone,bugs",
      RELAY_OWNER_PUBKEY: env.RELAY_OWNER_PUBKEY,
      BUZZ_AUTO_MIGRATE: "true",
      BUZZ_REQUIRE_AUTH_TOKEN: "true",
      BUZZ_REQUIRE_RELAY_MEMBERSHIP: "true",
      BUZZ_REQUIRE_MEDIA_GET_AUTH: "true",
      BUZZ_ALLOW_NIP_OA_AUTH: "true",
      BUZZ_AUDIT_ENABLED: "true",
      BUZZ_GIT_CONFORMANCE_PROBE: "true",
      BUZZ_MESH: "off",
      BUZZ_MAX_CONNECTIONS: "250",
      BUZZ_MAX_CONCURRENT_HANDLERS: "128",
      BUZZ_DB_POOL_SIZE: "10",
      BUZZ_REDIS_POOL_SIZE: "8",
      BUZZ_GIT_REPO_PATH: "/tmp/buzz/repos",
      BUZZ_GIT_PACK_CACHE_PATH: "/tmp/buzz/pack-cache",
    };
  }

  async restartForDeploy() {
    await this.destroy();
    return true;
  }
}

function relay(env) {
  return getContainer(env.BUZZ_RELAY, "public-community-alpha");
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/_alpha/worker-health") {
      return Response.json({ ok: true, layer: "worker" });
    }
    if (url.pathname === "/_alpha/relay-readiness") {
      const readiness = new Request(new URL("/_readiness", url), request);
      return relay(env).fetch(switchPort(readiness, 8080));
    }
    if (url.pathname === "/_alpha/relay-restart") {
      if (request.method !== "POST" || !(await authorizeRelayRestart(request, env))) {
        return new Response("Not found", { status: 404 });
      }
      await relay(env).restartForDeploy();
      return Response.json({ ok: true, layer: "relay" });
    }
    return withDesktopCors(request, await relay(env).fetch(request));
  },
};

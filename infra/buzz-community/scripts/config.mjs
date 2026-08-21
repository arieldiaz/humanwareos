export const requiredDopplerKeys = [
  "CF_ACCOUNT_ID",
  "CF_HUMANWAREOS_PLATFORM_TOKEN",
  "CF_HUMANWAREOS_R2_ACCESS_KEY_ID",
  "CF_HUMANWAREOS_R2_SECRET_ACCESS_KEY",
  "BUZZ_COMMUNITY_DATABASE_URL",
  "BUZZ_COMMUNITY_REDIS_URL",
  "BUZZ_COMMUNITY_RELAY_PRIVATE_KEY",
  "BUZZ_COMMUNITY_GIT_HOOK_HMAC_SECRET",
  "BUZZ_COMMUNITY_OWNER_PUBKEY",
];

export const r2Buckets = [
  "humanwareos-buzz-media-alpha",
  "humanwareos-buzz-git-alpha",
];

export function assertEnvironment() {
  const missing = requiredDopplerKeys.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new Error(`Missing Doppler keys: ${missing.join(", ")}`);
  }

  for (const name of requiredDopplerKeys.filter((key) => key.startsWith("CF_"))) {
    if (!/^[\x21-\x7e]+$/.test(process.env[name])) {
      throw new Error(`${name} must be one printable ASCII value, not copied console output`);
    }
  }

  for (const name of ["CF_ACCOUNT_ID", "CF_HUMANWAREOS_R2_ACCESS_KEY_ID"]) {
    if (!/^[0-9a-fA-F]{32}$/.test(process.env[name])) {
      throw new Error(`${name} must be 32 hexadecimal characters`);
    }
  }

  if (process.env.CF_HUMANWAREOS_PLATFORM_TOKEN.length < 40) {
    throw new Error("CF_HUMANWAREOS_PLATFORM_TOKEN is unexpectedly short");
  }

  if (!/^[0-9a-fA-F]{64}$/.test(process.env.CF_HUMANWAREOS_R2_SECRET_ACCESS_KEY)) {
    throw new Error("CF_HUMANWAREOS_R2_SECRET_ACCESS_KEY must be 64 hexadecimal characters");
  }

  const database = new URL(process.env.BUZZ_COMMUNITY_DATABASE_URL);
  if (!["postgres:", "postgresql:"].includes(database.protocol)) {
    throw new Error("BUZZ_COMMUNITY_DATABASE_URL must use postgres:// or postgresql://");
  }

  const redis = new URL(process.env.BUZZ_COMMUNITY_REDIS_URL);
  if (!["redis:", "rediss:"].includes(redis.protocol)) {
    throw new Error("BUZZ_COMMUNITY_REDIS_URL must use redis:// or rediss://");
  }

  for (const name of ["BUZZ_COMMUNITY_RELAY_PRIVATE_KEY", "BUZZ_COMMUNITY_OWNER_PUBKEY"]) {
    if (!/^[0-9a-fA-F]{64}$/.test(process.env[name])) {
      throw new Error(`${name} must be 64 hexadecimal characters`);
    }
  }

  if (process.env.BUZZ_COMMUNITY_GIT_HOOK_HMAC_SECRET.length < 32) {
    throw new Error("BUZZ_COMMUNITY_GIT_HOOK_HMAC_SECRET must be at least 32 characters");
  }
}

export function workerSecrets() {
  return {
    DATABASE_URL: process.env.BUZZ_COMMUNITY_DATABASE_URL,
    REDIS_URL: process.env.BUZZ_COMMUNITY_REDIS_URL,
    BUZZ_RELAY_PRIVATE_KEY: process.env.BUZZ_COMMUNITY_RELAY_PRIVATE_KEY,
    BUZZ_GIT_HOOK_HMAC_SECRET: process.env.BUZZ_COMMUNITY_GIT_HOOK_HMAC_SECRET,
    RELAY_OWNER_PUBKEY: process.env.BUZZ_COMMUNITY_OWNER_PUBKEY,
    BUZZ_S3_ENDPOINT: `https://${process.env.CF_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    BUZZ_S3_ACCESS_KEY: process.env.CF_HUMANWAREOS_R2_ACCESS_KEY_ID,
    BUZZ_S3_SECRET_KEY: process.env.CF_HUMANWAREOS_R2_SECRET_ACCESS_KEY,
  };
}

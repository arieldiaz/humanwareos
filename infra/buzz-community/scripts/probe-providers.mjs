import { randomUUID } from "node:crypto";
import pg from "pg";
import { createClient } from "redis";
import { assertEnvironment } from "./config.mjs";

assertEnvironment();

const pool = new pg.Pool({
  connectionString: process.env.BUZZ_COMMUNITY_DATABASE_URL,
  connectionTimeoutMillis: 10_000,
  max: 1,
});

await pool.query("select 1");
await pool.end();
console.log("PostgreSQL probe passed.");

const redisOptions = {
  url: process.env.BUZZ_COMMUNITY_REDIS_URL,
  socket: { connectTimeout: 10_000, reconnectStrategy: false },
};
const publisher = createClient(redisOptions);
const subscriber = publisher.duplicate();
publisher.on("error", () => {});
subscriber.on("error", () => {});

await Promise.all([publisher.connect(), subscriber.connect()]);
if ((await publisher.ping()) !== "PONG") {
  throw new Error("Redis PING did not return PONG");
}
if ((await publisher.eval("return 1", { arguments: [] })) !== 1) {
  throw new Error("Redis Lua EVAL probe failed");
}

const channel = `humanwareos:probe:${randomUUID()}`;
let resolveMessage;
const received = new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error("Redis Pub/Sub probe timed out")), 10_000);
  resolveMessage = (message) => {
    if (message === "ok") {
      clearTimeout(timeout);
      resolve();
    }
  };
});
await subscriber.subscribe(channel, resolveMessage);
await publisher.publish(channel, "ok");
await received;
await subscriber.unsubscribe(channel);
await Promise.all([publisher.quit(), subscriber.quit()]);
console.log("Redis TLS, Lua, and Pub/Sub probes passed.");

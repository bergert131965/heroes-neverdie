/**
 * Standalone harness for the usage-panel host half: imports the real plugin,
 * scripts the two Fetch routes against a real DSH home, and prints what the
 * panel would receive. Run it with the Electron binary in Node mode:
 *
 *   ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/Electron.app/Contents/MacOS/Electron \
 *     profile/plugins/usage-panel/selftest.mjs
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { apply, inject, name, ROUTES } from "./client-host.js";

/** A Context stub recording the registers and reading the real home. */
function stubContext({ apiKey } = {}) {
  const registered = [];
  const logs = [];
  return {
    registered,
    logs,
    connection: {
      fetch: {
        register(route) {
          registered.push(route);
          return () => {};
        },
      },
    },
    get(service) {
      if (service !== "credentials") return undefined;
      return { resolve: async () => (apiKey === undefined ? undefined : { value: apiKey, source: "selftest" }) };
    },
    logger: { info: (...args) => logs.push(args.map(String).join(" ")) },
  };
}

const ctx = stubContext({ apiKey: process.env.SELFTEST_API_KEY });
apply(ctx, {});

console.log("plugin name:", name);
console.log("inject:", JSON.stringify(inject));
console.log("routes:", JSON.stringify(ROUTES));
console.log("registered:", ctx.registered.map((route) => `${route.methods.join("/")} ${route.path}`).join(", "));
console.log("logs:", JSON.stringify(ctx.logs));

const [tokensRoute, balanceRoute] = [
  ctx.registered.find((route) => route.path === "/api/usage/tokens"),
  ctx.registered.find((route) => route.path === "/api/usage/balance"),
];

const call = async (route, query = "") => {
  const request = new Request(`http://dsh.internal${route.path}${query}`, { method: "GET" });
  const response = await route.fetch(request);
  return { status: response.status, body: await response.json() };
};

const all = await call(tokensRoute, "?scope=all");
console.log("\n=== /api/usage/tokens?scope=all ===");
console.log("status:", all.status, "ok:", all.body.ok);
console.log("sessions:", all.body.sessions);
console.log("buckets:", JSON.stringify(all.body.buckets));
console.log("metrics:", JSON.stringify(all.body.metrics));
console.log("cost:", JSON.stringify(all.body.cost));
console.log("diagnostics:", JSON.stringify(all.body.diagnostics));
console.log("byDay (last 3):", JSON.stringify(all.body.byDay.slice(-3)));
console.log("topSessions (first 2):", JSON.stringify(all.body.topSessions.slice(0, 2)));

// Cross-check the cached fold by recomputing it from the raw projection cache.
const cacheDir = join(homedir(), ".dsh", "storages", "session_projcache", "sessions");
const { readdirSync } = await import("node:fs");
let manual = { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
let count = 0;
for (const file of readdirSync(cacheDir).filter((entry) => entry.endsWith(".json"))) {
  const parsed = JSON.parse(readFileSync(join(cacheDir, file), "utf8"));
  const totals = parsed?.record?.rows?.tokenUsage?.val?.totals;
  if (totals === undefined) continue;
  count += 1;
  for (const key of Object.keys(manual)) manual[key] += totals[key] ?? 0;
}
console.log("\n=== cross-check (independent re-read of the projection cache) ===");
console.log("cache files folded:", count);
console.log("manual buckets:", JSON.stringify(manual));
console.log("matches plugin:", JSON.stringify(manual) === JSON.stringify(all.body.buckets));

const current = await call(tokensRoute, "?scope=current&sessionId=session-does-not-exist");
console.log("\n=== scope=current with an unknown session ===");
console.log("status:", current.status, JSON.stringify(current.body).slice(0, 220));

const bad = await call(tokensRoute, "?scope=current");
console.log("\n=== scope=current without sessionId (expected 400) ===");
console.log("status:", bad.status, JSON.stringify(bad.body));

if (balanceRoute !== undefined) {
  const balance = await call(balanceRoute);
  console.log("\n=== /api/usage/balance (no credential in this stub) ===");
  console.log("status:", balance.status, JSON.stringify(balance.body));
}

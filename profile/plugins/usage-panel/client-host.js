/**
 * DeepSeek usage/balance host half.
 *
 * Two exact Fetch routes on the Connection shared handler (`/api`), reachable
 * from the desktop page through the Electron IPC fetch bridge:
 *
 * - `GET /api/usage/balance` — the one usage-related number DeepSeek actually
 *   publishes: `GET https://api.deepseek.com/user/balance`. The API key is
 *   resolved on the host through `ctx.credentials` (falling back to the
 *   process environment), so the secret never crosses into the renderer.
 * - `GET /api/usage/tokens?scope=all|current` — a locally recomputed token
 *   ledger. Values are read from the durable session projection cache
 *   (`$DSH_HOME/storages/session_projcache/sessions/*.json`, key
 *   `record.rows.tokenUsage.val.totals`), which is the same fold the Web chat
 *   UI displays; sessions without a cache entry fall back to replaying their
 *   canonical `session.jsonl.zstd` log.
 *
 * Cost figures are estimates: the durable log carries token buckets but no
 * per-request timestamp, so one flat price table is applied. Override it with
 * `config.pricing` when the published prices change.
 *
 * The file name is deliberate. This package is both a host plugin and a client
 * bundle, and `@deepseek-ai/dsh-client-modules` locates a row's `dsh.client`
 * declaration by walking up from the resolved module location to the nearest
 * `package.json`. A loader row naming the bare package directory would resolve
 * to the package root, whose nearest manifest is then this package's
 * `package.json` — fine — but a row naming a file whose nearest manifest is the
 * *profile's* `package.json` (which declares no `dsh.client`) would silently
 * compose no bundle. Naming this entry exactly what the manifest declares as
 * `main` keeps the host row, the loader resolution, and the client manifest in
 * agreement.
 * @module dsh-desktop-profile/plugins/usage-panel
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";

/** Stable Cordis plugin name. */
export const name = "usage-panel";

/** Services the host half needs before it can serve either route. */
export const inject = ["connection"];

/** Credential reference DeepSeek adapters resolve by default. */
const DEFAULT_API_KEY_ENV = "DEEPSEEK_API_KEY";
/** Public API base; the balance endpoint hangs off the OpenAI-compatible root. */
const DEFAULT_API_BASE = "https://api.deepseek.com";
/** Exact Fetch routes this plugin claims. */
const BALANCE_ROUTE = "/api/usage/balance";
const TOKENS_ROUTE = "/api/usage/tokens";
const ROUTES = [BALANCE_ROUTE, TOKENS_ROUTE];
/** Upstream balance calls are cached for this long to keep polling cheap. */
const BALANCE_TTL_MS = 30_000;
/** An individual upstream call is abandoned after this long. */
const BALANCE_TIMEOUT_MS = 10_000;
/** Session-projection cache schema this reader understands. */
const SUPPORTED_PROJECTION_VERSION = 7;

/**
 * Per-1M-token USD prices. Defaults mirror the published DeepSeek table at the
 * off-peak rate (peak is double); every field is overridable through plugin
 * config so a price change needs no code edit.
 */
const DEFAULT_PRICING = {
  currency: "USD",
  cacheHit: 0.003,
  cacheMiss: 0.15,
  output: 0.6,
  /** CNY per USD, only used to restate a CNY estimate beside a USD table. */
  usdToCny: 7.1,
};

/** Empty token bucket. */
function emptyBuckets() {
  return { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

/** Add one session's buckets into a running total. */
function addBuckets(total, buckets) {
  total.uncachedInputTokens += buckets.uncachedInputTokens;
  total.outputTokens += buckets.outputTokens;
  total.cacheReadTokens += buckets.cacheReadTokens;
  total.cacheWriteTokens += buckets.cacheWriteTokens;
}

/** Coerce one provider-reported bucket field to a non-negative integer. */
function count(value) {
  return Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

/** Normalize whatever `tokenUsage.val` carries into the four known buckets. */
function bucketsOf(totals) {
  if (totals === null || typeof totals !== "object") return emptyBuckets();
  return {
    uncachedInputTokens: count(totals.uncachedInputTokens),
    outputTokens: count(totals.outputTokens),
    cacheReadTokens: count(totals.cacheReadTokens),
    cacheWriteTokens: count(totals.cacheWriteTokens),
  };
}

/** Resolve `$DSH_HOME` the same way the CLI and desktop shell do. */
function resolveDshHome() {
  const configured = process.env.DSH_HOME;
  if (configured !== undefined && configured !== "") return configured;
  return join(homedir(), ".dsh");
}

/**
 * Price one bucket set. Cache reads bill at the cache-hit rate, every other
 * input token at the miss rate, and output tokens at the output rate.
 * @param buckets - normalized token buckets.
 * @param pricing - resolved price table.
 * @returns the estimate plus the USD figure it came from.
 */
function estimateCost(buckets, pricing) {
  const inputTokens = buckets.uncachedInputTokens + buckets.cacheWriteTokens;
  const usd =
    (buckets.cacheReadTokens * pricing.cacheHit +
      inputTokens * pricing.cacheMiss +
      buckets.outputTokens * pricing.output) /
    1_000_000;
  return {
    currency: pricing.currency,
    usd,
    cny: usd * pricing.usdToCny,
    cacheHitPerMillion: pricing.cacheHit,
    cacheMissPerMillion: pricing.cacheMiss,
    outputPerMillion: pricing.output,
    note: "estimate: flat off-peak price table; the durable log carries no per-request timestamp",
  };
}

/** Derive secondary ratios the panel shows next to the raw buckets. */
function ratiosOf(buckets) {
  const cached = buckets.cacheReadTokens;
  const uncached = buckets.uncachedInputTokens;
  const promptTokens = cached + uncached;
  return {
    totalTokens: promptTokens + buckets.outputTokens + buckets.cacheWriteTokens,
    promptTokens,
    cacheHitRatio: promptTokens === 0 ? null : cached / promptTokens,
    /** What the same prompt would have cost with no cache hits at all. */
    cacheSavedRatio: promptTokens === 0 ? null : 1 - cached / promptTokens,
  };
}

/** Read the session projection cache directory for this DSH home. */
function projectionCacheDir(home) {
  return join(home, "storages", "session_projcache", "sessions");
}

/**
 * Scan the projection cache. One file per session carries a versioned record
 * whose `rows.tokenUsage.val.totals` is the whole-log provider-reported fold.
 * @param home - resolved DSH home.
 * @returns per-session rows plus the scan diagnostics.
 */
function readProjectionCache(home) {
  const dir = projectionCacheDir(home);
  const rows = [];
  const skipped = [];
  let files = [];
  try {
    files = readdirSync(dir).filter((entry) => entry.endsWith(".json"));
  } catch (error) {
    return { rows, skipped, available: false, detail: error instanceof Error ? error.message : String(error) };
  }
  for (const entry of files) {
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(join(dir, entry), "utf8"));
    } catch {
      skipped.push(entry);
      continue;
    }
    if (parsed?.version !== SUPPORTED_PROJECTION_VERSION) {
      skipped.push(entry);
      continue;
    }
    const record = parsed?.record;
    const totals = record?.rows?.tokenUsage?.val?.totals;
    if (totals === undefined) {
      skipped.push(entry);
      continue;
    }
    rows.push({
      sessionId: String(record?.identity?.sessionId ?? entry.replace(/^session-/, "").replace(/\.json$/, "")),
      createdAt: Number.isFinite(record?.identity?.createdAt) ? record.identity.createdAt : null,
      title: typeof record?.rows?.title?.val === "string" ? record.rows.title.val : "",
      seq: Number.isFinite(record?.rows?.tokenUsage?.seq) ? record.rows.tokenUsage.seq : null,
      buckets: bucketsOf(totals),
    });
  }
  return { rows, skipped, available: true, detail: null };
}

/**
 * Replay one canonical session log. This is the fallback for a session the
 * projection cache has not written yet; the log is a zstd stream whose
 * `assistant/message` events may embed the provider usage object.
 * @param path - absolute `session.jsonl.zstd` path.
 * @returns normalized buckets, or undefined when nothing could be recovered.
 */
function readLogBuckets(path) {
  let text;
  try {
    text = zstdDecompressSync(readFileSync(path)).toString("utf8");
  } catch {
    return undefined;
  }
  const total = emptyBuckets();
  let seen = false;
  for (const line of text.split("\n")) {
    if (line === "" || !line.includes("usage")) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const usage = event?.usage ?? event?.message?.usage ?? event?.attempt?.usage;
    if (usage === null || typeof usage !== "object") continue;
    const uncached = count(usage.prompt_cache_miss_tokens ?? usage.prompt_tokens);
    const cached = count(usage.prompt_cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens);
    total.uncachedInputTokens += uncached;
    total.cacheReadTokens += cached;
    total.outputTokens += count(usage.completion_tokens);
    seen = true;
  }
  return seen ? total : undefined;
}

/**
 * Aggregate every session reachable from this home.
 * @param home - resolved DSH home.
 * @returns the aggregate, the per-session rows, and the data-source diagnostics.
 */
function readAllSessions(home) {
  const cache = readProjectionCache(home);
  const sessionsRoot = join(home, "sessions");
  // Recursive discovery: the layout is <root>/<workspace>/<session>/session.jsonl.zstd.
  const logFiles = new Set();
  const walk = (dir, depth) => {
    if (depth > 4) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path, depth + 1);
      else if (entry.isFile() && entry.name === "session.jsonl.zstd") logFiles.add(path);
    }
  };
  walk(sessionsRoot, 0);

  const cachedIds = new Set(cache.rows.map((row) => row.sessionId));
  const fallback = [];
  for (const path of logFiles) {
    const digest = /(session-[0-9a-f-]+)[\\/]session\.jsonl\.zstd$/.exec(path);
    const sessionId = digest?.[1] ?? path;
    if (cachedIds.has(sessionId)) continue;
    let size = 0;
    try {
      size = statSync(path).size;
    } catch {
      continue;
    }
    const buckets = readLogBuckets(path);
    if (buckets === undefined) continue;
    fallback.push({ sessionId, createdAt: null, title: "", seq: null, buckets, source: "log", bytes: size });
  }

  const rows = [
    ...cache.rows.map((row) => ({ ...row, source: "projection-cache" })),
    ...fallback,
  ];
  const totals = emptyBuckets();
  for (const row of rows) addBuckets(totals, row.buckets);
  rows.sort((left, right) => (right.createdAt ?? 0) - (left.createdAt ?? 0));
  return { totals, rows, cache, logCount: logFiles.size, fallbackCount: fallback.length };
}

/** Normalize one route's query input. */
function readScope(url) {
  const scope = url.searchParams.get("scope");
  return scope === "current" ? "current" : "all";
}

/**
 * ISO-8601 day key in local time, used for the per-day rollup.
 * @param millis - epoch milliseconds.
 * @returns `YYYY-MM-DD`, or null when the timestamp is unknown.
 */
function dayKey(millis) {
  if (!Number.isFinite(millis)) return null;
  const date = new Date(millis);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/** Roll the per-session rows into per-day totals. */
function rollupByDay(rows) {
  const days = new Map();
  for (const row of rows) {
    const key = dayKey(row.createdAt);
    if (key === null) continue;
    const entry = days.get(key) ?? { day: key, sessions: 0, ...emptyBuckets() };
    entry.sessions += 1;
    addBuckets(entry, row.buckets);
    days.set(key, entry);
  }
  return [...days.values()].sort((left, right) => left.day.localeCompare(right.day));
}

/** JSON response helper carrying the no-store hint for a polling UI. */
function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

/** Summarize a balance payload into the shape the panel draws. */
function balanceView(payload) {
  const infos = Array.isArray(payload?.balance_infos) ? payload.balance_infos : [];
  return {
    isAvailable: payload?.is_available === true,
    infos: infos.map((info) => ({
      currency: String(info?.currency ?? ""),
      totalBalance: String(info?.total_balance ?? ""),
      grantedBalance: String(info?.granted_balance ?? ""),
      toppedUpBalance: String(info?.topped_up_balance ?? ""),
    })),
  };
}

/**
 * Mount the usage host half.
 * @param ctx - plugin context carrying the settled host services.
 * @param config - optional plugin config (`apiKeyEnv`, `apiBase`, `pricing`).
 */
export function apply(ctx, config = {}) {
  const apiKeyEnv = typeof config.apiKeyEnv === "string" && config.apiKeyEnv !== "" ? config.apiKeyEnv : DEFAULT_API_KEY_ENV;
  const apiBase =
    typeof config.apiBase === "string" && config.apiBase !== "" ? config.apiBase.replace(/\/+$/, "") : DEFAULT_API_BASE;
  const pricing = { ...DEFAULT_PRICING, ...(config.pricing ?? {}) };
  const home = resolveDshHome();

  /** Cached upstream balance answer, so UI polling cannot hammer the endpoint. */
  let balanceCache = { at: 0, body: null };

  /**
   * Resolve the API key through the credential seam, falling back to the
   * process environment. Only the resolved value is used, and only inside this
   * host process: no route ever echoes the key to the renderer.
   * @returns the key, or undefined when this deployment has none.
   */
  const resolveApiKey = async () => {
    const credentials = ctx.get("credentials");
    if (credentials !== undefined && typeof credentials.resolve === "function") {
      const resolved = await credentials.resolve(apiKeyEnv);
      if (typeof resolved?.value === "string" && resolved.value !== "") return resolved.value;
    }
    const fromProcess = process.env[apiKeyEnv];
    return fromProcess !== undefined && fromProcess !== "" ? fromProcess : undefined;
  };

  /** Call the official balance endpoint once. */
  const fetchBalance = async (signal) => {
    const apiKey = await resolveApiKey();
    if (apiKey === undefined) {
      return {
        status: 200,
        body: {
          ok: false,
          code: "usage/credential-missing",
          message: `no ${apiKeyEnv} credential is configured`,
          apiKeyEnv,
        },
      };
    }
    const timeout = AbortSignal.timeout(BALANCE_TIMEOUT_MS);
    const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
    try {
      const response = await fetch(`${apiBase}/user/balance`, {
        method: "GET",
        headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" },
        signal: combined,
      });
      const text = await response.text();
      if (!response.ok) {
        return {
          status: 200,
          body: {
            ok: false,
            code: `usage/upstream-${String(response.status)}`,
            message: `balance request failed: HTTP ${String(response.status)}`,
            apiKeyEnv,
          },
        };
      }
      let payload;
      try {
        payload = JSON.parse(text);
      } catch {
        return { status: 200, body: { ok: false, code: "usage/bad-payload", message: "balance response was not JSON", apiKeyEnv } };
      }
      return { status: 200, body: { ok: true, apiKeyEnv, fetchedAt: Date.now(), ...balanceView(payload), raw: payload } };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        status: 200,
        body: {
          ok: false,
          code: signal?.aborted === true ? "usage/aborted" : "usage/transport",
          message,
          apiKeyEnv,
        },
      };
    }
  };

  /**
   * Serve one balance request, reusing the short-lived cache.
   * @param refresh - when true the cache is bypassed.
   * @param signal - request cancellation.
   */
  const balanceBody = async (refresh, signal) => {
    const now = Date.now();
    if (!refresh && balanceCache.body !== null && now - balanceCache.at < BALANCE_TTL_MS) {
      return { ...balanceCache.body, cached: true };
    }
    const { body } = await fetchBalance(signal);
    // Only a successful read is worth caching; failures should be retryable.
    if (body.ok === true) balanceCache = { at: now, body };
    return { ...body, cached: false };
  };

  /** Serve one local token-ledger request. */
  const tokensBody = (url, sessionId) => {
    const scope = readScope(url);
    if (scope === "current") {
      if (sessionId === undefined || sessionId === "") {
        return { ok: false, code: "usage/no-session", message: "scope=current needs a sessionId query parameter" };
      }
      const all = readAllSessions(home);
      const row = all.rows.find((candidate) => candidate.sessionId === sessionId);
      if (row === undefined) {
        return {
          ok: true,
          scope,
          sessionId,
          source: "projection-cache+logs",
          sessions: 0,
          buckets: emptyBuckets(),
          metrics: ratiosOf(emptyBuckets()),
          cost: estimateCost(emptyBuckets(), pricing),
          detail: "no stored usage for this session yet",
        };
      }
      const metrics = ratiosOf(row.buckets);
      return {
        ok: true,
        scope,
        sessionId,
        source: row.source,
        sessions: 1,
        buckets: row.buckets,
        metrics,
        cost: estimateCost(row.buckets, pricing),
      };
    }
    const all = readAllSessions(home);
    const metrics = ratiosOf(all.totals);
    return {
      ok: true,
      scope: "all",
      source: "projection-cache+logs",
      sessions: all.rows.length,
      buckets: all.totals,
      metrics,
      cost: estimateCost(all.totals, pricing),
      byDay: rollupByDay(all.rows),
      // Sessions whose fold is entirely zero — created but never billed — are
      // excluded here so the ranking lists real consumers; they still count in
      // `sessions` and `byDay`, which describe the store rather than spend.
      topSessions: all.rows
        .map((row) => ({
          sessionId: row.sessionId,
          title: row.title,
          createdAt: row.createdAt,
          source: row.source,
          buckets: row.buckets,
          totalTokens: ratiosOf(row.buckets).totalTokens,
        }))
        .filter((row) => row.totalTokens > 0)
        .slice(0, 12),
      diagnostics: {
        home,
        projectionCacheAvailable: all.cache.available,
        projectionCacheDetail: all.cache.detail,
        projectionCacheRows: all.cache.rows.length,
        projectionCacheSkipped: all.cache.skipped.length,
        logFiles: all.logCount,
        logFallbackRows: all.fallbackCount,
        supportedProjectionVersion: SUPPORTED_PROJECTION_VERSION,
      },
    };
  };

  for (const route of ROUTES) {
    ctx.connection.fetch.register({
      path: route,
      methods: ["GET"],
      requestBody: "buffered",
      fetch: async (request) => {
        const url = new URL(request.url);
        try {
          if (route === BALANCE_ROUTE) {
            const refresh = url.searchParams.get("refresh") === "1";
            return jsonResponse(await balanceBody(refresh, request.signal));
          }
          const sessionId = url.searchParams.get("sessionId") ?? undefined;
          const body = tokensBody(url, sessionId);
          return jsonResponse(body, body.ok === false ? 400 : 200);
        } catch (error) {
          return jsonResponse(
            { ok: false, code: "usage/internal", message: error instanceof Error ? error.message : String(error) },
            500,
          );
        }
      },
    });
  }

  ctx.logger?.info?.("usage-panel: serving %s and %s", BALANCE_ROUTE, TOKENS_ROUTE);
}

export { DEFAULT_PRICING, ROUTES };

/**
 * Collector — one full OpenRouter free-model refresh.
 * Runs headless from scripts/collect-data.ts (GitHub Actions, every 10
 * minutes, aligned with the 10-minute refresh cadence of OpenRouter's
 * model-uptime-recent endpoint). Returns a plain in-memory dataset;
 * src/payloads.ts turns it into the published JSON snapshots.
 *
 * Flow:
 *   1. Fetch catalog (/catalog/models) → filter to free variants
 *   2. For each, fetch /stats/endpoint (per-provider deployment list);
 *      data-policy flags come from /all-providers — fail-hard: a partial
 *      provider list must not be published as the truth
 *   3. For each, fetch /stats/model-uptime-recent (10-minute
 *      availability buckets — routing-layer metric only — plus API
 *      summary fields; null availability values are already coerced
 *      to 0 at the openrouter.ts boundary) — best-effort per model:
 *      a model whose fetch fails publishes no figures and no buckets,
 *      and scripts/collect-data.ts carries forward its last known ones
 *   4. Fetch /api/v1/models for the benchmark leaderboard — best-effort
 *   5. Derive the 24h bucket mean per model
 */

import {
  fetchModels,
  isFreeModel,
  extractOwner,
  fetchEndpointStats,
  fetchModelUptimeRecent,
  fetchProviderPolicies,
  fetchBenchmarkModels,
  pMap,
  type BenchmarkEntry,
  type EndpointProviderStats,
  type ModelUptimeBucket,
  type ModelUptimeResult,
} from './openrouter.js'

/** How many concurrent model-uptime-recent fetches to run.
 *  Lower concurrency reduces burst pressure on OpenRouter's frontend API. */
const UPTIME_FETCH_CONCURRENCY = 6

/** Concurrency for the per-model /stats/endpoint fetches. */
const ENDPOINT_STATS_CONCURRENCY = 10

/** Rolling window (hours) over which per-model 24h-style averages are
 *  computed from the freshest buckets each tick. The endpoint returns
 *  ~24h of buckets, so this matches the upstream window. */
const AVAILABILITY_AVG_WINDOW_HOURS = 24

/** Per-state counts for one collector tick's availability fetches,
 *  surfaced in the per-tick log line. */
export interface ModelUptimeStatusCounts {
  ok: number
  noData: number
  error: number
}

/** Exhaustiveness guard: a `switch` with this in its `default`
 *  forces every `ModelUptimeResult` status to be handled. */
function assertNever(x: never): never {
  throw new Error(`Unhandled value: ${JSON.stringify(x)}`)
}

/** One deployment provider of a free model, with its data-policy flags
 *  resolved from /all-providers (null = unknown). */
export interface CollectedProvider {
  slug: string
  name: string
  contextLength: number | null
  maxCompletionTokens: number | null
  dataTrained: 0 | 1 | null
  dataLogged: 0 | 1 | null
}

/** One free model with everything this tick collected for it. */
export interface CollectedModel {
  id: string                 // permaslug
  slug: string               // bare slug
  variant: string
  name: string
  owner: string              // slash-prefix
  updatedAt: string          // ISO 8601 UTC
  /** 24h mean of buckets.availability (routing-layer aggregate); null when
   *  this tick's fetch failed — the caller then carries forward the last
   *  published figure rather than publishing a fabricated 0. Float
   *  precision is kept here; payloads.ts rounds at the rendering layer. */
  uptime1dAvg: number | null
  /** OpenRouter's request-weighted summary fields, verbatim; null when the
   *  fetch failed this tick. */
  uptime: number | null
  availability: number | null
  recentAvailability: number | null
  buckets: ModelUptimeBucket[]
  providers: CollectedProvider[]
}

/** Everything one collector tick produced. */
export interface Dataset {
  models: CollectedModel[]
  benchmarks: BenchmarkEntry[]
  /** false when the benchmark fetch failed — the caller then falls back
   *  to the last published leaderboard instead of publishing an empty one */
  benchmarksOk: boolean
  uptime: ModelUptimeStatusCounts
  elapsed: number
}

export interface CollectSuccess {
  success: true
  dataset: Dataset
}

export interface CollectFailure {
  success: false
  error: string
  stack?: string
}

/**
 * Run a full OpenRouter free-model check and return the collected dataset.
 */
export async function collectOpenRouter(): Promise<CollectSuccess | CollectFailure> {
  console.log('[collect] Starting OpenRouter free-model check...')
  const start = Date.now()

  try {
    const [allModels, providerPolicies] = await Promise.all([
      fetchModels(),
      fetchProviderPolicies(),
    ])
    console.log(
      `[collect] Fetched ${allModels.length} total models from OpenRouter frontend API` +
      `, ${providerPolicies.size} providers with known data_policy`,
    )

    if (!allModels.length) {
      return { success: false, error: 'OpenRouter API returned empty model list — skipping check to avoid data corruption' }
    }

    const freeModels = allModels.filter(isFreeModel)
    console.log(`[collect] ${freeModels.length} models are currently free`)

    if (!freeModels.length) {
      return { success: false, error: 'No free models found in current catalog — skipping' }
    }

    // Fetch endpoint stats per model; capture errors so the whole tick
    // aborts rather than publishing a partial provider snapshot.
    console.log(`[collect] Fetching endpoint stats for ${freeModels.length} free models...`)
    const statsByPermaslug = new Map<string, EndpointProviderStats[]>()
    const statErrors: string[] = []
    await pMap(
      freeModels,
      async (model) => {
        try {
          const list = await fetchEndpointStats(model.permaslug, model.endpoint.variant)
          statsByPermaslug.set(model.permaslug, list)
        } catch (err) {
          statErrors.push(`${model.permaslug}: ${(err as Error).message}`)
        }
      },
      ENDPOINT_STATS_CONCURRENCY,
    )
    if (statErrors.length > 0) {
      statErrors.sort()
      throw new Error(
        `fetchEndpointStats failed for ${statErrors.length}/${freeModels.length} models ` +
        `(first: ${statErrors[0]}). Aborting tick to avoid a partial provider snapshot.`,
      )
    }

    // Per-model availability buckets: best-effort — a partial outage
    // must not abort the tick.
    console.log(`[collect] Fetching model availability for ${freeModels.length} free models (concurrency=${UPTIME_FETCH_CONCURRENCY})...`)
    const uptimeByPermaslug = new Map<string, ModelUptimeResult>()
    const uptimeCounts: ModelUptimeStatusCounts = { ok: 0, noData: 0, error: 0 }
    await pMap(
      freeModels,
      async (model) => {
        const result = await fetchModelUptimeRecent(model.permaslug, model.endpoint.variant)
        uptimeByPermaslug.set(model.permaslug, result)
        switch (result.status) {
          case 'ok':       uptimeCounts.ok++; break
          case 'no-data':  uptimeCounts.noData++; break
          case 'error':    uptimeCounts.error++; break
          default: assertNever(result)
        }
      },
      UPTIME_FETCH_CONCURRENCY,
    )
    console.log(
      `[collect] Model availability: ${uptimeCounts.ok} ok, ${uptimeCounts.noData} no-data, ` +
      `${uptimeCounts.error} errors`,
    )

    // Fetch /api/v1/models for the Compare tab's benchmark leaderboard.
    // Best-effort: a failure must not abort the primary free-model data.
    let benchmarks: BenchmarkEntry[] = []
    let benchmarksOk = false
    try {
      benchmarks = await fetchBenchmarkModels()
      benchmarksOk = true
      console.log(`[collect] Fetched ${benchmarks.length} benchmarked models from /api/v1/models`)
    } catch (err) {
      console.warn(`[collect] Benchmark fetch failed (will reuse prior leaderboard): ${(err as Error).message}`)
    }

    const nowIso = new Date().toISOString()
    const avgCutoff = Date.now() - AVAILABILITY_AVG_WINDOW_HOURS * 60 * 60 * 1000

    const models: CollectedModel[] = freeModels.map((m) => {
      const uptimeResult = uptimeByPermaslug.get(m.permaslug)
      const ok = uptimeResult?.status === 'ok' ? uptimeResult : null
      const buckets = ok ? ok.buckets : []
      let sum = 0
      let count = 0
      for (const b of buckets) {
        if (b.timestamp < avgCutoff) continue
        sum += b.availability
        count++
      }
      const providers = (statsByPermaslug.get(m.permaslug) ?? []).map((p) => ({
        slug: p.providerSlug,
        name: p.providerName,
        contextLength: p.contextLength,
        maxCompletionTokens: p.maxCompletionTokens,
        // Data flags come from /all-providers only; a provider missing
        // from that list stays null (unknown).
        dataTrained: providerPolicies.get(p.providerSlug)?.data_trained ?? null,
        dataLogged: providerPolicies.get(p.providerSlug)?.data_logged ?? null,
      }))
      return {
        id: m.permaslug,
        slug: m.slug,
        variant: m.endpoint.variant || 'free',
        name: m.name ?? m.slug,
        owner: extractOwner(m.slug),
        updatedAt: nowIso,
        // A failed fetch yields nulls, never 0: the availability grid keeps
        // this model's older buckets untouched, and the caller carries the
        // previous figures forward, so one dropped request cannot publish
        // a fake outage.
        uptime1dAvg: count > 0 ? sum / count : null,
        uptime: ok ? ok.summary.uptime : null,
        availability: ok ? ok.summary.availability : null,
        recentAvailability: ok ? ok.summary.recentAvailability : null,
        buckets,
        providers,
      }
    })

    const bucketCount = models.reduce((acc, m) => acc + m.buckets.length, 0)
    const distinctProviders = new Set(models.flatMap((m) => m.providers.map((p) => p.slug))).size
    const elapsed = Date.now() - start
    console.log(
      `[collect] Collected ${models.length} free models, ${distinctProviders} distinct providers, ` +
      `${bucketCount} availability buckets (${elapsed}ms)`,
    )

    return {
      success: true,
      dataset: { models, benchmarks, benchmarksOk, uptime: uptimeCounts, elapsed },
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    const stack = err instanceof Error ? err.stack : undefined
    console.error(`[collect] Error during OpenRouter check: ${message}`, err)
    return { success: false, error: message, stack }
  }
}

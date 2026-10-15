/**
 * OpenRouter API client — fetches the free-models catalog, parses
 * per-model / per-provider deployment metadata, and pulls the
 * availability timeseries that backs the uptime chart.
 *
 * Availability comes from GET /api/frontend/v1/stats/model-uptime-recent,
 * which returns ~24h of 10-minute buckets plus request-weighted summary
 * fields. Ingestion policy (applied HERE and nowhere else):
 *   1. Routing metric only — the bucket/summary field
 *      `availabilityWithoutRouting` is dropped at parse time and never
 *      published.
 *   2. Null == 0 — AVAILABILITY ONLY. A null/omitted availability value
 *      (bucket or summary field) is coerced to 0 here. Every other
 *      numeric field (benchmark scores, prices, provider metadata)
 *      keeps null semantics and propagates as null. This covers values
 *      inside a response that DID arrive; a model whose request failed
 *      outright yields no figures at all (see collect.ts), which is not
 *      the same as a measured 0%.
 */

/** A `benchmarks.design_arena` entry — Chatbot-Arena-style pairwise Elo
 *  per category. Unvalidated upstream JSON; consumers guard missing
 *  values at render time. */
export interface DesignArenaEntry {
  arena: string      // "agents" | "models"
  category: string   // e.g. "webapps", "dataviz", "3d"
  elo: number
  win_rate: number
  rank: number
}

interface PricingInfo {
  prompt: string
  completion: string
  discount?: number
}

/** Data policy from the catalog endpoint, scoped to the current variant */
interface DataPolicy {
  training: boolean
  trainingOpenRouter: boolean
  retainsPrompts: boolean
  retentionDays: number
  canPublish: boolean
  termsOfServiceURL: string
  privacyPolicyURL: string
}

/** Status heuristic counts for /stats/endpoint */
interface StatusHeuristics {
  success: number
  derankableError: number
  rateLimited: number
}

/** Routing heuristics for /stats/endpoint */
interface RoutingHeuristics {
  request_count: number
  p50_throughput: number
  p50_latency: number
  p50_throughput_5_minutes?: number
  p50_latency_5_minutes?: number
  effective_prompt_price: number
  effective_completion_price: number
  request_count_5_minutes?: number
}

/** Endpoint object nested inside each catalog model */
interface FrontendEndpoint {
  id: string
  name: string
  context_length: number
  model_variant_slug: string
  model_variant_permaslug: string
  variant: string
  is_free: boolean
  provider_name: string
  provider_slug: string
  max_completion_tokens: number | null
  pricing: PricingInfo
  data_policy: DataPolicy
  status_heuristics: StatusHeuristics
  status_heuristics_5m: StatusHeuristics
  status_heuristics_1d: StatusHeuristics
  routing_heuristics: RoutingHeuristics
  status: number
  is_hidden: boolean
  is_private: boolean
  is_deranked: boolean
  is_disabled: boolean
  supports_reasoning: boolean
}

/** A single model entry from GET /api/frontend/v1/catalog/models */
export interface FrontendModel {
  slug: string
  permaslug: string
  name: string
  short_name: string
  author: string
  author_display_name: string
  description: string
  context_length: number
  input_modalities: string[]
  output_modalities: string[]
  has_text_output: boolean
  group: string
  hidden: boolean
  is_private: boolean
  supports_reasoning: boolean
  created_at: string
  updated_at: string
  endpoint: FrontendEndpoint
}

/** Response wrapper for /api/frontend/v1/catalog/models */
interface FrontendModelsResponse {
  data: FrontendModel[]
}

// 15s timeout for external API fetches
const DEFAULT_FETCH_TIMEOUT = 15_000

/**
 * Fetch with an AbortController timeout.
 */
async function fetchWithTimeout(url: string, opts: RequestInit & { timeout?: number } = {}): Promise<Response> {
  const { timeout = DEFAULT_FETCH_TIMEOUT, ...rest } = opts
  const controller = new AbortController()
  const id = setTimeout(() => controller.abort(), timeout)
  try {
    const resp = await fetch(url, { ...rest, signal: controller.signal })
    return resp
  } finally {
    clearTimeout(id)
  }
}

/** Statuses worth another attempt: rate limiting and upstream flakiness.
 *  A 4xx other than 429 is a permanent answer (bad slug, blocked client)
 *  and retrying it only wastes the request budget. */
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504])

/**
 * Fetch with retry logic wrapping fetchWithTimeout.
 * Retries network/connection errors (thrown fetch exceptions) and
 * retryable HTTP statuses. Uses exponential backoff: 1s, 2s, 4s between
 * retries. The last response is returned as-is once the retries run out,
 * so callers still see the status code.
 */
async function fetchWithRetry(
  url: string,
  opts: RequestInit & { timeout?: number } = {},
  retries: number = 2
): Promise<Response> {
  let lastError: Error | undefined
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      if (attempt > 0) {
        const delay = 1000 * Math.pow(2, attempt - 1)
        console.warn(`[fetch] Retry ${attempt}/${retries} for ${url} in ${delay}ms...`)
        await new Promise((r) => setTimeout(r, delay))
      }
      const resp = await fetchWithTimeout(url, opts)
      if (RETRYABLE_STATUS.has(resp.status) && attempt < retries) {
        console.warn(`[fetch] Attempt ${attempt + 1}/${retries + 1} got HTTP ${resp.status} for ${url}`)
        await resp.body?.cancel().catch(() => {})
        continue
      }
      return resp
    } catch (err) {
      lastError = err as Error
      if (attempt < retries) {
        console.warn(`[fetch] Attempt ${attempt + 1}/${retries + 1} failed for ${url}: ${(err as Error).message}`)
      }
    }
  }
  console.error(`[fetch] All ${retries + 1} attempts failed for ${url}`)
  throw lastError
}

/**
 * Run async tasks with a concurrency limit. Soft-fail: individual errors
 * are logged but don't abort remaining items. Slots whose callback threw
 * stay `undefined` — typed as such so callers must null-check rather
 * than rely on a slot that wasn't actually written.
 */
export async function pMap<T, R>(
  items: readonly T[],
  fn: (item: T, index: number) => Promise<R>,
  limit: number = 10
): Promise<Array<R | undefined>> {
  const results: Array<R | undefined> = new Array(items.length)
  let nextIndex = 0

  const worker = async (): Promise<void> => {
    while (true) {
      const i = nextIndex++
      if (i >= items.length) return
      try {
        results[i] = await fn(items[i]!, i)
      } catch (err) {
        console.warn(`[pMap] Item ${i} failed: ${(err as Error).message}`)
      }
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker())
  await Promise.all(workers)

  return results
}

/**
 * Fetch the full model list from OpenRouter's frontend catalog API.
 */
export async function fetchModels(): Promise<FrontendModel[]> {
  const headers: Record<string, string> = {
    'User-Agent': 'OpenRouter-Monitor/1.0',
    Accept: 'application/json',
  }

  const resp = await fetchWithRetry('https://openrouter.ai/api/frontend/v1/catalog/models', { headers })

  if (!resp.ok) {
    throw new Error(
      `OpenRouter frontend API returned ${resp.status}: ${await resp.text().catch(() => '')}`
    )
  }

  const json = await resp.json() as FrontendModelsResponse
  return json.data ?? []
}

// ============================================================================
// /api/v1/models — public catalog with embedded `benchmarks` per model.
// Used by the Compare tab to populate the model_benchmarks table. Distinct
// from fetchModels() above (the frontend catalog endpoint): /api/v1/models
// is the public, OpenAI-compatible model list and is the only OpenRouter
// endpoint that embeds Artificial Analysis + Design Arena scores.
// ============================================================================

/** `benchmarks.artificial_analysis` — aggregate capability indices, 0-100. */
interface ArtificialAnalysis {
  intelligence_index?: number
  coding_index?: number
  agentic_index?: number
}

/** `benchmarks` object nested inside each /api/v1/models entry. */
interface ModelBenchmarks {
  artificial_analysis?: ArtificialAnalysis
  design_arena?: DesignArenaEntry[]
}

/** `architecture` object on a /api/v1/models entry. */
interface ModelArchitecture {
  modality?: string
  input_modalities?: string[]
  output_modalities?: string[]
  tokenizer?: string
  instruct_type?: string | null
}

/** `pricing` object on a /api/v1/models entry — per-token USD strings. */
interface ModelPricing {
  prompt?: string
  completion?: string
  [k: string]: string | undefined
}

/** `top_provider` object on a /api/v1/models entry. */
interface ModelTopProvider {
  context_length?: number
  max_completion_tokens?: number
  is_moderated?: boolean
}

/** A single entry from GET /api/v1/models. Only the fields we read. */
export interface V1Model {
  id: string
  name?: string
  context_length?: number
  architecture?: ModelArchitecture
  pricing?: ModelPricing
  top_provider?: ModelTopProvider
  supported_parameters?: string[]
  benchmarks?: ModelBenchmarks
}

interface V1ModelsResponse {
  data: V1Model[]
}

/** Parse a per-token USD pricing string (e.g. "0.000005", "0") into a REAL.
 *  Returns 0 for free models, null when the string is missing/unparseable. */
function parsePrice(raw: string | undefined): number | null {
  if (raw == null) return null
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : null
}

/** Coerce an availability value to a number; null/undefined/non-finite
 *  become 0. Availability only — every other metric keeps null semantics. */
function toAvailability(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

/** Flattened benchmark entry for the Compare leaderboard payload. */
export interface BenchmarkEntry {
  id: string
  name: string
  contextLength: number | null
  modality: string | null
  inputModalities: string[]
  outputModalities: string[]
  promptPriceUsd: number | null
  completionPriceUsd: number | null
  intelligenceIndex: number | null
  codingIndex: number | null
  agenticIndex: number | null
  designArena: DesignArenaEntry[]
  maxCompletionTokens: number | null
  supportedParameters: string[]
}

/** Keep only string entries of an upstream array (unvalidated JSON). */
function stringArray(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : []
}

/**
 * Fetch /api/v1/models and flatten to benchmark entries. Only models with
 * a non-empty `benchmarks` object are returned — an entry without a score
 * would only clutter the leaderboard. Throws on a network error or
 * non-2xx response; the caller reuses the previous leaderboard on failure.
 */
export async function fetchBenchmarkModels(): Promise<BenchmarkEntry[]> {
  const resp = await fetchWithRetry('https://openrouter.ai/api/v1/models', {
    headers: {
      'User-Agent': 'OpenRouter-Monitor/1.0',
      Accept: 'application/json',
    },
  })

  if (!resp.ok) {
    throw new Error(
      `fetchBenchmarkModels: OpenRouter returned ${resp.status}: ${await resp.text().catch(() => '')}`,
    )
  }

  const json = await resp.json() as V1ModelsResponse
  const models = json.data ?? []
  const entries: BenchmarkEntry[] = []

  for (const m of models) {
    const b = m.benchmarks
    const aa = b?.artificial_analysis
    const da = b?.design_arena
    const hasAA = aa != null && (
      typeof aa.intelligence_index === 'number' ||
      typeof aa.coding_index === 'number' ||
      typeof aa.agentic_index === 'number'
    )
    const hasDA = Array.isArray(da) && da.length > 0
    // Skip models with neither an AA index nor Design Arena entries.
    if (!hasAA && !hasDA) continue

    entries.push({
      id: m.id,
      name: m.name ?? m.id,
      contextLength: typeof m.context_length === 'number' ? m.context_length : null,
      modality: m.architecture?.modality ?? null,
      inputModalities: stringArray(m.architecture?.input_modalities),
      outputModalities: stringArray(m.architecture?.output_modalities),
      promptPriceUsd: parsePrice(m.pricing?.prompt),
      completionPriceUsd: parsePrice(m.pricing?.completion),
      intelligenceIndex: typeof aa?.intelligence_index === 'number' ? aa.intelligence_index : null,
      codingIndex: typeof aa?.coding_index === 'number' ? aa.coding_index : null,
      agenticIndex: typeof aa?.agentic_index === 'number' ? aa.agentic_index : null,
      designArena: hasDA ? (da as DesignArenaEntry[]) : [],
      // 100%-populated upstream, so null here means a shape change.
      maxCompletionTokens: typeof m.top_provider?.max_completion_tokens === 'number'
        ? m.top_provider.max_completion_tokens
        : null,
      supportedParameters: stringArray(m.supported_parameters),
    })
  }

  return entries
}

export function isFreeModel(model: FrontendModel): boolean {
  return model.endpoint?.is_free === true && model.endpoint?.variant === 'free'
}

/** Extracts the slash-prefix owner from a model slug.
 * e.g. "google/gemma-4-31b-it" → "google".
 *
 * Slugs without a `/` (or with an empty prefix like `"/foo"`)
 * resolve to 'unknown' so malformed input never produces an empty
 * owner that would silently break owner-based filtering.
 */
export function extractOwner(modelSlug: string): string {
  const prefix = modelSlug.split('/')[0]
  if (!prefix) {
    console.warn(`[openrouter] Slug ${JSON.stringify(modelSlug)} has no owner prefix`)
    return 'unknown'
  }
  return prefix
}

/** Tri-state booleans for the model_providers schema. */
interface DataPolicyFlags {
  data_trained: 0 | 1 | null
  data_logged: 0 | 1 | null
}

/** Map a DataPolicy to tri-state booleans. */
function extractDataPolicy(dp: DataPolicy | undefined | null): DataPolicyFlags {
  return {
    data_trained: typeof dp?.training === 'boolean' ? (dp.training ? 1 : 0) : null,
    data_logged: typeof dp?.retainsPrompts === 'boolean' ? (dp.retainsPrompts ? 1 : 0) : null,
  }
}

/** Response wrapper for /api/frontend/v1/all-providers (camelCase dataPolicy, keyed by slug). */
interface AllProvidersResponse {
  data: Array<{
    slug: string
    dataPolicy?: DataPolicy
  }>
}

/**
 * Fetch per-provider dataPolicy flags from `/all-providers`.
 * Fail-hard: aborts the tick to avoid collapsing a `/all-providers`
 * outage into indistinguishable "trains?/logs?" across all models.
 */
export async function fetchProviderPolicies(): Promise<Map<string, DataPolicyFlags>> {
  const resp = await fetchWithRetry(
    'https://openrouter.ai/api/frontend/v1/all-providers',
    {
      headers: {
        'User-Agent': 'OpenRouter-Monitor/1.0',
        Accept: 'application/json',
      },
    },
  )

  if (!resp.ok) {
    // Match fetchModels: surface the response body in addition to the
    // status code so an operator debugging an `/all-providers` outage
    // has the upstream JSON error without having to re-curl manually.
    throw new Error(
      `fetchProviderPolicies: OpenRouter returned ${resp.status}: ${await resp.text().catch(() => '')}`,
    )
  }

  const json = await resp.json() as AllProvidersResponse
  const map = new Map<string, DataPolicyFlags>()
  for (const p of json.data ?? []) {
    if (p.slug && p.dataPolicy) {
      map.set(p.slug, extractDataPolicy(p.dataPolicy))
    }
  }
  return map
}

/** Response from GET /api/frontend/v1/stats/endpoint */
interface EndpointStatsResponse {
  data: Array<{
    id: string
    provider_name: string
    provider_slug: string
    context_length?: number
    max_completion_tokens?: number | null
    status_heuristics_5m: StatusHeuristics
    status_heuristics_1d: StatusHeuristics
    routing_heuristics: RoutingHeuristics
    is_free: boolean
  }>
}

export interface EndpointProviderStats {
  providerSlug: string
  providerName: string
  contextLength: number | null
  maxCompletionTokens: number | null
}

/** Fetch the deployment-provider list for a (permaslug, variant).
 *  Throws on failure so the txn aborts before wiping model_providers. */
export async function fetchEndpointStats(
  permaslug: string,
  variant: string = 'free'
): Promise<EndpointProviderStats[]> {
  const encoded = encodeURIComponent(permaslug)
  const resp = await fetchWithRetry(
    `https://openrouter.ai/api/frontend/v1/stats/endpoint?permaslug=${encoded}&variant=${variant}`,
    {
      headers: {
        'User-Agent': 'OpenRouter-Monitor/1.0',
        Accept: 'application/json',
      },
    }
  )

  if (!resp.ok) {
    throw new Error(`fetchEndpointStats: OpenRouter returned ${resp.status} for ${permaslug}`)
  }

  const json = await resp.json() as EndpointStatsResponse
  const providers = json.data ?? []
  // A reported context_length of 0 means "not applicable", not "no data":
  // upstream returns 0 for non-text models (e.g. respan/span-01-lite is a
  // behaviour-scoring model with has_text_output=false). Normalising to null
  // makes it render as "—" and sort with the unknowns instead of claiming
  // the model has a zero-token context window.
  const positive = (v: number | null | undefined) =>
    typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null
  return providers.map((p) => ({
    providerSlug: p.provider_slug,
    providerName: p.provider_name,
    contextLength: positive(p.context_length),
    maxCompletionTokens: positive(p.max_completion_tokens),
  }))
}

/** A single 10-minute availability bucket from
 *  GET /api/frontend/v1/stats/model-uptime-recent. */
export interface ModelUptimeBucket {
  timestamp: number               // epoch ms — bucket start, UTC
  availability: number            // routing-layer aggregate availability % (null → 0)
}

/** OpenRouter's request-weighted summary fields, stored verbatim.
 *  All are percentages (0-100); 0 when the API omits them. */
export interface ModelUptimeSummary {
  uptime: number
  availability: number
  recentAvailability: number
}

/** Discriminated union per model: 'ok' / 'no-data' / 'error'.
 *  Keeps failure modes distinct so the collector can count them per tick. */
export type ModelUptimeResult =
  | { status: 'ok'; buckets: ModelUptimeBucket[]; summary: ModelUptimeSummary }
  | { status: 'no-data' }
  | { status: 'error'; reason: string }

/** Response from GET /api/frontend/v1/stats/model-uptime-recent.
 *  `buckets` covers a rolling ~24h window at 10-minute resolution;
 *  the summary fields are request-weighted aggregates over the
 *  upstream's own window (not simple bucket means). Only the
 *  routing-layer `availability` metric is read —
 *  `availabilityWithoutRouting` is intentionally ignored. */
interface ModelUptimeRecentResponse {
  data?: {
    buckets?: Array<{
      timestamp?: string          // "2026-10-11 07:40:00" — UTC, no timezone suffix
      availability?: number | null
    }>
    uptime?: number | null
    availability?: number | null
    recentAvailability?: number | null
  }
}

/** Parse an API bucket timestamp ("2026-10-11 07:40:00", UTC) to epoch ms.
 *  Returns null for missing/malformed values — such buckets are dropped
 *  by the caller rather than silently landing at epoch 0. */
function parseBucketTimestamp(raw: string | undefined): number | null {
  if (!raw) return null
  const ms = Date.parse(`${raw.replace(' ', 'T')}Z`)
  return Number.isFinite(ms) ? ms : null
}

/**
 * Fetch the recent availability timeseries for a (permaslug, variant)
 * from OpenRouter's model-uptime-recent endpoint.
 *
 * Non-throwing: always resolves to a ModelUptimeResult member so the
 * collector can soft-fail per model (a partial outage must not abort the
 * tick). Retries network-class errors via fetchWithRetry; a non-2xx
 * response or an unparseable body resolves to { status: 'error' }.
 */
export async function fetchModelUptimeRecent(
  permaslug: string,
  variant: string = 'free'
): Promise<ModelUptimeResult> {
  const encoded = encodeURIComponent(permaslug)
  let resp: Response
  try {
    resp = await fetchWithRetry(
      `https://openrouter.ai/api/frontend/v1/stats/model-uptime-recent?permaslug=${encoded}&variant=${variant}`,
      {
        headers: {
          'User-Agent': 'OpenRouter-Monitor/1.0',
          Accept: 'application/json',
        },
      },
    )
  } catch (err) {
    return { status: 'error', reason: `network: ${(err as Error).message}` }
  }

  if (!resp.ok) {
    return {
      status: 'error',
      reason: `HTTP ${resp.status}: ${(await resp.text().catch(() => '')).slice(0, 200)}`,
    }
  }

  let json: ModelUptimeRecentResponse
  try {
    json = (await resp.json()) as ModelUptimeRecentResponse
  } catch (err) {
    return { status: 'error', reason: `JSON parse: ${(err as Error).message}` }
  }

  const data = json.data
  const rawBuckets = data?.buckets
  if (!Array.isArray(rawBuckets) || rawBuckets.length === 0) {
    return { status: 'no-data' }
  }

  const buckets: ModelUptimeBucket[] = []
  for (const b of rawBuckets) {
    const ts = parseBucketTimestamp(b?.timestamp)
    if (ts == null) continue
    buckets.push({
      timestamp: ts,
      // null == 0 policy (availability only); availabilityWithoutRouting is never read.
      availability: toAvailability(b?.availability),
    })
  }
  if (buckets.length === 0) {
    return { status: 'no-data' }
  }

  return {
    status: 'ok',
    buckets,
    summary: {
      uptime: toAvailability(data?.uptime),
      availability: toAvailability(data?.availability),
      recentAvailability: toAvailability(data?.recentAvailability),
    },
  }
}

/**
 * Payload builders — the single source of truth for the static site's
 * JSON data files. The collector (scripts/collect-data.ts) passes each
 * run's Dataset through these builders and writes the results to
 * site/data/; the browser fetches the same shapes directly.
 *
 * Shapes are normalised for a static consumer: camelCase fields,
 * models with nested providers (no flat row fan-out), and a columnar
 * uptime grid (shared timestamps via t0/step/n).
 */

import type { BenchmarkEntry } from './openrouter.js'
import type { CollectedModel, Dataset } from './collect.js'

/** 10-minute availability bucket step (matches the upstream cadence). */
export const GRID_STEP_MS = 10 * 60 * 1000
/** Rolling window carried in the uptime payload. */
export const GRID_RETENTION_MS = 30 * 24 * 60 * 60 * 1000

/** One model's deployment provider. */
export interface ProviderEntry {
  slug: string
  name: string
  contextLength: number | null
  dataTrained: 0 | 1 | null
  dataLogged: 0 | 1 | null
}

/** One free model with its deployment providers nested. */
export interface StatusModel {
  id: string                    // permaslug
  variant: string
  name: string
  owner: string                 // slash-prefix
  uptime1dAvg: number           // 24h mean of buckets.availability (routing-layer aggregate)
  uptime: number                // API summary: overall uptime %
  availability: number          // API summary: overall availability %
  recentAvailability: number    // API summary: recent availability %
  intelligenceIndex: number | null // Artificial Analysis 0-100; null = unranked
  updatedAt: string             // ISO 8601 UTC
  providers: ProviderEntry[]
}

/** KPI bar figures, computed at collect time. */
export interface StatusSummary {
  totalFreeModels: number
  providers: number             // distinct deployment providers across all free models
  uptimePercent: number | null  // unweighted mean of per-model 24h averages
  availabilityPercent: number | null
  lastUpdated: string | null
}

/** The `data/dashboard.json` document. */
export interface StatusPayload {
  summary: StatusSummary
  models: StatusModel[]
}

/** Columnar 10-minute availability grid (the `data/uptime.json` document). */
export interface UptimePayload {
  t0: number                                  // first bucket start (epoch ms, 10-min aligned)
  step: number                                // bucket step (600000)
  n: number                                   // bucket count
  models: Array<{ id: string; name: string; owner: string }>
  series: Array<Array<number | null>>         // aligned to models[i]; 0-100, null = no bucket
}

/** One availability bucket flattened for the grid merge. */
export interface UptimeGridRow {
  model_id: string
  timestamp: number    // epoch ms (10-min bucket start)
  availability: number // routing-aggregate availability % (0-100)
}

/** The Compare tab's leaderboard row: a benchmark entry tagged with
 *  whether the model is currently free. */
export interface BenchmarkPayload extends BenchmarkEntry {
  isFree: boolean
}

/** Round to 2 decimals — display precision, keeps the JSON compact. */
function round2(v: number): number {
  return Math.round(v * 100) / 100
}

/** Round to 1 decimal — KPI bar precision. */
function round1(v: number): number {
  return Math.round(v * 10) / 10
}

/** Stable publish order: owner, then name (matches the previous SQL
 *  ORDER BY's binary collation). */
function compareModelOrder(a: CollectedModel, b: CollectedModel): number {
  if (a.owner !== b.owner) return a.owner < b.owner ? -1 : 1
  if (a.name !== b.name) return a.name < b.name ? -1 : 1
  return 0
}

function toProviderEntry(p: CollectedModel['providers'][number]): ProviderEntry {
  return {
    slug: p.slug,
    name: p.name || p.slug,
    contextLength: p.contextLength,
    dataTrained: p.dataTrained,
    dataLogged: p.dataLogged,
  }
}

export function buildStatusPayload(data: Dataset): StatusPayload {
  // model_benchmarks is keyed by the bare slug; free models join on it
  // to pick up their intelligence index.
  const intelligenceBySlug = new Map<string, number | null>(
    data.benchmarks.map((b) => [b.id, b.intelligenceIndex]),
  )

  const sorted = [...data.models].sort(compareModelOrder)
  const providerSlugs = new Set<string>()
  const models: StatusModel[] = sorted.map((m) => {
    for (const p of m.providers) providerSlugs.add(p.slug)
    const intel = intelligenceBySlug.get(m.slug)
    return {
      id: m.id,
      variant: m.variant,
      name: m.name,
      owner: m.owner,
      uptime1dAvg: round2(m.uptime1dAvg),
      uptime: round2(m.uptime),
      availability: round2(m.availability),
      recentAvailability: round2(m.recentAvailability),
      intelligenceIndex: intel == null ? null : round2(intel),
      updatedAt: m.updatedAt,
      providers: [...m.providers]
        .sort((a, b) => (a.slug === b.slug ? 0 : a.slug < b.slug ? -1 : 1))
        .map(toProviderEntry),
    }
  })

  // Unweighted means of per-model figures for the KPI bar. uptimePercent
  // is the 24h bucket mean; availabilityPercent is OpenRouter's own
  // request-weighted figure.
  const count = data.models.length
  const mean = (pick: (m: CollectedModel) => number) =>
    count > 0 ? data.models.reduce((acc, m) => acc + pick(m), 0) / count : null
  const uptimeAvg = mean((m) => m.uptime1dAvg)
  const availabilityAvg = mean((m) => m.availability)
  const lastUpdated = count > 0
    ? data.models.reduce((acc, m) => (m.updatedAt > acc ? m.updatedAt : acc), data.models[0]!.updatedAt)
    : null

  return {
    summary: {
      totalFreeModels: count,
      providers: providerSlugs.size,
      uptimePercent: uptimeAvg == null ? null : round1(uptimeAvg),
      availabilityPercent: availabilityAvg == null ? null : round1(availabilityAvg),
      lastUpdated,
    },
    models,
  }
}

/** Default order: intelligence index desc, nulls last, then name. The
 *  client re-sorts on column click. */
function compareBenchOrder(a: BenchmarkPayload, b: BenchmarkPayload): number {
  const av = a.intelligenceIndex
  const bv = b.intelligenceIndex
  if (av == null && bv == null) return a.name.localeCompare(b.name)
  if (av == null) return 1
  if (bv == null) return -1
  return bv - av
}

export function buildBenchmarksPayload(
  benchmarks: BenchmarkEntry[],
  freeSlugs: Set<string>,
): BenchmarkPayload[] {
  // A Set lookup, not a scan: a model can have a free variant AND paid
  // variants, so the match is on the bare slug.
  const payload = benchmarks.map((b) => ({ ...b, isFree: freeSlugs.has(b.id) }))
  payload.sort(compareBenchOrder)
  return payload
}

/** Fallback path: this tick's benchmark fetch failed, so re-publish the
 *  previous leaderboard with isFree re-derived against the current free
 *  set (a model can join or leave the free list between runs). */
export function reuseBenchmarkLeaderboard(
  prev: BenchmarkPayload[],
  freeSlugs: Set<string>,
): BenchmarkPayload[] {
  const payload = prev.map((m) => ({ ...m, isFree: freeSlugs.has(m.id) }))
  payload.sort(compareBenchOrder)
  return payload
}

/** All availability buckets collected this tick, flattened for the grid. */
export function buildUptimeGridRows(data: Dataset): UptimeGridRow[] {
  return data.models.flatMap((m) =>
    m.buckets.map((b) => ({
      model_id: m.id,
      timestamp: b.timestamp,
      availability: b.availability,
    })),
  )
}

// ── Cross-run 30-day merge ─────────────────────────────────────────────

/**
 * Merge the previous uptime.json (the seed carried on the gh-pages
 * branch) with this tick's fresh buckets:
 *  - models no longer on the free list are dropped,
 *  - buckets older than the 30-day retention are dropped,
 *  - fresh buckets overwrite same-(model, timestamp) entries — the
 *    upstream rolling window means most points are simply refreshed,
 *    never double-counted,
 *  - fresh values are rounded to 1 decimal (display precision).
 *
 * `metaFor` resolves owner/name for models appearing for the first time
 * (the collector passes a lookup built from the status payload).
 */
export function mergeUptimePayload(
  prev: UptimePayload | null,
  fresh: UptimeGridRow[],
  now: number,
  liveModelIds: Set<string>,
  metaFor: (id: string) => { owner: string; name: string } | undefined,
): UptimePayload {
  const cutoff = now - GRID_RETENTION_MS
  const byModel = new Map<string, Map<number, number>>()
  const meta = new Map<string, { owner: string; name: string }>()

  if (prev) {
    for (let mi = 0; mi < prev.models.length; mi++) {
      const m = prev.models[mi]!
      if (!liveModelIds.has(m.id)) continue
      const series = prev.series[mi]!
      const points = new Map<number, number>()
      for (let i = 0; i < prev.n; i++) {
        const v = series[i]
        if (v == null) continue
        const ts = prev.t0 + i * prev.step
        if (ts < cutoff) continue
        points.set(ts, v)
      }
      if (points.size > 0) byModel.set(m.id, points)
      meta.set(m.id, { owner: m.owner, name: m.name })
    }
  }

  for (const row of fresh) {
    if (row.timestamp < cutoff) continue
    if (!liveModelIds.has(row.model_id)) continue
    let points = byModel.get(row.model_id)
    if (!points) {
      points = new Map()
      byModel.set(row.model_id, points)
    }
    points.set(row.timestamp, Math.round(row.availability * 10) / 10)
  }

  if (byModel.size === 0) {
    return {
      t0: Math.floor(now / GRID_STEP_MS) * GRID_STEP_MS,
      step: GRID_STEP_MS,
      n: 0,
      models: [],
      series: [],
    }
  }

  let minTs = Infinity
  let maxTs = -Infinity
  for (const points of byModel.values()) {
    for (const ts of points.keys()) {
      if (ts < minTs) minTs = ts
      if (ts > maxTs) maxTs = ts
    }
  }
  const t0 = Math.floor(minTs / GRID_STEP_MS) * GRID_STEP_MS
  const n = Math.floor((maxTs - t0) / GRID_STEP_MS) + 1

  const ids = [...byModel.keys()].sort()
  const models = ids.map((id) => {
    const m = meta.get(id) ?? metaFor(id)
    return { id, owner: m?.owner ?? '', name: m?.name ?? id }
  })
  const series = ids.map((id) => {
    const points = byModel.get(id)!
    const row = new Array<number | null>(n).fill(null)
    for (const [ts, v] of points) {
      const idx = Math.round((ts - t0) / GRID_STEP_MS)
      if (idx >= 0 && idx < n) row[idx] = v
    }
    return row
  })

  return { t0, step: GRID_STEP_MS, n, models, series }
}

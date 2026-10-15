#!/usr/bin/env tsx
/**
 * collect-data.ts — CI entry point (GitHub Actions, every 10 minutes).
 *
 * Loads the previously published JSON from the gh-pages branch as a "seed"
 * (uptime history, benchmark and availability fallbacks), runs one collector
 * pass, builds the payloads and assembles site/.
 *
 * Any failure exits non-zero so the workflow aborts without deploying and the
 * published gh-pages content stays online.
 *
 * Env:
 *   SEED_DIR  directory containing a previous uptime.json,
 *             benchmarks.json and/or dashboard.json (optional)
 */

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import { fileURLToPath } from 'url'

import { collectOpenRouter, type CollectedModel } from '../src/collect.js'
import {
  buildStatusPayload,
  buildBenchmarksPayload,
  reuseBenchmarkLeaderboard,
  buildUptimeGridRows,
  mergeUptimePayload,
  GRID_STEP_MS,
  type BenchmarkPayload,
  type StatusModel,
  type UptimePayload,
} from '../src/payloads.js'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const SITE_DIR = resolve(ROOT, 'site')
const DATA_DIR = resolve(SITE_DIR, 'data')

function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(2)} MiB`
    : `${(bytes / 1024).toFixed(1)} KiB`
}

function writeJson(name: string, value: unknown): number {
  const json = JSON.stringify(value)
  writeFileSync(resolve(DATA_DIR, name), json)
  return Buffer.byteLength(json)
}

function loadUptimeSeed(path: string): UptimePayload | null {
  try {
    const prev = JSON.parse(readFileSync(path, 'utf8')) as UptimePayload
    if (typeof prev.t0 !== 'number' || !Array.isArray(prev.models) || !Array.isArray(prev.series)) {
      throw new Error('unexpected shape')
    }
    console.log(
      `[collect-data] Uptime seed loaded: ${prev.models.length} models × ${prev.n} buckets ` +
      `(${(prev.n * prev.step / 86400000).toFixed(1)}d span)`,
    )
    return prev
  } catch (err) {
    console.warn(`[collect-data] Uptime seed decode failed (${(err as Error).message}) — starting from an empty grid`)
    return null
  }
}

function loadBenchmarksSeed(path: string): BenchmarkPayload[] | null {
  try {
    const prev = JSON.parse(readFileSync(path, 'utf8')) as { models: BenchmarkPayload[] }
    if (!Array.isArray(prev.models)) throw new Error('unexpected shape')
    console.log(`[collect-data] Benchmarks seed loaded: ${prev.models.length} models`)
    return prev.models
  } catch (err) {
    console.warn(`[collect-data] Benchmarks seed decode failed (${(err as Error).message})`)
    return null
  }
}

function loadStatusSeed(path: string): Map<string, StatusModel> | null {
  try {
    const prev = JSON.parse(readFileSync(path, 'utf8')) as { models: StatusModel[] }
    if (!Array.isArray(prev.models)) throw new Error('unexpected shape')
    const byId = new Map(prev.models.map((m) => [m.id, m]))
    console.log(`[collect-data] Status seed loaded: ${byId.size} models`)
    return byId
  } catch (err) {
    console.warn(`[collect-data] Status seed decode failed (${(err as Error).message})`)
    return null
  }
}

/**
 * Reuse the last published figures for models whose availability fetch failed
 * this tick; `updatedAt` moves with them so the table shows when they were
 * really measured. Returns the number of rows carried forward.
 */
function carryForwardFigures(models: CollectedModel[], prev: Map<string, StatusModel> | null): number {
  if (!prev) return 0
  let carried = 0
  for (const m of models) {
    if (m.uptime1dAvg != null) continue
    const p = prev.get(m.id)
    if (!p) continue
    m.uptime1dAvg = p.uptime1dAvg
    m.uptime = p.uptime
    m.availability = p.availability
    m.recentAvailability = p.recentAvailability
    m.updatedAt = p.updatedAt
    carried++
  }
  return carried
}

function assembleSite(): void {
  rmSync(SITE_DIR, { recursive: true, force: true })
  mkdirSync(DATA_DIR, { recursive: true })
  cpSync(resolve(ROOT, 'public'), SITE_DIR, { recursive: true })
  writeFileSync(resolve(SITE_DIR, '.nojekyll'), '')
}

async function main(): Promise<void> {
  const now = Date.now()

  // Seed — the previous data files from the gh-pages branch (optional).
  let prevUptime: UptimePayload | null = null
  let prevBenchmarks: BenchmarkPayload[] | null = null
  let prevStatus: Map<string, StatusModel> | null = null
  const seedDir = process.env.SEED_DIR ? resolve(process.env.SEED_DIR) : null
  if (seedDir && existsSync(seedDir)) {
    const uptimePath = join(seedDir, 'uptime.json')
    if (existsSync(uptimePath)) prevUptime = loadUptimeSeed(uptimePath)
    const benchmarksPath = join(seedDir, 'benchmarks.json')
    if (existsSync(benchmarksPath)) prevBenchmarks = loadBenchmarksSeed(benchmarksPath)
    const statusPath = join(seedDir, 'dashboard.json')
    if (existsSync(statusPath)) prevStatus = loadStatusSeed(statusPath)
  } else {
    console.log('[collect-data] No seed directory — starting from an empty grid')
  }

  const result = await collectOpenRouter()
  if (!result.success) {
    console.error(`[collect-data] Collector failed: ${result.error}`)
    process.exit(1)
  }
  const { dataset } = result

  const carried = carryForwardFigures(dataset.models, prevStatus)
  if (carried > 0) {
    console.warn(
      `[collect-data] Carried forward last-known availability for ${carried} model(s) ` +
      `(fetch failed this tick; uptime counts: ${dataset.uptime.ok} ok, ` +
      `${dataset.uptime.noData} no-data, ${dataset.uptime.error} errors)`,
    )
  }
  // Failed fetch with nothing to carry forward: skip the row, don't publish a 0%.
  const unmeasured = dataset.models.filter((m) => m.uptime1dAvg == null)
  if (unmeasured.length > 0) {
    console.warn(
      `[collect-data] Skipping ${unmeasured.length} model(s) with no availability figure ` +
      `this tick and no previous value: ${unmeasured.map((m) => m.id).join(', ')}`,
    )
  }

  const status = buildStatusPayload(dataset)
  const fresh = buildUptimeGridRows(dataset)

  const freeSlugs = new Set(dataset.models.map((m) => m.slug))
  let benchmarks: BenchmarkPayload[]
  if (dataset.benchmarksOk) {
    benchmarks = buildBenchmarksPayload(dataset.benchmarks, freeSlugs)
  } else if (prevBenchmarks) {
    console.warn('[collect-data] Benchmark fetch failed — republishing the seeded leaderboard')
    benchmarks = reuseBenchmarkLeaderboard(prevBenchmarks, freeSlugs)
  } else {
    console.warn('[collect-data] Benchmark fetch failed and no seed available — publishing an empty leaderboard')
    benchmarks = []
  }

  // "Live" means still on the free list, not "has a figure this tick": an
  // unmeasured model must keep its 30-day history in the grid.
  const liveIds = new Set(dataset.models.map((m) => m.id))
  const metaFor = (id: string) => {
    const model = dataset.models.find((m) => m.id === id)
    return model ? { owner: model.owner, name: model.name } : undefined
  }
  const uptime = mergeUptimePayload(prevUptime, fresh, now, liveIds, metaFor)

  assembleSite()
  const generatedAt = new Date(now).toISOString()
  const statusSize = writeJson('dashboard.json', { generatedAt, ...status })
  const uptimeSize = writeJson('uptime.json', { generatedAt, ...uptime })
  const benchmarksSize = writeJson('benchmarks.json', { generatedAt, models: benchmarks })

  console.log(
    `[collect-data] site/ written: dashboard.json ${formatBytes(statusSize)}, ` +
    `uptime.json ${formatBytes(uptimeSize)}, benchmarks.json ${formatBytes(benchmarksSize)}`,
  )
  console.log(
    `[collect-data] uptime: ${uptime.models.length} models × ${uptime.n} buckets ` +
    `(${(uptime.n * GRID_STEP_MS / 86400000).toFixed(1)}d)`,
  )
}

main().catch((err) => {
  console.error('[collect-data] Unhandled error:', err)
  process.exit(1)
})

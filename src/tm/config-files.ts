/**
 * Layered `team-mode` configuration — the FILE READER + runtime wiring
 * (package ②, 2026-10-06).
 *
 * Package ① (`config-layers.ts`) is the PURE layer: it takes raw JSONC text
 * and returns the merged view.  This module is the IO half — it LOCATES and
 * READS the two file layers, then feeds them to the pure resolver and folds
 * the result back into an env record so `resolveTmConfig` (which only speaks
 * env strings) sees the file values.
 *
 * Two layers only, low→high: `env < 全局 < 项目`.  There is NO session layer
 * (the host's own config has none either — `opencode.ai/v2/docs/config`).
 *
 * The project layer MIRRORS the host's layering semantics: search from the
 * current directory up to the filesystem root; merge the DIRECT files
 * farthest→closest, then the `.opencode/` files in the same order, and every
 * `.opencode/` file overrides every direct file.  Within each group the
 * ancestor files are merged (closer wins) into ONE text so the pure layer's
 * two project slots (`project` / `project:.opencode`) keep their meaning.
 *
 * `TM_CONFIG_ENV_ONLY=1` is evaluated BEFORE any file is read, so the escape
 * valve costs zero IO and cannot be defeated by a file that fails to parse.
 *
 * Every root is INJECTABLE (`ConfigFileRoots`) so tests point at a temp dir
 * and never touch the user's real `~/.config/opencode`.
 */

import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import {
  CONFIG_KEYS,
  parseJsonc,
  resolveLayeredConfig,
  type EnvLike,
  type LayeredConfigResult,
} from "./config-layers.js"
import { resolveTmConfig, type TmConfig } from "./config.js"

/** The file name both layers use. */
export const CONFIG_FILE_NAME = "team-mode.jsonc"

export interface ConfigFileRoots {
  /** Directory holding the GLOBAL file (default `~/.config/opencode`). */
  globalDir?: string
  /** Directory the PROJECT search starts from (default `process.cwd()`). */
  projectDir?: string
  /** Home dir used to derive the default global dir (default `os.homedir()`). */
  home?: string
}

export interface ConfigFileRead {
  /** Global file raw JSONC, or null when it does not exist / is unreadable. */
  globalLayer: string | null
  /** Absolute path of the global file when it was read. */
  globalPath: string | null
  /** Project layers low→high: `[direct-merged, .opencode-merged]`. */
  projectLayer: Array<string | null>
  /** Every project file that was read, in the order they were merged. */
  projectPaths: string[]
  /** The `.opencode/` subset of `projectPaths` (for the report). */
  opencodePaths: string[]
  /** Files dropped WHOLE because they failed to parse (never half-applied). */
  skipped: Array<{ name: string; reason: string }>
}

function readTextFile(p: string): string | null {
  try {
    if (!fs.statSync(p).isFile()) return null
    return fs.readFileSync(p, "utf8")
  } catch {
    return null
  }
}

/** Directories from the filesystem root DOWN to `dir` (farthest first). */
function ancestorDirs(dir: string): string[] {
  const out: string[] = []
  let cur = path.resolve(dir)
  for (;;) {
    out.push(cur)
    const parent = path.dirname(cur)
    if (parent === cur) break
    cur = parent
  }
  return out.reverse()
}

/** Merge a group of ancestor files (farthest→closest, closer wins) into ONE
 *  JSON text.  A file that fails to parse is dropped WHOLE and reported — the
 *  same "skip the layer, never half-apply" rule the pure layer uses. */
function mergeTexts(
  entries: Array<{ name: string; text: string }>,
  skipped: Array<{ name: string; reason: string }>,
): string | null {
  const merged: Record<string, unknown> = {}
  let any = false
  for (const { name, text } of entries) {
    let obj: unknown
    try {
      obj = parseJsonc(text)
    } catch (e) {
      skipped.push({ name, reason: e instanceof Error ? e.message : String(e) })
      continue
    }
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
      skipped.push({ name, reason: "顶层不是 JSON 对象" })
      continue
    }
    Object.assign(merged, obj)
    any = true
  }
  return any ? JSON.stringify(merged) : null
}

/** Locate and read both file layers.  Pure IO — no env, no globals beyond the
 *  injected roots. */
export function readConfigFiles(roots: ConfigFileRoots = {}): ConfigFileRead {
  const home = roots.home ?? os.homedir()
  const globalDir = roots.globalDir ?? path.join(home, ".config", "opencode")
  const projectDir = roots.projectDir ?? process.cwd()
  const skipped: Array<{ name: string; reason: string }> = []

  const globalPath = path.join(globalDir, CONFIG_FILE_NAME)
  const globalLayer = readTextFile(globalPath)

  const directEntries: Array<{ name: string; text: string }> = []
  const opencodeEntries: Array<{ name: string; text: string }> = []
  const projectPaths: string[] = []
  const opencodePaths: string[] = []
  for (const d of ancestorDirs(projectDir)) {
    const direct = path.join(d, CONFIG_FILE_NAME)
    const t1 = readTextFile(direct)
    if (t1 !== null) {
      directEntries.push({ name: "project", text: t1 })
      projectPaths.push(direct)
    }
    const oc = path.join(d, ".opencode", CONFIG_FILE_NAME)
    const t2 = readTextFile(oc)
    if (t2 !== null) {
      opencodeEntries.push({ name: "project:.opencode", text: t2 })
      projectPaths.push(oc)
      opencodePaths.push(oc)
    }
  }

  return {
    globalLayer,
    globalPath: globalLayer !== null ? globalPath : null,
    projectLayer: [mergeTexts(directEntries, skipped), mergeTexts(opencodeEntries, skipped)],
    projectPaths,
    opencodePaths,
    skipped,
  }
}

export interface LayeredTmConfig {
  /** The resolved runtime config (file values folded in). */
  cfg: TmConfig
  /** The pure layer's full view — sources, red-line ignores, unknown keys. */
  layered: LayeredConfigResult
  /** What the reader actually found on disk. */
  files: ConfigFileRead
}

function envOnlyFromEnv(env: EnvLike): boolean {
  const raw = env.TM_CONFIG_ENV_ONLY
  return typeof raw === "string" && /^(1|true|on|yes)$/i.test(raw.trim())
}

/** A file value back to the env STRING `resolveTmConfig` parses.  Only
 *  FILE-sourced values go through here — an env-sourced value is already the
 *  raw string and must not be re-encoded (a `record` env string would iterate
 *  its characters). */
function stringifyForEnv(type: string, value: unknown): string {
  if (type === "string[]") return Array.isArray(value) ? value.map(String).join(",") : String(value)
  if (type === "record") {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return Object.entries(value as Record<string, unknown>)
        .map(([k, v]) => `${k}=${v}`)
        .join(",")
    }
    return String(value)
  }
  return String(value)
}

/**
 * Resolve the runtime config through the layered pipeline: read the files
 * (unless `TM_CONFIG_ENV_ONLY`), merge with the pure resolver, fold the
 * file-sourced values back into an env record, then hand that to
 * `resolveTmConfig`.  The returned `layered`/`files` are what `tm_stats`
 * renders so the user can see WHERE each key came from.
 */
export function resolveLayeredTmConfig(
  env: EnvLike = process.env,
  roots: ConfigFileRoots = {},
): LayeredTmConfig {
  const envOnly = envOnlyFromEnv(env)
  // The host's global config dir is `~/.config/opencode`, overridable by
  // OPENCODE_CONFIG_DIR — the global `team-mode.jsonc` lives beside the host's
  // own global config, so honor the same override (and it keeps a test that
  // redirects OPENCODE_CONFIG_DIR hermetic).
  const configDirOverride =
    typeof env.OPENCODE_CONFIG_DIR === "string" && env.OPENCODE_CONFIG_DIR.trim()
      ? env.OPENCODE_CONFIG_DIR.trim()
      : undefined
  const effectiveRoots: ConfigFileRoots = {
    ...roots,
    globalDir: roots.globalDir ?? configDirOverride,
  }
  const files: ConfigFileRead = envOnly
    ? { globalLayer: null, globalPath: null, projectLayer: [null, null], projectPaths: [], opencodePaths: [], skipped: [] }
    : readConfigFiles(effectiveRoots)
  const base = resolveLayeredConfig({
    env,
    globalLayer: files.globalLayer,
    projectLayer: files.projectLayer,
    envOnly,
  })
  const layered: LayeredConfigResult = {
    ...base,
    skippedLayers: [...files.skipped, ...base.skippedLayers],
  }
  const specByKey = new Map(CONFIG_KEYS.map((k) => [k.key, k]))
  const synthetic: EnvLike = { ...env }
  for (const [key, source] of Object.entries(layered.perKeySource)) {
    if (source === "env") continue
    const spec = specByKey.get(key)
    if (!spec) continue
    synthetic[spec.env] = stringifyForEnv(spec.type, layered.values[key])
  }
  return { cfg: resolveTmConfig(synthetic), layered, files }
}

/**
 * The `tm_stats` config section.  Renders the per-key source, the red-line
 * keys a file tried to set, the unknown keys (warned, never applied) and the
 * env-only flag — the four facts that make "which layer won" checkable.
 */
export function renderConfigSection(layered: LayeredConfigResult, files: ConfigFileRead): string {
  const lines: string[] = ["", "### 分层配置（team-mode.jsonc）", ""]
  lines.push(
    `- 层序 env < 全局 < 项目 · 全局文件 ${files.globalPath ? "有" : "无"} · ` +
      `项目文件 ${files.projectPaths.length} 个（其中 .opencode ${files.opencodePaths.length} 个）· ` +
      `TM_CONFIG_ENV_ONLY ${layered.envOnlyActive ? "开（文件层已全部忽略）" : "关"}`,
  )
  const sources = Object.entries(layered.perKeySource)
  lines.push(
    sources.length
      ? `- 每键来源：${sources.map(([k, s]) => `${k}=${s}`).join(" · ")}`
      : "- 每键来源：（没有任何键来自 env 或文件，全部走默认）",
  )
  if (layered.ignoredRedLineKeys.length) {
    lines.push(
      `- 红线豁免（文件不得改写，已忽略）：${layered.ignoredRedLineKeys.map((r) => `${r.key}（${r.layer}）`).join(" · ")}`,
    )
  }
  if (layered.unknownKeys.length) {
    lines.push(`- 未知键（告警不应用）：${layered.unknownKeys.map((u) => `${u.key}（${u.layer}）`).join(" · ")}`)
  }
  if (layered.skippedLayers.length) {
    lines.push(`- 整层跳过（解析失败）：${layered.skippedLayers.map((s) => `${s.name}：${s.reason}`).join(" · ")}`)
  }
  return lines.join("\n")
}

/**
 * Layered `team-mode` configuration — the FILE READER + runtime wiring
 * (package ②, 2026-10-06).
 *
 * Package ① (`config-layers.ts`) is the PURE layer: it takes raw JSONC text
 * and returns the merged view.  This module is the IO half — it LOCATES and
 * READS the two file layers, then hands the merged JSON values to
 * `resolveConfig` (the registry-driven validator).
 *
 * Two layers only, low→high: `全局 < 项目`.  There is NO session layer and
 * NO env layer (the host's own config has none either —
 * `opencode.ai/v2/docs/config`).
 *
 * The project layer MIRRORS the host's layering semantics: search from the
 * current directory up to the filesystem root; merge the DIRECT files
 * farthest→closest, then the `.opencode/` files in the same order, and every
 * `.opencode/` file overrides every direct file.  Within each group the
 * ancestor files are merged (closer wins) into ONE text so the pure layer's
 * two project slots (`project` / `project:.opencode`) keep their meaning.
 *
 * `envOnly` is an explicit parameter (test injection) — it removes every file
 * layer BEFORE any read, so the escape valve costs zero IO.
 *
 * Every root is INJECTABLE (`ConfigFileRoots`) so tests point at a temp dir
 * and never touch the user's real `~/.config/opencode`.
 */

import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import {
  parseJsonc,
  resolveLayeredConfig,
  type EnvLike,
  type LayeredConfigResult,
} from "./config-layers.js"
import { resolveConfig, type TmConfig } from "./config.js"
import type { AutoCreateState } from "./config-template.js"

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
  /** The resolved global dir (whether or not the file exists). */
  globalDir: string
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

/**
 * The resolved global config dir.  The host's global config dir is
 * `~/.config/opencode`, overridable by `OPENCODE_CONFIG_DIR` — the global
 * `team-mode.jsonc` lives beside the host's own global config, so honor the
 * same override (and it keeps a test that redirects OPENCODE_CONFIG_DIR
 * hermetic).  `OPENCODE_CONFIG_DIR` is the host's own variable, not ours.
 */
export function resolveGlobalDir(roots: ConfigFileRoots = {}, env: EnvLike = process.env): string {
  const home = roots.home ?? os.homedir()
  const override =
    typeof env.OPENCODE_CONFIG_DIR === "string" && env.OPENCODE_CONFIG_DIR.trim()
      ? env.OPENCODE_CONFIG_DIR.trim()
      : undefined
  return roots.globalDir ?? override ?? path.join(home, ".config", "opencode")
}

/** Locate and read both file layers.  Pure IO — no globals beyond the
 *  injected roots. */
export function readConfigFiles(roots: ConfigFileRoots = {}, env: EnvLike = process.env): ConfigFileRead {
  const globalDir = resolveGlobalDir(roots, env)
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
    globalDir,
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

export interface ResolveLayeredTmConfigOptions {
  /** Remove every file layer (test injection). */
  envOnly?: boolean
  /** Lowest-priority default overrides (BELOW the file layers).  v2 uses it to
   *  default `webfetchAllowedDomains` to `["*"]` when no file sets it.  The
   *  auto-created global file is INERT (every key commented), so it sets
   *  nothing and never shadows these; a user-edited file still wins. */
  configDefaults?: Record<string, unknown>
  /** Env used only for `OPENCODE_CONFIG_DIR` (the host's own variable). */
  env?: EnvLike
}

const EMPTY_FILES = (globalDir: string): ConfigFileRead => ({
  globalDir,
  globalLayer: null,
  globalPath: null,
  projectLayer: [null, null],
  projectPaths: [],
  opencodePaths: [],
  skipped: [],
})

/**
 * Resolve the runtime config through the layered pipeline: read the files
 * (unless `envOnly`), merge with the pure resolver, then hand the merged JSON
 * values (plus any `configDefaults`) to `resolveConfig`.  The returned
 * `layered`/`files` are what `tm_stats` renders so the user can see WHERE
 * each key came from.
 */
export function resolveLayeredTmConfig(
  roots: ConfigFileRoots = {},
  opts: ResolveLayeredTmConfigOptions = {},
): LayeredTmConfig {
  const env = opts.env ?? process.env
  const envOnly = opts.envOnly ?? false
  const globalDir = resolveGlobalDir(roots, env)
  const files: ConfigFileRead = envOnly ? EMPTY_FILES(globalDir) : readConfigFiles(roots, env)
  const base = resolveLayeredConfig({
    globalLayer: files.globalLayer,
    projectLayer: files.projectLayer,
    envOnly,
  })
  const layered: LayeredConfigResult = {
    ...base,
    skippedLayers: [...files.skipped, ...base.skippedLayers],
  }
  // `configDefaults` sits BELOW the file layers: a file value always wins.
  const merged: Record<string, unknown> = { ...(opts.configDefaults ?? {}), ...layered.values }
  return { cfg: resolveConfig(merged), layered, files }
}

/** The four auto-create states in the user's words — the boot row records the
 *  token, the report must not make the user decode it. */
const AUTO_CREATE_LABEL: Record<AutoCreateState, string> = {
  created: "已创建",
  present: "已存在",
  off: "关闭",
  failed: "创建失败",
}

/**
 * The `tm_stats` config section.  Renders the per-key source, the red-line
 * keys a PROJECT file tried to set, the unknown keys (warned, never applied),
 * the env-only flag and the auto-create outcome — the facts that make "which
 * layer won" checkable.  `autoCreate` is the state the boot row recorded
 * (`ensureGlobalConfig`); omitted only by a caller that never ran it.
 */
export function renderConfigSection(
  layered: LayeredConfigResult,
  files: ConfigFileRead,
  autoCreate?: AutoCreateState,
): string {
  const lines: string[] = ["", "### 分层配置（team-mode.jsonc）", ""]
  lines.push(
    `- 层序 全局 < 项目 · 全局文件 ${files.globalPath ? "有" : "无"} · ` +
      `项目文件 ${files.projectPaths.length} 个（其中 .opencode ${files.opencodePaths.length} 个）· ` +
      `envOnly ${layered.envOnlyActive ? "开（文件层已全部忽略）" : "关"}`,
  )
  if (autoCreate) {
    lines.push(`- 全局文件自动创建：${AUTO_CREATE_LABEL[autoCreate]}（${autoCreate}）`)
  }
  const sources = Object.entries(layered.perKeySource)
  lines.push(
    sources.length
      ? `- 每键来源：${sources.map(([k, s]) => `${k}=${s}`).join(" · ")}`
      : "- 每键来源：（没有任何键来自文件，全部走默认）",
  )
  if (layered.ignoredRedLineKeys.length) {
    lines.push(
      `- 红线键被项目文件尝试设置（已忽略，仅全局生效）：${layered.ignoredRedLineKeys.map((r) => `${r.key}（${r.layer}）`).join(" · ")}`,
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

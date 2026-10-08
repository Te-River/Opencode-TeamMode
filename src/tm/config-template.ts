/**
 * The global `team-mode.jsonc` template + its idempotent writer.
 *
 * `renderConfigTemplate()` walks `CONFIG_KEYS` and nothing else, so a comment,
 * a key and its default can never drift from the registry.  `ensureGlobalConfig`
 * writes it ATOMICALLY (tmp + rename) and ONLY when the file is absent — an
 * existing file is never overwritten (the user's edits are theirs).
 *
 * The plugin calls this at boot (see `createTmTools`), so a fresh install gets
 * a fully-commented config listing every key.  `TM_CONFIG_AUTOCREATE=off` (an
 * internal/test switch) or the plugin option `autoCreate:false` turns it off.
 */

import * as fs from "node:fs"
import * as path from "node:path"
import { CONFIG_KEYS } from "./config-layers.js"
import { CONFIG_FILE_NAME } from "./config-files.js"

/** The file header — Chinese, and the only prose the template carries. */
const HEADER = [
  "// team-mode.jsonc — TeamMode 唯一配置源",
  "// 本文件由插件首次启动时自动生成；删除后下次启动会重新生成。",
  "// 层序：全局（本文件） < 项目（<repo>/team-mode.jsonc 或 <repo>/.opencode/team-mode.jsonc）",
  "// 红线键（redLine）只能在本全局文件里设置；项目文件设置会被忽略。",
].join("\n")

/** Render the full global config file (JSONC, every registry key listed).
 *
 *  Every key is written as a COMMENT, so the auto-created file sets NOTHING:
 *  the registry defaults answer, and a personality's `configDefaults` (v2's
 *  `webfetchAllowedDomains: ["*"]`) is not shadowed by a file nobody edited.
 *  A user uncomments the keys they want to change.  The file is valid JSONC
 *  (`{}` once the comments are masked). */
export function renderConfigTemplate(): string {
  const lines: string[] = [HEADER, "{"]
  CONFIG_KEYS.forEach((spec, i) => {
    const doc = spec.redLine ? `${spec.doc}（红线：仅全局）` : spec.doc
    lines.push(`  // ${doc}`)
    const comma = i === CONFIG_KEYS.length - 1 ? "" : ","
    lines.push(`  // ${JSON.stringify(spec.key)}: ${JSON.stringify(spec.default)}${comma}`)
  })
  lines.push("}")
  return lines.join("\n") + "\n"
}

export type AutoCreateState = "created" | "present" | "off" | "failed"

/**
 * Ensure the global config file exists.  `autoCreate:false` writes nothing
 * and reports `off`.  An existing file is left byte-for-byte untouched
 * (`present`).  A missing one is written atomically (`created`).  A write
 * that THROWS reports `failed` — distinct from `present`, so the boot row
 * does not claim a file exists when the write never landed.
 */
export function ensureGlobalConfig(globalDir: string, opts: { autoCreate?: boolean } = {}): AutoCreateState {
  if (opts.autoCreate === false) return "off"
  const file = path.join(globalDir, CONFIG_FILE_NAME)
  try {
    if (fs.existsSync(file)) return "present"
  } catch {
    /* fall through to the write attempt */
  }
  try {
    fs.mkdirSync(globalDir, { recursive: true })
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
    fs.writeFileSync(tmp, renderConfigTemplate(), "utf8")
    fs.renameSync(tmp, file)
    return "created"
  } catch {
    // A read-only config dir must not cost the session its tools; the file
    // simply stays absent and the registry defaults answer.  Reported as
    // `failed` so the boot row does not read as "a file is there".
    return "failed"
  }
}

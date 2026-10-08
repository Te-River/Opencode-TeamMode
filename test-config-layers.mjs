/**
 * Layered `team-mode` configuration — PURE unit tests (package ①, 2026-10-06).
 *
 * Runs against the BUILT output (./dist/tm/config-layers.js), like the other
 * suites.  No host is booted: every case hands raw JSONC text to
 * `resolveLayeredConfig` and asserts the resolved view.
 *
 * Coverage:
 *   1. layer order: same key global < project; different keys untouched
 *   2. project layer: `.opencode/` beats the direct file
 *   3. a layer that fails to parse is skipped WHOLE + reported; good layers live
 *   4. a wrong-typed key is dropped from that layer only, falls to the next
 *   5. a red-line key is honored ONLY in the global file (D1)
 *   6. an unknown key is reported and never applied
 *   7. envOnly removes every file layer
 *   8. JSONC: comments, trailing commas, `//` inside a string
 *   9. the red-line exempt table is exactly the five documented knobs
 *  10. the FILE READER — locate + read both layers from an injected root
 *  11. AUTO-CREATE: all keys, idempotent, never overwrite
 *  12. LAYERING: project overrides global; `.opencode/` overrides direct
 *  13. RED-LINE = GLOBAL ONLY: a project value is ignored; a global value wins
 *  14. ALL-KEYS ROUND-TRIP: template → parse → resolveConfig == registry default
 *  15. NO ENV: a `TM_*` env var no longer affects the resolved config
 *  16. configDefaults: a PRISTINE file does not shadow a personality default;
 *      a USER-EDITED file wins
 *  17. INTEGER HEURISTIC: a fractional default keeps its fraction; an integer
 *      default truncates the value
 *  18. TIER INHERITANCE through the FILE READER: the auto-created (inert) file
 *      leaves the tiers at their defaults; a user edit of `offloadThreshold`
 *      reaches both tiers; an explicit tier wins
 */

import assert from "node:assert"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import {
  resolveLayeredConfig,
  parseJsonc,
  maskJsoncComments,
  RED_LINE_EXEMPT_KEYS,
  CONFIG_KEYS,
} from "./dist/tm/config-layers.js"
import {
  readConfigFiles,
  resolveLayeredTmConfig,
  renderConfigSection,
  CONFIG_FILE_NAME,
} from "./dist/tm/config-files.js"
import { resolveConfig, coerceValue } from "./dist/tm/config.js"
import { renderConfigTemplate, ensureGlobalConfig } from "./dist/tm/config-template.js"

const eq = (a, b, msg) => assert.strictEqual(a, b, msg)

// ---------------------------------------------------------------------------
// 1. layer order — same key global < project; different keys untouched
// ---------------------------------------------------------------------------
{
  const r = resolveLayeredConfig({
    globalLayer: `{ "offloadThreshold": 6000, "previewLines": 50 }`,
    projectLayer: `{ "offloadThreshold": 7000 }`,
  })
  eq(r.values.offloadThreshold, 7000, "project wins the same key")
  eq(r.perKeySource.offloadThreshold, "project", "source is project")
  eq(r.values.previewLines, 50, "global-only key survives untouched")
  eq(r.perKeySource.previewLines, "global", "global-only key source is global")
  eq(r.skippedLayers.length, 0, "no layer skipped")
  console.log("1. layer order: OK (global < project; distinct keys independent)")
}

// ---------------------------------------------------------------------------
// 2. project layer — `.opencode/` beats the direct file
// ---------------------------------------------------------------------------
{
  const r = resolveLayeredConfig({
    projectLayer: [`{ "offloadThreshold": 100 }`, `{ "offloadThreshold": 200 }`],
  })
  eq(r.values.offloadThreshold, 200, ".opencode/ wins over the direct file")
  eq(r.perKeySource.offloadThreshold, "project:.opencode", "source names .opencode")
  // a key only in the direct file still applies
  const r2 = resolveLayeredConfig({
    projectLayer: [`{ "previewLines": 11 }`, `{ "offloadThreshold": 200 }`],
  })
  eq(r2.values.previewLines, 11, "direct-file-only key applies")
  eq(r2.perKeySource.previewLines, "project", "source is the direct project file")
  console.log("2. project .opencode priority: OK")
}

// ---------------------------------------------------------------------------
// 3. a bad layer is skipped WHOLE + reported; good layers still apply
// ---------------------------------------------------------------------------
{
  const r = resolveLayeredConfig({
    globalLayer: `{ "offloadThreshold": 6000 }`,
    projectLayer: `{ "offloadThreshold": 7000`, // unclosed brace = syntax error
  })
  eq(r.values.offloadThreshold, 6000, "global still applies after project skip")
  eq(r.perKeySource.offloadThreshold, "global", "source falls to global")
  eq(r.skippedLayers.length, 1, "one layer reported skipped")
  eq(r.skippedLayers[0].name, "project", "the skipped layer is named")
  assert.ok(r.skippedLayers[0].reason.length > 0, "the skip carries a reason")
  // a half-parsed project must NOT leak its good-looking keys
  const r2 = resolveLayeredConfig({
    globalLayer: `{ "offloadThreshold": 6000 }`,
    projectLayer: `{ "previewLines": 99, "offloadThreshold": 7000`, // previewLines looks fine
  })
  eq(r2.values.previewLines, undefined, "no key from a broken layer is applied")
  eq(r2.values.offloadThreshold, 6000, "broken layer contributes nothing")
  console.log("3. whole-layer skip: OK (reported, no half-apply)")
}

// ---------------------------------------------------------------------------
// 4. a wrong-typed key is dropped from that layer only, falls to the next
// ---------------------------------------------------------------------------
{
  const r = resolveLayeredConfig({
    globalLayer: `{ "offloadThreshold": 6000 }`,
    projectLayer: `{ "offloadThreshold": "not-a-number", "previewLines": 77 }`,
  })
  eq(r.values.offloadThreshold, 6000, "bad-typed key falls to the global layer")
  eq(r.perKeySource.offloadThreshold, "global", "source is global")
  eq(r.values.previewLines, 77, "sibling key in the same layer still applies")
  // with no lower file layer it falls all the way to the default
  const r2 = resolveLayeredConfig({
    projectLayer: `{ "offloadThreshold": "bad" }`,
  })
  eq(r2.values.offloadThreshold, undefined, "bad-typed key never enters values")
  eq(resolveConfig(r2.values).offloadThreshold, 2000, "…and the default answers downstream")
  console.log("4. per-key type drop: OK (falls to the next layer)")
}

// ---------------------------------------------------------------------------
// 5. a red-line key is honored ONLY in the global file (D1)
// ---------------------------------------------------------------------------
{
  // project file sets a red-line key -> ignored + reported; global/default answers
  const r = resolveLayeredConfig({
    globalLayer: `{ "envProtect": "strict" }`,
    projectLayer: `{ "envProtect": "off", "offloadThreshold": 7000 }`,
  })
  eq(r.values.envProtect, "strict", "red-line key keeps its GLOBAL value")
  eq(r.perKeySource.envProtect, "global", "red-line source is global")
  eq(r.ignoredRedLineKeys.length, 1, "the project attempt is reported")
  eq(r.ignoredRedLineKeys[0].key, "envProtect", "reported key name")
  eq(r.ignoredRedLineKeys[0].layer, "project", "reported layer name")
  eq(r.values.offloadThreshold, 7000, "a non-red-line key in the same file applies")
  // no global value -> the red-line key is simply absent (default answers)
  const r2 = resolveLayeredConfig({
    projectLayer: `{ "webfetchAllowedDomains": ["evil.example"] }`,
  })
  assert.ok(!("webfetchAllowedDomains" in r2.values), "red-line key never enters values from a project file")
  eq(r2.ignoredRedLineKeys[0].key, "webfetchAllowedDomains", "reported")
  // a GLOBAL red-line value DOES apply
  const r3 = resolveLayeredConfig({
    globalLayer: `{ "webfetchAllowedDomains": ["good.example"] }`,
  })
  assert.deepEqual(r3.values.webfetchAllowedDomains, ["good.example"], "a global red-line value applies")
  eq(r3.ignoredRedLineKeys.length, 0, "no ignore when the global file sets it")
  console.log("5. red-line = global only: OK (project ignored + reported, global honored)")
}

// ---------------------------------------------------------------------------
// 6. an unknown key is reported and never applied
// ---------------------------------------------------------------------------
{
  const r = resolveLayeredConfig({
    projectLayer: `{ "totallyMadeUp": 1, "offloadThreshold": 7000 }`,
  })
  assert.ok(!("totallyMadeUp" in r.values), "unknown key never enters values")
  eq(r.unknownKeys.length, 1, "unknown key reported")
  eq(r.unknownKeys[0].key, "totallyMadeUp", "reported key name")
  eq(r.unknownKeys[0].layer, "project", "reported layer name")
  eq(r.values.offloadThreshold, 7000, "known sibling still applies")
  console.log("6. unknown keys: OK (collected, not applied)")
}

// ---------------------------------------------------------------------------
// 7. envOnly removes every file layer
// ---------------------------------------------------------------------------
{
  const r = resolveLayeredConfig({
    globalLayer: `{ "offloadThreshold": 6000 }`,
    projectLayer: `{ "offloadThreshold": 7000 }`,
    envOnly: true,
  })
  eq(r.envOnlyActive, true, "envOnlyActive is true")
  eq(r.values.offloadThreshold, undefined, "no file value survives")
  eq(r.skippedLayers.length, 0, "no layer is even parsed")
  eq(r.ignoredRedLineKeys.length, 0, "no file attempt is seen")
  const r2 = resolveLayeredConfig({
    projectLayer: `{ "offloadThreshold": 7000 }`,
    envOnly: false,
  })
  eq(r2.envOnlyActive, false, "explicit envOnly:false keeps the file layer")
  eq(r2.values.offloadThreshold, 7000, "file layer applies when envOnly is off")
  console.log("7. envOnly: OK (file layers removed, flag reported)")
}

// ---------------------------------------------------------------------------
// 8. JSONC — comments, trailing commas, `//` inside a string
// ---------------------------------------------------------------------------
{
  const src = `{
  // a line comment with a "brace" { and a comma ,
  "offloadThreshold": 7000, /* block comment */
  "previewLines": 42,
  "blackboardDir": "C:/tmp//not-a-comment", // trailing comment
}`
  const r = resolveLayeredConfig({ projectLayer: src })
  eq(r.values.offloadThreshold, 7000, "line comment ignored")
  eq(r.values.previewLines, 42, "block comment ignored")
  eq(r.values.blackboardDir, "C:/tmp//not-a-comment", "// inside a string preserved")
  eq(r.skippedLayers.length, 0, "valid JSONC parses")
  // the mask preserves offsets and string content byte-for-byte
  const masked = maskJsoncComments(`{"a":"x//y"} // tail`)
  eq(masked.length, `{"a":"x//y"} // tail`.length, "mask preserves length")
  assert.ok(masked.includes(`"x//y"`), "string content survives the mask")
  assert.ok(!masked.includes("tail"), "the trailing comment is masked out")
  // parseJsonc tolerates a trailing comma and rejects a real syntax error
  eq(parseJsonc(`{"a":1,}`).a, 1, "trailing comma tolerated")
  assert.throws(() => parseJsonc(`{"a":1,,}`), "double comma is a syntax error")
  console.log("8. JSONC: OK (comments, trailing commas, string `//`)")
}

// ---------------------------------------------------------------------------
// 9. the red-line exempt table is exactly the five documented knobs
// ---------------------------------------------------------------------------
{
  const expected = [
    "envProtect",
    "r6FineAsk",
    "privateSpace",
    "webfetchAllowedDomains",
    "bashReadonlyAllowed",
  ]
  eq(RED_LINE_EXEMPT_KEYS.length, expected.length, "five red-line keys")
  for (const k of expected) assert.ok(RED_LINE_EXEMPT_KEYS.includes(k), `red-line table has ${k}`)
  for (const spec of CONFIG_KEYS.filter((s) => s.redLine)) {
    assert.ok(spec.redLineReason && spec.redLineReason.length > 0, `${spec.key} carries a reason`)
  }
  console.log("9. red-line table: OK (five knobs, each with a reason)")
}

// ---------------------------------------------------------------------------
// 10. the FILE READER — locate + read both layers from an injected root
// ---------------------------------------------------------------------------
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tm-cfg-"))
  const home = path.join(tmp, "home")
  const globalDir = path.join(home, ".config", "opencode")
  const proj = path.join(tmp, "proj")
  const sub = path.join(proj, "sub")
  fs.mkdirSync(globalDir, { recursive: true })
  fs.mkdirSync(path.join(sub, ".opencode"), { recursive: true })

  // global sets one key; the direct project file overrides it and adds another;
  // the `.opencode/` file overrides the direct one (host semantics).
  fs.writeFileSync(path.join(globalDir, CONFIG_FILE_NAME), `{ "offloadThreshold": 6000, "previewLines": 30 }`)
  fs.writeFileSync(path.join(proj, CONFIG_FILE_NAME), `{ "offloadThreshold": 7000, "searchMaxHits": 9 }`)
  fs.writeFileSync(path.join(sub, ".opencode", CONFIG_FILE_NAME), `{ "offloadThreshold": 8000 }`)

  const roots = { globalDir, projectDir: sub, home }
  const files = readConfigFiles(roots)
  eq(files.globalPath, path.join(globalDir, CONFIG_FILE_NAME), "global file located")
  eq(files.projectPaths.length, 2, "both project files read (direct + .opencode)")
  eq(files.opencodePaths.length, 1, "one .opencode file")

  const r = resolveLayeredTmConfig(roots)
  eq(r.cfg.offloadThreshold, 8000, ".opencode beats the direct file")
  eq(r.cfg.previewLines, 30, "global-only key survives")
  eq(r.cfg.searchMaxHits, 9, "direct-only key survives")
  eq(r.layered.perKeySource.offloadThreshold, "project:.opencode", "source is the .opencode layer")
  eq(r.layered.perKeySource.previewLines, "global", "source is global")
  eq(r.layered.perKeySource.searchMaxHits, "project", "source is the direct project layer")

  // a bad layer is skipped WHOLE (never half-applied) and reported
  fs.writeFileSync(path.join(proj, CONFIG_FILE_NAME), `{ "offloadThreshold": 7000,, }`)
  const rBad = resolveLayeredTmConfig(roots)
  eq(rBad.cfg.offloadThreshold, 8000, "the broken direct layer is skipped; .opencode still wins")
  assert.ok(rBad.layered.skippedLayers.some((s) => s.name === "project"), "the broken layer is reported")

  // unknown keys are collected, never applied
  fs.writeFileSync(path.join(proj, CONFIG_FILE_NAME), `{ "totallyMadeUp": 1 }`)
  const rUnknown = resolveLayeredTmConfig(roots)
  assert.ok(rUnknown.layered.unknownKeys.some((u) => u.key === "totallyMadeUp"), "unknown key collected")
  assert.ok(!("totallyMadeUp" in rUnknown.layered.values), "unknown key never applied")

  // envOnly removes every file layer BEFORE any read
  const rEnvOnly = resolveLayeredTmConfig(roots, { envOnly: true })
  eq(rEnvOnly.layered.envOnlyActive, true, "env-only flag reported")
  eq(rEnvOnly.files.projectPaths.length, 0, "no project file was read")
  eq(rEnvOnly.files.globalPath, null, "no global file was read")
  eq(rEnvOnly.cfg.offloadThreshold, 2000, "file value ignored; default stands")

  // the rendered section names the sources
  const section = renderConfigSection(r.layered, r.files)
  assert.match(section, /offloadThreshold=project:\.opencode/, "section names the winning layer")
  assert.match(renderConfigSection(rUnknown.layered, rUnknown.files), /未知键/, "section reports unknown keys when present")

  fs.rmSync(tmp, { recursive: true, force: true })
  console.log("10. file reader: OK (global/project/.opencode precedence, whole-layer skip, envOnly, unknown keys)")
}

// ---------------------------------------------------------------------------
// 11. AUTO-CREATE — all keys, idempotent, never overwrite
// ---------------------------------------------------------------------------
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tm-autocreate-"))
  const globalDir = path.join(tmp, "cfg")
  const file = path.join(globalDir, CONFIG_FILE_NAME)

  const first = ensureGlobalConfig(globalDir, { autoCreate: true })
  eq(first, "created", "a missing file is created")
  assert.ok(fs.existsSync(file), "the file exists on disk")
  const text = fs.readFileSync(file, "utf8")
  for (const spec of CONFIG_KEYS) {
    assert.ok(text.includes(`// ${JSON.stringify(spec.key)}:`), `the template lists ${spec.key} (commented)`)
  }
  // it parses as JSONC and resolves to the registry defaults — the template is
  // INERT, so it sets NOTHING (every key is a comment).
  const parsed = parseJsonc(text)
  eq(Object.keys(parsed).length, 0, "the inert template sets no key")
  for (const spec of CONFIG_KEYS) {
    assert.deepEqual(resolveConfig(parsed)[spec.key], spec.default, `${spec.key} resolves to its registry default`)
  }

  // idempotent: a second call leaves the bytes untouched
  const second = ensureGlobalConfig(globalDir, { autoCreate: true })
  eq(second, "present", "a second call reports present")
  eq(fs.readFileSync(file, "utf8"), text, "the bytes are unchanged (idempotent)")

  // never overwrite: a user-edited file survives
  fs.writeFileSync(file, `{ "offloadThreshold": 12345 }`)
  const third = ensureGlobalConfig(globalDir, { autoCreate: true })
  eq(third, "present", "an existing file reports present")
  eq(fs.readFileSync(file, "utf8"), `{ "offloadThreshold": 12345 }`, "the user's file is never overwritten")

  // autoCreate:false writes nothing
  const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), "tm-autocreate-off-"))
  const off = ensureGlobalConfig(tmp2, { autoCreate: false })
  eq(off, "off", "autoCreate:false reports off")
  assert.ok(!fs.existsSync(path.join(tmp2, CONFIG_FILE_NAME)), "and writes nothing")

  fs.rmSync(tmp, { recursive: true, force: true })
  fs.rmSync(tmp2, { recursive: true, force: true })
  console.log("11. auto-create: OK (all keys, idempotent, never overwrite, off switch)")
}

// ---------------------------------------------------------------------------
// 12. LAYERING — project overrides global; `.opencode/` overrides direct
// ---------------------------------------------------------------------------
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tm-layer-"))
  const globalDir = path.join(tmp, "cfg")
  const proj = path.join(tmp, "proj")
  fs.mkdirSync(globalDir, { recursive: true })
  fs.mkdirSync(path.join(proj, ".opencode"), { recursive: true })
  fs.writeFileSync(path.join(globalDir, CONFIG_FILE_NAME), `{ "offloadThreshold": 1000, "previewLines": 11 }`)
  fs.writeFileSync(path.join(proj, CONFIG_FILE_NAME), `{ "offloadThreshold": 2000 }`)
  fs.writeFileSync(path.join(proj, ".opencode", CONFIG_FILE_NAME), `{ "offloadThreshold": 3000 }`)

  const r = resolveLayeredTmConfig({ globalDir, projectDir: proj })
  eq(r.cfg.offloadThreshold, 3000, ".opencode overrides the direct project file")
  eq(r.cfg.previewLines, 11, "a global-only key survives")
  eq(r.layered.perKeySource.offloadThreshold, "project:.opencode", "source names the winning layer")
  fs.rmSync(tmp, { recursive: true, force: true })
  console.log("12. layering: OK (project overrides global, .opencode overrides direct)")
}

// ---------------------------------------------------------------------------
// 13. RED-LINE = GLOBAL ONLY (end to end through the file reader)
// ---------------------------------------------------------------------------
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tm-redline-"))
  const globalDir = path.join(tmp, "cfg")
  const proj = path.join(tmp, "proj")
  fs.mkdirSync(globalDir, { recursive: true })
  fs.mkdirSync(proj, { recursive: true })
  // project tries to widen the allowlist; global sets it
  fs.writeFileSync(path.join(globalDir, CONFIG_FILE_NAME), `{ "webfetchAllowedDomains": ["good.example"] }`)
  fs.writeFileSync(path.join(proj, CONFIG_FILE_NAME), `{ "webfetchAllowedDomains": ["evil.example"] }`)
  const r = resolveLayeredTmConfig({ globalDir, projectDir: proj })
  assert.deepEqual(r.cfg.webfetchAllowedDomains, ["good.example"], "the global red-line value wins")
  assert.ok(r.layered.ignoredRedLineKeys.some((x) => x.key === "webfetchAllowedDomains"), "the project attempt is reported")
  // with NO global value, the project attempt is ignored and the default answers
  fs.writeFileSync(path.join(globalDir, CONFIG_FILE_NAME), `{}`)
  const r2 = resolveLayeredTmConfig({ globalDir, projectDir: proj })
  assert.ok(r2.cfg.webfetchAllowedDomains.includes("cn.bing.com"), "the default allowlist answers")
  assert.ok(!r2.cfg.webfetchAllowedDomains.includes("evil.example"), "the project value never applied")
  fs.rmSync(tmp, { recursive: true, force: true })
  console.log("13. red-line = global only: OK (project ignored, global honored, default fallback)")
}

// ---------------------------------------------------------------------------
// 14. ALL-KEYS ROUND-TRIP — the INERT template lists every key (as a comment),
//     parses to `{}`, and resolveConfig({}) == registry default.
// ---------------------------------------------------------------------------
{
  const text = renderConfigTemplate()
  // The template is INERT: every key is a COMMENT, so the file sets nothing.
  const parsed = parseJsonc(text)
  assert.deepEqual(parsed, {}, "the auto-created template sets no key (all commented)")
  for (const spec of CONFIG_KEYS) {
    assert.ok(text.includes(`// ${JSON.stringify(spec.key)}:`), `${spec.key} is listed in the template`)
    assert.ok(text.includes(spec.doc), `${spec.key}'s doc comment is rendered`)
    assert.ok(/\p{Script=Han}/u.test(spec.doc), `${spec.key}'s doc is Chinese (the template's only prose)`)
  }
  const cfg = resolveConfig(parsed)
  for (const spec of CONFIG_KEYS) {
    assert.deepEqual(cfg[spec.key], spec.default, `${spec.key} round-trips to its registry default`)
  }
  // and the registry default is what resolveConfig({}) yields
  const bare = resolveConfig({})
  for (const spec of CONFIG_KEYS) {
    assert.deepEqual(bare[spec.key], spec.default, `${spec.key} default with no values`)
  }
  console.log("14. all-keys round-trip: OK (inert template lists every key; parse == {}; resolveConfig({}) == registry)")
}

// ---------------------------------------------------------------------------
// 15. NO ENV — a `TM_*` env var no longer affects the resolved config
// ---------------------------------------------------------------------------
{
  const prev = process.env.TM_OFFLOAD_THRESHOLD
  process.env.TM_OFFLOAD_THRESHOLD = "9999"
  try {
    eq(resolveConfig({}).offloadThreshold, 2000, "a TM_* env var does not reach resolveConfig")
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tm-noenv-"))
    const r = resolveLayeredTmConfig({ globalDir: tmp, projectDir: tmp })
    eq(r.cfg.offloadThreshold, 2000, "…and it does not reach the layered resolver either")
    fs.rmSync(tmp, { recursive: true, force: true })
  } finally {
    if (prev === undefined) delete process.env.TM_OFFLOAD_THRESHOLD
    else process.env.TM_OFFLOAD_THRESHOLD = prev
  }
  console.log("15. no env: OK (a TM_* env var no longer affects the resolved config)")
}

// ---------------------------------------------------------------------------
// 16. INERT TEMPLATE + configDefaults — the auto-created file sets NOTHING, so
//     a personality default (configDefaults, BELOW the file layers) applies; a
//     USER-EDITED file is a decision and wins.
// ---------------------------------------------------------------------------
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tm-defaultswin-"))
  const globalDir = path.join(tmp, "cfg")
  const proj = path.join(tmp, "proj")
  fs.mkdirSync(proj, { recursive: true })
  ensureGlobalConfig(globalDir, { autoCreate: true })
  const pristine = resolveLayeredTmConfig({ globalDir, projectDir: proj }, {
    configDefaults: { webfetchAllowedDomains: ["*"] },
  })
  assert.deepEqual(pristine.cfg.webfetchAllowedDomains, ["*"], "inert file: the personality default applies")
  eq(pristine.layered.perKeySource.webfetchAllowedDomains, undefined, "…and no file key claims the source")
  // a user edit makes the file a decision -> the file value wins
  fs.writeFileSync(path.join(globalDir, CONFIG_FILE_NAME), `{ "webfetchAllowedDomains": ["user.example"] }`)
  const edited = resolveLayeredTmConfig({ globalDir, projectDir: proj }, {
    configDefaults: { webfetchAllowedDomains: ["*"] },
  })
  assert.deepEqual(edited.cfg.webfetchAllowedDomains, ["user.example"], "edited file: the file value wins")
  eq(edited.layered.perKeySource.webfetchAllowedDomains, "global", "…and the source is recorded as global")
  fs.rmSync(tmp, { recursive: true, force: true })
  console.log("16. inert template + configDefaults: OK (auto-created file sets nothing -> default applies; edited -> file wins)")
}

// ---------------------------------------------------------------------------
// 17. INTEGER HEURISTIC — a fractional default keeps its fraction; an integer
//     default truncates the value (registry contract, config.ts:226).
// ---------------------------------------------------------------------------
{
  const spec = (k) => CONFIG_KEYS.find((s) => s.key === k)
  eq(coerceValue(spec("searchRelevanceFloor"), 0.5), 0.5, "searchRelevanceFloor keeps a fraction")
  eq(coerceValue(spec("retryJitter"), 0.42), 0.42, "retryJitter keeps a fraction")
  eq(coerceValue(spec("previewMaxTokens"), 80.9), 80, "an integer-default key truncates 80.9 -> 80")
  eq(coerceValue(spec("offloadThreshold"), 2000.9), 2000, "an integer-default key truncates 2000.9 -> 2000")
  console.log("17. integer heuristic: OK (fractions kept, integer keys truncated)")
}

// ---------------------------------------------------------------------------
// 18. TIER INHERITANCE through the FILE READER — the reviewer's scenario: the
//     auto-created (inert) file must not shadow the inheritance rule.  Inert ->
//     the tiers keep their defaults; a user edit of `offloadThreshold` reaches
//     both tiers; an explicit tier wins.
// ---------------------------------------------------------------------------
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tm-tier-"))
  const globalDir = path.join(tmp, "cfg")
  const proj = path.join(tmp, "proj")
  fs.mkdirSync(proj, { recursive: true })
  ensureGlobalConfig(globalDir, { autoCreate: true })
  const inert = resolveLayeredTmConfig({ globalDir, projectDir: proj })
  eq(inert.cfg.offloadThresholdText, 4000, "inert file: the text tier keeps its default")
  eq(inert.cfg.offloadThresholdData, 2000, "inert file: the data tier keeps its default")
  fs.writeFileSync(path.join(globalDir, CONFIG_FILE_NAME), `{ "offloadThreshold": 8000 }`)
  const inh = resolveLayeredTmConfig({ globalDir, projectDir: proj })
  eq(inh.cfg.offloadThreshold, 8000, "the edited file's global value applies")
  eq(inh.cfg.offloadThresholdText, 8000, "the text tier inherits the file's global")
  eq(inh.cfg.offloadThresholdData, 8000, "the data tier inherits the file's global")
  fs.writeFileSync(path.join(globalDir, CONFIG_FILE_NAME), `{ "offloadThreshold": 8000, "offloadThresholdText": 5000 }`)
  const mix = resolveLayeredTmConfig({ globalDir, projectDir: proj })
  eq(mix.cfg.offloadThresholdText, 5000, "an explicit text tier wins over the inherited value")
  eq(mix.cfg.offloadThresholdData, 8000, "the unset data tier still inherits")
  fs.rmSync(tmp, { recursive: true, force: true })
  console.log("18. tier inheritance through the file reader: OK (inert -> defaults; edit 8000 -> 8000/8000; explicit tier wins)")
}

console.log(`\ntest-config-layers.mjs: ALL PASS (18 groups)`)

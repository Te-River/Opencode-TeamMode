/**
 * Layered `team-mode` configuration — PURE unit tests (package ①, 2026-10-06).
 *
 * Runs against the BUILT output (./dist/tm/config-layers.js), like the other
 * suites.  No host is booted, no file is written: every case hands raw JSONC
 * text to `resolveLayeredConfig` and asserts the resolved view.
 *
 * Coverage:
 *   1. layer order: same key env < global < project; different keys untouched
 *   2. project layer: `.opencode/` beats the direct file
 *   3. a layer that fails to parse is skipped WHOLE + reported; good layers live
 *   4. a wrong-typed key is dropped from that layer only, falls to the next
 *   5. a red-line key in a file is ignored + reported; env/default still answers
 *   6. an unknown key is reported and never applied
 *   7. TM_CONFIG_ENV_ONLY removes every file layer (envOnlyActive)
 *   8. JSONC: comments, trailing commas, `//` inside a string
 *   9. the red-line exempt table is exactly the six documented knobs
 */

import assert from "node:assert"
import {
  resolveLayeredConfig,
  parseJsonc,
  maskJsoncComments,
  RED_LINE_EXEMPT_KEYS,
  CONFIG_KEYS,
} from "./dist/tm/config-layers.js"

const eq = (a, b, msg) => assert.strictEqual(a, b, msg)

// ---------------------------------------------------------------------------
// 1. layer order — same key env < global < project; different keys untouched
// ---------------------------------------------------------------------------
{
  const r = resolveLayeredConfig({
    env: { TM_OFFLOAD_THRESHOLD: "5000", TM_PREVIEW_LINES: "50" },
    globalLayer: `{ "offloadThreshold": 6000 }`,
    projectLayer: `{ "offloadThreshold": 7000 }`,
  })
  eq(r.values.offloadThreshold, 7000, "project wins the same key")
  eq(r.perKeySource.offloadThreshold, "project", "source is project")
  eq(r.values.previewLines, "50", "env-only key survives untouched")
  eq(r.perKeySource.previewLines, "env", "env-only key source is env")
  eq(r.skippedLayers.length, 0, "no layer skipped")
  console.log("1. layer order: OK (env < global < project; distinct keys independent)")
}

// ---------------------------------------------------------------------------
// 2. project layer — `.opencode/` beats the direct file
// ---------------------------------------------------------------------------
{
  const r = resolveLayeredConfig({
    env: {},
    projectLayer: [`{ "offloadThreshold": 100 }`, `{ "offloadThreshold": 200 }`],
  })
  eq(r.values.offloadThreshold, 200, ".opencode/ wins over the direct file")
  eq(r.perKeySource.offloadThreshold, "project:.opencode", "source names .opencode")
  // a key only in the direct file still applies
  const r2 = resolveLayeredConfig({
    env: {},
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
    env: {},
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
    env: {},
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
    env: { TM_OFFLOAD_THRESHOLD: "5000" },
    globalLayer: `{ "offloadThreshold": 6000 }`,
    projectLayer: `{ "offloadThreshold": "not-a-number", "previewLines": 77 }`,
  })
  eq(r.values.offloadThreshold, 6000, "bad-typed key falls to the global layer")
  eq(r.perKeySource.offloadThreshold, "global", "source is global")
  eq(r.values.previewLines, 77, "sibling key in the same layer still applies")
  // with no lower file layer it falls all the way to env
  const r2 = resolveLayeredConfig({
    env: { TM_OFFLOAD_THRESHOLD: "5000" },
    projectLayer: `{ "offloadThreshold": "bad" }`,
  })
  eq(r2.values.offloadThreshold, "5000", "bad-typed key falls to env")
  eq(r2.perKeySource.offloadThreshold, "env", "source is env")
  console.log("4. per-key type drop: OK (falls to the next layer)")
}

// ---------------------------------------------------------------------------
// 5. a red-line key in a file is ignored + reported; env/default still answers
// ---------------------------------------------------------------------------
{
  const r = resolveLayeredConfig({
    env: { TM_ENV_PROTECT: "strict" },
    projectLayer: `{ "envProtect": "off", "offloadThreshold": 7000 }`,
  })
  eq(r.values.envProtect, "strict", "red-line key keeps its env value")
  eq(r.perKeySource.envProtect, "env", "red-line source is env")
  eq(r.ignoredRedLineKeys.length, 1, "the file attempt is reported")
  eq(r.ignoredRedLineKeys[0].key, "envProtect", "reported key name")
  eq(r.ignoredRedLineKeys[0].layer, "project", "reported layer name")
  eq(r.values.offloadThreshold, 7000, "a non-red-line key in the same file applies")
  // no env value -> the red-line key is simply absent (default answers downstream)
  const r2 = resolveLayeredConfig({
    env: {},
    projectLayer: `{ "webfetchAllowedDomains": ["evil.example"] }`,
  })
  assert.ok(!("webfetchAllowedDomains" in r2.values), "red-line key never enters values")
  eq(r2.ignoredRedLineKeys[0].key, "webfetchAllowedDomains", "reported")
  console.log("5. red-line exemption: OK (ignored + reported, env/default answers)")
}

// ---------------------------------------------------------------------------
// 6. an unknown key is reported and never applied
// ---------------------------------------------------------------------------
{
  const r = resolveLayeredConfig({
    env: {},
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
// 7. TM_CONFIG_ENV_ONLY removes every file layer
// ---------------------------------------------------------------------------
{
  const r = resolveLayeredConfig({
    env: { TM_CONFIG_ENV_ONLY: "1", TM_OFFLOAD_THRESHOLD: "5000" },
    globalLayer: `{ "offloadThreshold": 6000 }`,
    projectLayer: `{ "offloadThreshold": 7000 }`,
  })
  eq(r.envOnlyActive, true, "envOnlyActive is true")
  eq(r.values.offloadThreshold, "5000", "env wins outright")
  eq(r.perKeySource.offloadThreshold, "env", "source is env")
  eq(r.skippedLayers.length, 0, "no layer is even parsed")
  eq(r.ignoredRedLineKeys.length, 0, "no file attempt is seen")
  // explicit override wins over the env value
  const r2 = resolveLayeredConfig({
    env: { TM_CONFIG_ENV_ONLY: "1" },
    projectLayer: `{ "offloadThreshold": 7000 }`,
    envOnly: false,
  })
  eq(r2.envOnlyActive, false, "explicit envOnly:false overrides the env flag")
  eq(r2.values.offloadThreshold, 7000, "file layer applies when envOnly is off")
  console.log("7. TM_CONFIG_ENV_ONLY: OK (file layers removed, flag reported)")
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
  const r = resolveLayeredConfig({ env: {}, projectLayer: src })
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
// 9. the red-line exempt table is exactly the six documented knobs
// ---------------------------------------------------------------------------
{
  const expected = [
    "envProtect",
    "r6FineAsk",
    "privateSpace",
    "webfetchAllowedDomains",
    "browserAskEval",
    "bashReadonlyAllowed",
  ]
  eq(RED_LINE_EXEMPT_KEYS.length, expected.length, "six red-line keys")
  for (const k of expected) assert.ok(RED_LINE_EXEMPT_KEYS.includes(k), `red-line table has ${k}`)
  for (const spec of CONFIG_KEYS.filter((s) => s.redLine)) {
    assert.ok(spec.redLineReason && spec.redLineReason.length > 0, `${spec.key} carries a reason`)
  }
  console.log("9. red-line table: OK (six knobs, each with a reason)")
}

console.log(`\ntest-config-layers.mjs: ALL PASS (9 groups)`)

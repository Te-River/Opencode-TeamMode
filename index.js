// The host resolves a plugin DIRECTORY as `<dir>/index.js` (measured on 2.0.16:
// `msg="loading plugin" … entrypoint=file:///…/team-mode/index.js`, while a directory that
// only declares package.json#exports is skipped with no error at all). This shim is
// therefore part of the contract, not a convenience: without it neither
// `plugins: ["…/opencode-team-mode"]` in a config nor a node_modules install under that
// key can load the plugin. The dual-personality shape itself lives in dist/index.js.
export { default } from "./dist/index.js"

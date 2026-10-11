# Prettify TS 7

**Prettified type hovers for TypeScript 7.**

[![Version](https://img.shields.io/vscode-marketplace/v/danieljs-codes.prettify-ts7)](https://marketplace.visualstudio.com/items?itemName=danieljs-codes.prettify-ts7)
[![CI](https://github.com/Danieljs-codes/prettify-ts7/actions/workflows/ci.yml/badge.svg?event=push)](https://github.com/Danieljs-codes/prettify-ts7/actions/workflows/ci.yml)
[![License](https://img.shields.io/github/license/Danieljs-codes/prettify-ts7)](./LICENSE)

> [!WARNING]
> **This code is slop.** It was written by [Claude Code](https://claude.com/claude-code). We didn't read the code at all.

A fork of [Prettify TypeScript](https://github.com/mylesmmurphy/prettify-ts) by Myles Murphy, with TypeScript 7 (`tsgo`) support added. TypeScript 7 can't load TS Server plugins, so the extension queries the running TypeScript 7 language server over its API pipe (`packages/vscode-extension/src/tsgo/`). With TypeScript 6 and earlier it uses the original plugin.

## Installation

* [Prettify TS 7 on the VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=danieljs-codes.prettify-ts7)

## Developer Notes

This README is for developing Prettify TS 7. The extension README (shown on the Marketplace) is [here](./packages/vscode-extension/README.md).


## Scripts

> **Note:** `pnpm` is required. [Install it here](https://pnpm.io/installation).

```bash
pnpm install      # Installs all dependencies
pnpm test         # Builds and runs the extension test suite (TypeScript 6 path)
pnpm test:tsgo    # Runs the hover tests against TypeScript 7, plus an LSP API pipe check
pnpm bench [name] # Benchmarks TypeScript 7 hovers; saves bench/results/<name>.json
pnpm build        # Compiles the codebase
pnpm package      # Builds + prepares the VSIX package for publishing
```

You do **not** need to build manually — `test` and `package` handles build steps automatically.


## Benchmark

`pnpm bench` runs the same path as VS Code: a `tsc --lsp` server, the API pipe, and `TsgoHoverSession`. It hovers each case in `bench/workspace/cases.ts` 20 times after 3 warmup rounds. It reports the median, p90, and min time, the API request count, and the bytes received. Each run is compared to `bench/results/baseline.json`, and it fails if any hover's output changes. `pnpm bench --breakdown <case>` lists requests by method.

- **median**: a hover right after an edit, with nothing cached
- **repeat**: hovering the same symbol again without edits
- **cold first hover**: the first hover on a fresh server

Run-to-run noise is about ±3% for warm hovers and about ±12% for cold ones.

| | baseline | now |
|---|---|---|
| DOM element (`document.createElement("div")`) | 518 ms | 80 ms |
| Overloaded function (`document.addEventListener`) | 387 ms | 20 ms |
| `window` | 177 ms | 49 ms |
| Sum of medians, 9 cases | 1119 ms | 168 ms |
| Cold first hover | 9.9 s | 0.17 s |
| Repeat hover | same as median | <0.1 ms |


## Testing

The full integration test suite lives in `test/`. For more info on the test layout, debugging instructions, and hover validation strategy, see the [Test README](./test/README.md).


## Monorepo Structure

This repo uses [pnpm workspaces](https://pnpm.io/workspaces) to manage multiple packages:

```
.
├── packages/
│   ├── typescript-plugin/     # TypeScript language service plugin
│   └── vscode-extension/      # VSCode extension host + UI
│       └── src/tsgo/          # TypeScript 7 backend (API pipe client + type tree port)
└── test/                      # Full integration test suite
    └── tsgo/                  # TypeScript 7 tests, run outside VS Code
└── scripts/                   # Utility scripts for development, building, or CI
```


### Development Workflow

During development, pnpm automatically symlinks the plugin into the extension’s `node_modules` for live debugging.


### Packaging Workflow

To prepare for publishing:

1. **Prepackage:**

   * Copies actual plugin files into the extension
   * Rewrites `workspace:*` to `*` for `vsce` compatibility

2. **Package:**

   * Runs `vsce package` to produce `.vsix`

3. **Postpackage:**

   * Reverts everything back for dev (restores `workspace:*` and symlinks)


## VSCode Debug Configs

Defined in `.vscode/launch.json`:

* **Run Extension**: Launches VSCode with the extension loaded for manual debugging
* **Attach to TSServer**: Debug the TypeScript language service plugin

Use the VSCode Run panel (Ctrl+Shift+D / Cmd+Shift+D) to start these sessions.

## License

[MIT](./LICENSE)

Happy coding! 🎉

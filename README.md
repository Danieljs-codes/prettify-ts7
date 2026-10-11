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
pnpm build        # Compiles the codebase
pnpm package      # Builds + prepares the VSIX package for publishing
```

You do **not** need to build manually — `test` and `package` handles build steps automatically.


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

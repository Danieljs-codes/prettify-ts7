// Bundles the tsgo test harness and benchmark next to the extension's node_modules so `tsgo-api` resolves.
import * as esbuild from "esbuild";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const extensionDir = path.join(root, "packages/vscode-extension");

await esbuild.build({
  entryPoints: {
    "run-type-tests": path.join(root, "test/tsgo/run-type-tests.ts"),
    "run-lsp-pipe-test": path.join(root, "test/tsgo/run-lsp-pipe-test.ts"),
    bench: path.join(root, "bench/run.ts"),
  },
  outdir: path.join(extensionDir, "out-tsgo-test"),
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  format: "esm",
  external: ["tsgo-api"],
  nodePaths: [path.join(extensionDir, "node_modules")],
  target: "node20",
  logLevel: "warning",
});

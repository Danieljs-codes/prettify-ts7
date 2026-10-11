// Bundles the tsgo test harness next to the extension's node_modules so `tsgo-api` resolves.
import * as esbuild from "esbuild";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const extensionDir = path.join(root, "packages/vscode-extension");

await esbuild.build({
  entryPoints: ["run-type-tests", "run-lsp-pipe-test"].map((name) => path.join(root, `test/tsgo/${name}.ts`)),
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

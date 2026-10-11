/**
 * End-to-end check of the path the extension uses in VS Code: start `tsc --lsp`, open a
 * document with unsaved edits over LSP, then attach to the server's API pipe
 * (custom/initializeAPISession) and prettify a type that only exists in the unsaved text.
 *
 * Usage: pnpm test:tsgo
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { TsgoHoverSession } from "../../packages/vscode-extension/src/tsgo/hover-session";
import { prettyPrintTypeString, stringifyTypeTree } from "../../packages/vscode-extension/src/stringify-type-tree";
import { startLspServer } from "./lsp-server";

const workspaceDir = path.resolve("test/workspace");
const fileName = path.join(workspaceDir, "types.ts");

async function main(): Promise<void> {
  const server = await startLspServer(workspaceDir);
  try {
    const unsavedText = fs.readFileSync(fileName, "utf8") + "\ntype UnsavedOnly = { fresh: { deep: true } };\n";
    const uri = server.openDocument(fileName, unsavedText);
    const session = new TsgoHoverSession(await server.connectApi());

    const info = await session.getTypeInfo(uri, unsavedText.indexOf("UnsavedOnly") + 1, {
      hidePrivateProperties: true,
      maxDepth: 2,
      maxProperties: 100,
      maxSubProperties: 5,
      maxUnionMembers: 15,
      maxFunctionSignatures: 5,
      skippedTypeNames: [],
      unwrapArrays: true,
      unwrapFunctions: true,
      unwrapGenericArgumentsTypeNames: [],
    });

    const actual = info
      ? (info.declaration + prettyPrintTypeString(stringifyTypeTree(info.typeTree, false), 4))
          .replace(/\s+/g, " ")
          .trim()
      : "<no type info>";
    const expected = "type UnsavedOnly = { fresh: { deep: true; }; }";

    console.log(
      actual === expected
        ? `  ✓ LSP pipe + unsaved document: ${actual}`
        : `  ✗ expected ${expected}\n    actual   ${actual}`,
    );
    process.exitCode = actual === expected ? 0 : 1;

    await session.api.close();
  } finally {
    server.stop();
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => process.exit());

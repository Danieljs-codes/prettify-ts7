/**
 * End-to-end check of the path the extension uses in VS Code: start `tsc --lsp`, open a
 * document with unsaved edits over LSP, then attach to the server's API pipe
 * (custom/initializeAPISession) and prettify a type that only exists in the unsaved text.
 *
 * Usage: pnpm test:tsgo
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { API } from "tsgo-api/unstable/async";

import { getTypeInfoAtPosition } from "../../packages/vscode-extension/src/tsgo/type-tree";
import { prettyPrintTypeString, stringifyTypeTree } from "../../packages/vscode-extension/src/stringify-type-tree";

const workspaceDir = path.resolve("test/workspace");
const fileName = path.join(workspaceDir, "types.ts");
const uri = pathToFileURL(fileName).toString();

// getExePath isn't in the package's exports, so load it by file path
const tsgoPackageDir = path.dirname(createRequire(import.meta.url).resolve("tsgo-api/package.json"));
const { default: getExePath } = (await import(pathToFileURL(path.join(tsgoPackageDir, "lib/getExePath.js")).href)) as {
  default: () => string;
};

const server = spawn(getExePath(), ["--lsp", "--stdio"], { cwd: workspaceDir, stdio: ["pipe", "pipe", "inherit"] });

let nextId = 1;
const pending = new Map<number, (result: unknown) => void>();
let buffer = Buffer.alloc(0);

server.stdout.on("data", (chunk: Buffer) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) return;
    const length = Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0, headerEnd).toString())?.[1]);
    if (buffer.length < headerEnd + 4 + length) return;
    const message = JSON.parse(buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString());
    buffer = buffer.subarray(headerEnd + 4 + length);

    if (message.id !== undefined && message.method) {
      // Server-to-client request (e.g. client/registerCapability): acknowledge it
      send({ jsonrpc: "2.0", id: message.id, result: null });
    } else if (message.id !== undefined) {
      pending.get(message.id)?.(message.result ?? message.error);
      pending.delete(message.id);
    }
  }
});

function send(message: object): void {
  const body = JSON.stringify(message);
  server.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}

function request<T>(method: string, params: unknown): Promise<T> {
  const id = nextId++;
  send({ jsonrpc: "2.0", id, method, params });
  return new Promise((resolve) => pending.set(id, resolve as (result: unknown) => void));
}

async function main(): Promise<void> {
  await request("initialize", {
    processId: process.pid,
    rootUri: pathToFileURL(workspaceDir).toString(),
    capabilities: {},
    workspaceFolders: [{ uri: pathToFileURL(workspaceDir).toString(), name: "workspace" }],
  });
  send({ jsonrpc: "2.0", method: "initialized", params: {} });

  const unsavedText = fs.readFileSync(fileName, "utf8") + "\ntype UnsavedOnly = { fresh: { deep: true } };\n";
  send({
    jsonrpc: "2.0",
    method: "textDocument/didOpen",
    params: { textDocument: { uri, languageId: "typescript", version: 1, text: unsavedText } },
  });

  const { pipe } = await request<{ pipe: string }>("custom/initializeAPISession", {});
  const api = await API.fromLSPConnection({ pipe });

  const snapshot = await api.updateSnapshot();
  const project = await snapshot.getDefaultProjectForFile({ uri });
  const sourceFile = await project?.program.getSourceFile({ uri });
  if (!project || !sourceFile) throw new Error("LSP snapshot has no project for the open document");

  const info = await getTypeInfoAtPosition(project, sourceFile, unsavedText.indexOf("UnsavedOnly") + 1, {
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
    ? (info.declaration + prettyPrintTypeString(stringifyTypeTree(info.typeTree, false), 4)).replace(/\s+/g, " ").trim()
    : "<no type info>";
  const expected = "type UnsavedOnly = { fresh: { deep: true; }; }";

  console.log(actual === expected ? `  ✓ LSP pipe + unsaved document: ${actual}` : `  ✗ expected ${expected}\n    actual   ${actual}`);
  process.exitCode = actual === expected ? 0 : 1;

  await snapshot.dispose();
  await api.close();
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    server.kill();
    process.exit();
  });

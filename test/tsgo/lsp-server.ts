/**
 * Minimal LSP client for `tsc --lsp`, standing in for the TypeScript 7 VS Code extension:
 * starts the server, opens documents, and hands out an API pipe (custom/initializeAPISession).
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { API } from "tsgo-api/unstable/async";

export type LspServer = {
  openDocument(fileName: string, text: string): string;
  connectApi(): Promise<API<true>>;
  stop(): void;
};

async function getTsgoExePath(): Promise<string> {
  // getExePath isn't in the package's exports, so load it by file path
  const tsgoPackageDir = path.dirname(createRequire(import.meta.url).resolve("tsgo-api/package.json"));
  const { default: getExePath } = (await import(
    pathToFileURL(path.join(tsgoPackageDir, "lib/getExePath.js")).href
  )) as {
    default: () => string;
  };
  return getExePath();
}

export async function startLspServer(workspaceDir: string): Promise<LspServer> {
  const server: ChildProcessWithoutNullStreams = spawn(await getTsgoExePath(), ["--lsp", "--stdio"], {
    cwd: workspaceDir,
  });
  server.stderr.resume();

  let nextId = 1;
  const pending = new Map<number, (result: unknown) => void>();
  let buffer = Buffer.alloc(0);

  function send(message: object): void {
    const body = JSON.stringify(message);
    server.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  }

  function request<T>(method: string, params: unknown): Promise<T> {
    const id = nextId++;
    send({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve) => pending.set(id, resolve as (result: unknown) => void));
  }

  server.stdout.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      const length = Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0, headerEnd).toString())?.[1]);
      if (buffer.length < headerEnd + 4 + length) return;
      const message = JSON.parse(buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString()) as {
        id?: number;
        method?: string;
        result?: unknown;
        error?: unknown;
      };
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

  const rootUri = pathToFileURL(workspaceDir).toString();
  await request("initialize", {
    processId: process.pid,
    rootUri,
    capabilities: {},
    workspaceFolders: [{ uri: rootUri, name: "workspace" }],
  });
  send({ jsonrpc: "2.0", method: "initialized", params: {} });

  return {
    openDocument(fileName, text) {
      const uri = pathToFileURL(fileName).toString();
      send({
        jsonrpc: "2.0",
        method: "textDocument/didOpen",
        params: { textDocument: { uri, languageId: "typescript", version: 1, text } },
      });
      return uri;
    },
    async connectApi() {
      const { pipe } = await request<{ pipe: string }>("custom/initializeAPISession", {});
      return API.fromLSPConnection({ pipe });
    },
    stop() {
      server.kill();
    },
  };
}

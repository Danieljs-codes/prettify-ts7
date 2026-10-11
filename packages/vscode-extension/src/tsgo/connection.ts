import * as vscode from "vscode";
import { API } from "tsgo-api/unstable/async";

import { TsgoHoverSession } from "./hover-session";

/** The TypeScript 7 VS Code extension ("TypeScript (Native Preview)") */
const TSGO_EXTENSION_ID = "TypeScriptTeam.native-preview";

/** The API exported by the TypeScript 7 VS Code extension's `activate` */
type TsgoExtensionApi = {
  onLanguageServerInitialized(listener: () => unknown): vscode.Disposable;
  initializeAPIConnection(pipe?: string): Promise<string>;
};

let sessionPromise: Promise<TsgoHoverSession> | undefined;
let listeningForRestarts = false;

export const tsgoOutputChannel = vscode.window.createOutputChannel("Prettify TS 7");

/**
 * Whether TypeScript 7 is handling TS/JS files, based on the TS 7 extension's setting
 */
export function isTsgoEnabled(): boolean {
  if (!vscode.extensions.getExtension(TSGO_EXTENSION_ID)) return false;

  const useTsgo =
    vscode.workspace.getConfiguration("js/ts").get<boolean>("experimental.useTsgo") ??
    vscode.workspace.getConfiguration("typescript").get<boolean>("experimental.useTsgo");

  return useTsgo === true;
}

async function getTsgoExtensionApi(): Promise<TsgoExtensionApi | undefined> {
  const extension = vscode.extensions.getExtension<TsgoExtensionApi | undefined>(TSGO_EXTENSION_ID);
  if (!extension) return undefined;

  const exports = extension.isActive ? extension.exports : await extension.activate();
  if (!exports || typeof exports.initializeAPIConnection !== "function") return undefined;

  return exports;
}

/**
 * Connects to the running TypeScript 7 language server's API pipe, reusing the connection
 * until the server restarts
 */
export async function getTsgoSession(): Promise<TsgoHoverSession | undefined> {
  const extensionApi = await getTsgoExtensionApi();
  if (!extensionApi) return undefined;

  if (!listeningForRestarts) {
    listeningForRestarts = true;
    extensionApi.onLanguageServerInitialized(() => resetTsgoApi());
  }

  sessionPromise ??= (async () => {
    const pipe = await extensionApi.initializeAPIConnection();
    tsgoOutputChannel.appendLine(`Connected to TypeScript 7 API at ${pipe}`);
    return new TsgoHoverSession(await API.fromLSPConnection({ pipe }));
  })();

  try {
    return await sessionPromise;
  } catch (error) {
    sessionPromise = undefined;
    throw error;
  }
}

/**
 * Drops the current connection so the next request reconnects
 */
export function resetTsgoApi(): void {
  const previous = sessionPromise;
  sessionPromise = undefined;
  void previous?.then((session) => session.api.close()).catch(() => undefined);
}

/** Document schemes whose edits can change types (not output channels, settings UIs, etc.) */
const sourceSchemes = new Set(["file", "untitled", "vscode-vfs", "vscode-remote"]);

/**
 * Marks cached TypeScript 7 results stale whenever anything that could change types does:
 * editor edits, saves, and file creates/deletes/changes on disk (e.g. git checkout, npm install)
 */
export function registerTsgoInvalidation(context: vscode.ExtensionContext): void {
  const markStale = () => void sessionPromise?.then((session) => session.markStale()).catch(() => undefined);

  const watcher = vscode.workspace.createFileSystemWatcher("**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs,json}");

  context.subscriptions.push(
    watcher,
    watcher.onDidChange(markStale),
    watcher.onDidCreate(markStale),
    watcher.onDidDelete(markStale),
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.contentChanges.length > 0 && sourceSchemes.has(event.document.uri.scheme)) markStale();
    }),
    vscode.workspace.onDidSaveTextDocument(markStale),
    vscode.workspace.onDidOpenTextDocument(markStale),
    vscode.workspace.onDidCloseTextDocument(markStale),
    vscode.workspace.onDidCreateFiles(markStale),
    vscode.workspace.onDidDeleteFiles(markStale),
    vscode.workspace.onDidRenameFiles(markStale),
  );
}

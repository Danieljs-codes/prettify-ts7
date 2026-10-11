import * as vscode from "vscode";
import { API } from "tsgo-api/unstable/async";

/** The TypeScript 7 VS Code extension ("TypeScript (Native Preview)") */
const TSGO_EXTENSION_ID = "TypeScriptTeam.native-preview";

/** The API exported by the TypeScript 7 VS Code extension's `activate` */
type TsgoExtensionApi = {
  onLanguageServerInitialized(listener: () => unknown): vscode.Disposable;
  initializeAPIConnection(pipe?: string): Promise<string>;
};

let apiPromise: Promise<API<true>> | undefined;
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
export async function getTsgoApi(): Promise<API<true> | undefined> {
  const extensionApi = await getTsgoExtensionApi();
  if (!extensionApi) return undefined;

  if (!listeningForRestarts) {
    listeningForRestarts = true;
    extensionApi.onLanguageServerInitialized(() => resetTsgoApi());
  }

  apiPromise ??= (async () => {
    const pipe = await extensionApi.initializeAPIConnection();
    tsgoOutputChannel.appendLine(`Connected to TypeScript 7 API at ${pipe}`);
    return API.fromLSPConnection({ pipe });
  })();

  try {
    return await apiPromise;
  } catch (error) {
    apiPromise = undefined;
    throw error;
  }
}

/**
 * Drops the current connection so the next request reconnects
 */
export function resetTsgoApi(): void {
  const previous = apiPromise;
  apiPromise = undefined;
  void previous?.then((api) => api.close()).catch(() => undefined);
}

import type * as vscode from "vscode";
import { registerHoverProvider } from "./hover-provider";
import { registerCommands } from "./commands-provider";
import { onTsgoServerInitialized, registerTsgoInvalidation, tsgoOutputChannel } from "./tsgo/connection";

export function activate(context: vscode.ExtensionContext): void {
  const reregisterHoverProvider = registerHoverProvider(context);
  registerCommands(context);
  registerTsgoInvalidation(context);

  // The TS 7 extension registers its hover when its server starts, after ours, which would
  // put TypeScript's hover first
  onTsgoServerInitialized(context, reregisterHoverProvider).catch((error: unknown) =>
    tsgoOutputChannel.appendLine(`Couldn't watch the TypeScript 7 server: ${String(error)}`),
  );
}

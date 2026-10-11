import type * as vscode from "vscode";
import { registerHoverProvider } from "./hover-provider";
import { registerCommands } from "./commands-provider";
import { registerTsgoInvalidation } from "./tsgo/connection";

export function activate(context: vscode.ExtensionContext): void {
  registerHoverProvider(context);
  registerCommands(context);
  registerTsgoInvalidation(context);
}

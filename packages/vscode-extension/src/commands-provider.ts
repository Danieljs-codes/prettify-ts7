import * as vscode from "vscode";
import { stringifyTypeTree, prettyPrintTypeString, type ReadonlyStyle } from "./stringify-type-tree";
import { getPrettifyOptions, getTypeInfo } from "./type-info";

// MAX_SETTINGS is an extremely high constant used to represent "unlimited" or "maximum possible" settings.
// It is intended for advanced scenarios (e.g., full type tree processing) and may have performance implications.
const MAX_SETTINGS = 999999999999;

export function registerCommands(context: vscode.ExtensionContext): void {
  const toggleCommand = vscode.commands.registerCommand("prettify-ts7.toggle", async (option?: boolean) => {
    const config = vscode.workspace.getConfiguration("prettify-ts7");
    if (option === true || option === false) {
      await config.update("enabled", option, vscode.ConfigurationTarget.Global);
      return;
    }

    await config.update("enabled", !config.get("enabled", true), vscode.ConfigurationTarget.Global);
  });

  async function copyType(full = false): Promise<void> {
    const config = vscode.workspace.getConfiguration("prettify-ts7");
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;

    const indentation = config.get("typeIndentation", 4);
    const options = getPrettifyOptions(config);

    if (full) {
      options.maxDepth = MAX_SETTINGS;
      options.maxProperties = MAX_SETTINGS;
      options.maxSubProperties = MAX_SETTINGS;
      options.maxUnionMembers = MAX_SETTINGS;
      options.maxFunctionSignatures = MAX_SETTINGS;
      options.unwrapArrays = true;
      options.unwrapFunctions = true;
    }

    const prettifyResponse = await getTypeInfo(editor.document, editor.selection.active, options);
    if (!prettifyResponse || !prettifyResponse.typeTree) {
      await vscode.window.showErrorMessage("No type information found at cursor position");
      return;
    }

    const { typeTree, declaration } = prettifyResponse;

    const typeString = stringifyTypeTree(typeTree, false, config.get<ReadonlyStyle>("readonlyStyle", "keyword"));
    const prettyTypeString = prettyPrintTypeString(typeString, indentation);

    await vscode.env.clipboard.writeText(declaration + prettyTypeString);
    await vscode.window.showInformationMessage("Type copied to clipboard");
  }

  const copyFunction = async () =>
    await copyType().catch(() => vscode.window.showErrorMessage("Failed to copy prettified type"));

  const fullCopyFunction = async () =>
    await copyType(true).catch(() => vscode.window.showErrorMessage("Failed to copy fully prettified type"));

  const copyCommand = vscode.commands.registerCommand("prettify-ts7.copyPrettifiedType", copyFunction);
  const fullCopyCommand = vscode.commands.registerCommand("prettify-ts7.fullCopyPrettifiedType", fullCopyFunction);

  context.subscriptions.push(toggleCommand);
  context.subscriptions.push(copyCommand);
  context.subscriptions.push(fullCopyCommand);
}

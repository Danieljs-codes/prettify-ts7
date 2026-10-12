import * as vscode from "vscode";
import { prettyPrintTypeString, stringifyTypeTree, sanitizeString } from "./stringify-type-tree";
import { getPrettifyOptions, getTypeInfo } from "./type-info";

const MAX_READABLE_QUICK_INFO_LENGTH = 100;

export function registerHoverProvider(context: vscode.ExtensionContext): void {
  async function provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): Promise<vscode.Hover | undefined> {
    const config = vscode.workspace.getConfiguration("prettify-ts7");
    if (!config.get("enabled", true)) return;

    const indentation = config.get("typeIndentation", 4);
    const maxCharacters = config.get("maxCharacters", 20000);

    const options = getPrettifyOptions(config);

    const prettifyResponse = await getTypeInfo(document, position, options);
    if (!prettifyResponse) return;

    const { typeTree, name } = prettifyResponse;

    let declaration = prettifyResponse.declaration;

    if (options.skippedTypeNames.includes(name)) return;

    const typeString = stringifyTypeTree(typeTree, false);
    let prettyTypeString = prettyPrintTypeString(typeString, indentation);

    if (prettyTypeString.length > maxCharacters) {
      prettyTypeString = prettyTypeString.substring(0, maxCharacters) + "...";
    }

    if (declaration.startsWith("function") && prettyTypeString.startsWith("{")) {
      declaration += " ";
    }

    // Ignore hover if the type is already displayed from TS quick info
    if (
      declaration.startsWith("type") ||
      declaration.startsWith("const") ||
      declaration.startsWith("let") ||
      declaration.startsWith("var") ||
      declaration.startsWith("function")
    ) {
      const quickInfoDisplayString = (await prettifyResponse.getQuickInfoText()) ?? "";

      const washedQuickInfo = sanitizeString(quickInfoDisplayString);
      const washedType = sanitizeString(typeString.replace(/ } & { /g, " "));

      // Same content is still worth showing when TS renders it as one hard-to-read line
      const quickInfoIsLongLine =
        !quickInfoDisplayString.includes("\n") && quickInfoDisplayString.length > MAX_READABLE_QUICK_INFO_LENGTH;
      const prettifiedIsMultiline = prettyTypeString.trim().includes("\n");

      if (washedQuickInfo.includes(washedType) && !(quickInfoIsLongLine && prettifiedIsMultiline)) return;
    }

    const hoverText = new vscode.MarkdownString();
    hoverText.appendCodeblock(declaration + prettyTypeString, "typescript");
    return new vscode.Hover(hoverText);
  }

  context.subscriptions.push(vscode.languages.registerHoverProvider("typescript", { provideHover }));
  context.subscriptions.push(vscode.languages.registerHoverProvider("typescriptreact", { provideHover }));
  context.subscriptions.push(vscode.languages.registerHoverProvider("vue", { provideHover }));
}

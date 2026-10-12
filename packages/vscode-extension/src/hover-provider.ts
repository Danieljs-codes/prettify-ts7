import * as vscode from "vscode";
import { prettyPrintTypeString, stringifyTypeTree, sanitizeString, type ReadonlyStyle } from "./stringify-type-tree";
import { getPrettifyOptions, getTypeInfo } from "./type-info";

const MAX_READABLE_QUICK_INFO_LENGTH = 100;

/**
 * Registers the hover provider. Returns a function that registers it again, which moves
 * Prettify's hover above other providers': VS Code shows equally specific providers
 * newest first.
 */
export function registerHoverProvider(context: vscode.ExtensionContext): () => void {
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

    const typeString = stringifyTypeTree(typeTree, false, config.get<ReadonlyStyle>("readonlyStyle", "keyword"));
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

  let registrations: vscode.Disposable[] = [];
  const unregister = () => {
    for (const registration of registrations) registration.dispose();
  };
  context.subscriptions.push({ dispose: unregister });

  const register = () => {
    unregister();
    registrations = ["typescript", "typescriptreact", "vue"].map((language) =>
      vscode.languages.registerHoverProvider(language, { provideHover }),
    );
  };

  register();
  return register;
}

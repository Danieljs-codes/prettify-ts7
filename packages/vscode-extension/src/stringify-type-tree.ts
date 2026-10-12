import type { TypeTree } from "@prettify-ts7/typescript-plugin/src/type-tree/types";

/**
 * Regular expression to validate an object key that does not require quotes.
 * Includes dynamic keys wrapped in square brackets (e.g., [dynamicKey]).
 */
const unquotedObjectKeyRegex = /^(?:\d+|[a-zA-Z_$][\w$]*|\[.*\])$/;

/**
 * Markers for a parameter list that prettyPrintTypeString should put one parameter per line.
 * Control characters can't appear in type text, and are stripped when not pretty printing.
 */
const PARAMS_OPEN = "\u0001";
const PARAMS_SEPARATOR = "\u0002";
const PARAMS_CLOSE = "\u0003";

/** Parameter lists longer than this, or mixing an object with other parameters, go one per line */
const MAX_INLINE_PARAMETERS_LENGTH = 60;

export function stripLayoutMarkers(typeString: string): string {
  return typeString.split(PARAMS_OPEN).join("").split(PARAMS_SEPARATOR).join(", ").split(PARAMS_CLOSE).join("");
}

/**
 * Uses type info to return a string representation of the type
 *
 * Example:
 * { kind: 'union', types: [{ kind: 'primitive', type: 'string' }, { kind: 'primitive', type: 'number' }] }
 * Yields:
 * 'string | number'
 */
/**
 * How readonly arrays and tuples are written:
 * "keyword" is `readonly T[]` / `readonly [A, B]`, "generic" is `ReadonlyArray<T>` / `Readonly<[A, B]>`
 */
export type ReadonlyStyle = "keyword" | "generic";

export function stringifyTypeTree(
  typeTree: TypeTree,
  anonymousFunction = true,
  readonlyStyle: ReadonlyStyle = "keyword",
): string {
  if (typeTree.kind === "union") {
    const unionString = typeTree.types.map((t) => stringifyTypeTree(t, true, readonlyStyle)).join(" | ");

    if (typeTree.excessMembers > 0) {
      return `${unionString} | ... ${typeTree.excessMembers} more`;
    }

    return unionString;
  }

  if (typeTree.kind === "object") {
    const propertiesArray = typeTree.properties.map((p) => {
      const readonly = p.readonly ? "readonly " : "";

      let optional = "";
      if (p.optional && p.type.kind === "union") {
        optional = "?";
        // Remove undefined from union if optional
        p.type.types = p.type.types.filter((t) => t.typeName !== "undefined");
      }

      // If the name has invalid characters, wrap it in quotes
      let name = p.name;
      if (!unquotedObjectKeyRegex.test(p.name)) {
        name = `"${p.name}"`;
      }

      return `${readonly}${name}${optional}: ${stringifyTypeTree(p.type, true, readonlyStyle)};`;
    });

    let propertiesString = propertiesArray.join(" ");

    if (typeTree.excessProperties > 0) {
      propertiesString += ` ... ${typeTree.excessProperties} more;`;
    }

    return `{ ${propertiesString} }`;
  }

  if (typeTree.kind === "tuple") {
    const elementTypesString = typeTree.elementTypes.map((t) => stringifyTypeTree(t, true, readonlyStyle)).join(", ");

    if (typeTree.readonly && readonlyStyle === "generic") return `Readonly<[${elementTypesString}]>`;
    return `${typeTree.readonly ? "readonly " : ""}[${elementTypesString}]`;
  }

  if (typeTree.kind === "array") {
    let elementTypeString = stringifyTypeTree(typeTree.elementType, true, readonlyStyle);
    if (typeTree.readonly && readonlyStyle === "generic") return `ReadonlyArray<${elementTypeString}>`;

    if (
      elementTypeString.includes("|") ||
      elementTypeString.includes("&") ||
      elementTypeString.startsWith("readonly ") ||
      elementTypeString.includes("=>")
    ) {
      elementTypeString = `(${elementTypeString})`;
    }

    return `${typeTree.readonly ? "readonly " : ""}${elementTypeString}[]`;
  }

  if (typeTree.kind === "function") {
    const returnTypeChar = anonymousFunction ? " =>" : ":";

    const signatures = typeTree.signatures.map((s) => {
      const { parameters, returnType } = s;
      const parametersArray = parameters.map((p) => {
        const rest = p.isRestParameter ? "..." : "";

        let optional = "";
        if (p.optional && p.type.kind === "union") {
          optional = "?";
          // Remove undefined from union if optional
          p.type.types = p.type.types.filter((t) => t.typeName !== "undefined");
        }

        return `${rest}${p.name}${optional}: ${stringifyTypeTree(p.type, true, readonlyStyle)}`;
      });

      const parametersString = parametersArray.join(", ");
      const hasObjectParameter = parametersArray.some((p) => p.includes("{"));
      const breakParameters =
        parametersArray.length > 0 &&
        (stripLayoutMarkers(parametersString).length > MAX_INLINE_PARAMETERS_LENGTH ||
          (parametersArray.length > 1 && hasObjectParameter));

      const parametersBlock = breakParameters
        ? `${PARAMS_OPEN}${parametersArray.join(PARAMS_SEPARATOR)}${PARAMS_CLOSE}`
        : parametersString;

      return `(${parametersBlock})${returnTypeChar} ${stringifyTypeTree(returnType, true, readonlyStyle)}`;
    });

    // If there are multiple signatures, wrap them in braces with semi-colons at the end of each line
    if (signatures.length > 1) {
      let signaturesString = `{${signatures.join("; ")};`;
      if (typeTree.excessSignatures > 0) {
        signaturesString += ` ... ${typeTree.excessSignatures} more;`;
      }
      signaturesString += "}";

      return signaturesString;
    }

    return signatures[0] ?? "";
  }

  if (typeTree.kind === "enum") {
    return typeTree.member;
  }

  if (typeTree.kind === "generic") {
    const argumentsString = typeTree.arguments.map((arg) => stringifyTypeTree(arg, true, readonlyStyle)).join(", ");
    return `${typeTree.typeName}<${argumentsString}>`;
  }

  // Primitive or reference type: the checker's own text, which can contain readonly arrays
  // and tuples, e.g. `Iterable<readonly [id: number, name: string]>`
  return readonlyStyle === "generic" ? toGenericReadonly(typeTree.typeName) : typeTree.typeName;
}

/**
 * Rewrites `readonly [A, B]` to `Readonly<[A, B]>` and `readonly T[]` (for a plain type name T)
 * to `ReadonlyArray<T>` in type text. Leaves `readonly` property modifiers and index
 * signatures (`readonly [key: string]: T`) alone.
 */
export function toGenericReadonly(text: string): string {
  let result = "";
  let index = 0;

  while (index < text.length) {
    const tupleStart = text.indexOf("readonly [", index);
    if (tupleStart === -1) break;

    const open = tupleStart + "readonly ".length;
    const close = findClosingBracket(text, open);
    const after = text[close + 1];
    const isIndexSignature = after === ":" || (after === "?" && text[close + 2] === ":");

    if (close === -1 || isIndexSignature) {
      result += text.slice(index, open + 1);
      index = open + 1;
      continue;
    }

    result += `${text.slice(index, tupleStart)}Readonly<${toGenericReadonly(text.slice(open, close + 1))}>`;
    index = close + 1;
  }

  result += text.slice(index);
  return rewriteParenthesizedReadonlyArrays(result).replace(/\breadonly ([A-Za-z_$][\w$.]*)\[\]/g, "ReadonlyArray<$1>");
}

/** `readonly (A | B)[]` to `ReadonlyArray<A | B>` */
function rewriteParenthesizedReadonlyArrays(text: string): string {
  const start = text.indexOf("readonly (");
  if (start === -1) return text;

  const open = start + "readonly ".length;
  const close = findClosingBracket(text, open, "(", ")");
  if (close === -1 || text.slice(close + 1, close + 3) !== "[]") {
    return text.slice(0, open + 1) + rewriteParenthesizedReadonlyArrays(text.slice(open + 1));
  }

  const inner = text.slice(open + 1, close);
  return (
    `${text.slice(0, start)}ReadonlyArray<${rewriteParenthesizedReadonlyArrays(inner)}>` +
    rewriteParenthesizedReadonlyArrays(text.slice(close + 3))
  );
}

function findClosingBracket(text: string, open: number, opening = "[", closing = "]"): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === opening) depth++;
    else if (text[i] === closing && --depth === 0) return i;
  }
  return -1;
}

export function prettyPrintTypeString(typeStringInput: string, indentation = 2): string {
  // Replace typeof import("...node_modules/MODULE_NAME") with: typeof import("MODULE_NAME")
  const typeString = typeStringInput
    .replace(/typeof import\(".*?node_modules\/(.*?)"\)/g, 'typeof import("$1")')
    .replace(/ } & { /g, " ");

  if (indentation < 1) return stripLayoutMarkers(typeString);

  // Add newline after braces and semicolons, and around broken-up parameter lists.
  // Parameter list lines keep their marker so the loop below can indent them.
  const splitTypeString = typeString
    .replace(/{/g, "{\n")
    .replace(/}/g, "\n}")
    .replace(/(\S); /g, "$1;\n ")
    .split(PARAMS_OPEN)
    .join(`${PARAMS_OPEN}\n`)
    .split(PARAMS_SEPARATOR)
    .join(`,\n`)
    .split(PARAMS_CLOSE)
    .join(`\n${PARAMS_CLOSE}`);

  let depth = 0;
  let result = "";

  const lines = splitTypeString.split("\n");

  for (let line of lines) {
    line = line.trim();

    // Replace true/false with boolean
    line = line.replace("false | true", "boolean");

    const opens = line.endsWith("{") || line.endsWith(PARAMS_OPEN);
    const closes = line.startsWith("}") || line.startsWith(PARAMS_CLOSE);

    if (closes) {
      depth--;
    }

    result += " ".repeat(indentation).repeat(Math.max(0, depth)) + stripLayoutMarkers(line) + "\n";

    if (opens) {
      depth++;
    }
  }

  result = result
    .replace(/{\s*\n*\s*}/g, "{}") // Remove empty braces newlines
    .replace(/^\s*[\r\n]/gm, "") // Remove empty newlines
    .replace(/{\s*\.\.\.\s*([0-9]+)\s*more;\s*}/g, "{ ... $1 more }") // Replace only excess properties into one line
    .replace(/\$\{\s*([^{}]+?)\s*\}/g, (_, inner) => `\${${inner}}`); // Remove unnecessary spaces in template literals

  return result;
}

/**
 * Sanitizes a string by removing leading words, whitespace, newlines, and semicolons
 */
export function sanitizeString(str: string): string {
  return stripLayoutMarkers(str)
    .replace(/^[a-z]+\s/, "") // Remove the leading word, ex: type, const, interface
    .replace(/\s/g, "") // Remove all whitespace
    .replace(/\n/g, "") // Remove all newlines
    .replace(/;/g, "") // Remove all semicolons
    .replace(/\b[a-zA-Z_][a-zA-Z0-9_]*\./g, ""); // Remove namespaces (e.g., z.)
}

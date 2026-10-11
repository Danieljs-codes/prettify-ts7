/**
 * TypeScript 7 (tsgo) port of `@prettify-ts7/typescript-plugin/src/type-tree`.
 *
 * TypeScript 7 can't load TS Server plugins, so this runs in the extension host and
 * queries the language server's checker over the TS 7 API pipe instead. Every checker
 * call is a round trip, so the logic mirrors the plugin but is async.
 */
import type { Checker, Project, Signature, Symbol, Type, TypeReference } from "tsgo-api/unstable/async";
import {
  ElementFlags,
  ModifierFlags,
  ObjectFlags,
  SignatureKind,
  SymbolFlags,
  TypeFlags,
} from "tsgo-api/unstable/async";
import type { Node, SourceFile } from "tsgo-api/unstable/ast";
import {
  NodeFlags,
  SyntaxKind,
  getTouchingPropertyName,
  isClassDeclaration,
  isImportClause,
  isImportDeclaration,
  isImportSpecifier,
  isParameterDeclaration,
  isPropertyDeclaration,
  isPropertySignatureDeclaration,
  isVariableDeclaration,
  isVariableDeclarationList,
} from "tsgo-api/unstable/ast";

import type { PrettifyOptions } from "@prettify-ts7/typescript-plugin/src/request";
import type {
  TypeFunctionSignature,
  TypeInfo,
  TypeProperty,
  TypeTree,
} from "@prettify-ts7/typescript-plugin/src/type-tree/types";

/** `TypeFormatFlags.NoTruncation` (TypeFormatFlags aren't exported by the TS 7 API) */
const NoTruncation = 1;

/** `TypeFormatFlags.InTypeAlias`, renders the type itself instead of its alias name */
const InTypeAlias = 1 << 23;

/** `CheckFlags.Readonly`, set on mapped/synthetic readonly properties */
const CheckFlagsReadonly = 1 << 3;

type DeclarationHandle = NonNullable<Symbol["valueDeclaration"]>;

/**
 * Checker queries memoized for one hover. Large types repeat the same member types many
 * times (e.g. every `on*` handler on a DOM element), and each query is a round trip.
 * Keyed by object id, which is stable within a snapshot.
 */
class CachedChecker {
  private readonly cache = new Map<string, Promise<unknown>>();

  constructor(readonly checker: Checker) {}

  private memo<T>(key: string, query: () => Promise<T>): Promise<T> {
    let result = this.cache.get(key) as Promise<T> | undefined;
    if (!result) {
      result = query();
      this.cache.set(key, result);
    }
    return result;
  }

  typeToString(type: Type, flags = 0): Promise<string> {
    return this.memo(`typeToString:${type.id}:${flags}`, () => this.checker.typeToString(type, undefined, flags));
  }
  getApparentType(type: Type): Promise<Type | undefined> {
    return this.memo(`apparent:${type.id}`, () => this.checker.getApparentType(type));
  }
  getBaseConstraintOfType(type: Type): Promise<Type | undefined> {
    return this.memo(`constraint:${type.id}`, () => this.checker.getBaseConstraintOfType(type));
  }
  getCallSignatures(type: Type): Promise<readonly Signature[]> {
    return this.memo(`call:${type.id}`, () => this.checker.getSignaturesOfType(type, SignatureKind.Call));
  }
  isTupleType(type: Type): Promise<boolean> {
    return this.memo(`tuple:${type.id}`, () => this.checker.isTupleType(type));
  }
  isArrayType(type: Type): Promise<boolean> {
    return this.memo(`array:${type.id}`, () => this.checker.isArrayType(type));
  }
  getTypeArguments(type: TypeReference): Promise<readonly Type[]> {
    return this.memo(`typeArguments:${type.id}`, () => this.checker.getTypeArguments(type));
  }
  getPropertiesOfType(type: Type): Promise<readonly Symbol[]> {
    return this.memo(`properties:${type.id}`, () => this.checker.getPropertiesOfType(type));
  }
  getIndexInfosOfType(type: Type): ReturnType<Checker["getIndexInfosOfType"]> {
    return this.memo(`indexInfos:${type.id}`, () => this.checker.getIndexInfosOfType(type));
  }
  getReturnTypeOfSignature(signature: Signature): Promise<Type | undefined> {
    return this.memo(`returnType:${signature.id}`, () => this.checker.getReturnTypeOfSignature(signature));
  }
  getParameters(signature: Signature): Promise<readonly Symbol[]> {
    return this.memo(`parameters:${signature.id}`, () => signature.getParameters());
  }
  getTypeOfSymbol(symbol: Symbol): Promise<Type | undefined> {
    return this.memo(`typeOfSymbol:${symbol.id}`, () => this.checker.getTypeOfSymbol(symbol));
  }
  /** Types of many symbols in one round trip, sharing the cache with getTypeOfSymbol */
  getTypesOfSymbols(symbols: readonly Symbol[]): Promise<(Type | undefined)[]> {
    const missing = symbols.filter((symbol) => !this.cache.has(`typeOfSymbol:${symbol.id}`));
    if (missing.length > 0) {
      const batch = this.checker.getTypeOfSymbol(missing);
      missing.forEach((symbol, index) => {
        this.cache.set(
          `typeOfSymbol:${symbol.id}`,
          batch.then((types) => types[index]),
        );
      });
    }
    return Promise.all(symbols.map((symbol) => this.getTypeOfSymbol(symbol)));
  }
  getSymbolOfType(type: Type): Promise<Symbol | undefined> {
    return this.memo(`symbolOfType:${type.id}`, () => type.getSymbol());
  }
  getTypesOfUnion(
    type: Type & { getTypes(): Promise<readonly Type[] | undefined> },
  ): Promise<readonly Type[] | undefined> {
    return this.memo(`types:${type.id}`, () => type.getTypes());
  }
  getTarget(type: TypeReference): Promise<Type> {
    return this.memo(`target:${type.id}`, () => type.getTarget());
  }
}

/**
 * Query results for one project in one snapshot. Valid for as long as the snapshot is,
 * so it can be shared by every hover until something changes.
 */
export type ProjectQueryCache = {
  cached: CachedChecker;
  resolvedDeclarations: Map<DeclarationHandle, Promise<Node | undefined>>;
  /** First declaration resolved in each file, which fetches the file into the API's cache */
  fileFetches: Map<string, Promise<unknown>>;
};

export function createProjectQueryCache(project: Project): ProjectQueryCache {
  return { cached: new CachedChecker(project.checker), resolvedDeclarations: new Map(), fileFetches: new Map() };
}

type Context = ProjectQueryCache & {
  checker: Checker;
  project: Project;
  options: PrettifyOptions;
};

/**
 * TypeInfo plus the checker's own rendering of the type, used to skip hovers that
 * would duplicate TypeScript's quick info
 */
export type TsgoTypeInfo = TypeInfo & { quickInfoTypeString: string };

/**
 * Get TypeInfo at a position in a source file
 */
export async function getTypeInfoAtPosition(
  project: Project,
  sourceFile: SourceFile,
  position: number,
  options: PrettifyOptions,
  cache: ProjectQueryCache = createProjectQueryCache(project),
): Promise<TsgoTypeInfo | undefined> {
  const context: Context = { ...cache, checker: project.checker, project, options };
  const { checker } = context;

  const node = getTouchingPropertyName(sourceFile, position);
  if (!node || node === sourceFile || !node.parent) return undefined;

  let symbol = await checker.getSymbolAtLocation(node);
  if (!symbol) return undefined;

  // Handle ImportSpecifier
  if (symbol.flags & SymbolFlags.Alias) {
    symbol = await checker.getAliasedSymbol(symbol);
  }

  let type = await checker.getTypeOfSymbolAtLocation(symbol, node);

  const firstDeclarationKind = symbol.declarations[0]?.kind;
  let syntaxKind = firstDeclarationKind ?? SyntaxKind.ConstKeyword;
  if (isVariableDeclaration(node.parent)) {
    syntaxKind = getVariableDeclarationKind(node.parent);
  }

  const name = symbol.name;

  // Display constructor information for classes being instantiated
  // Don't display constructor information for classes being extended, imported, or part of an import statement
  if (
    syntaxKind === SyntaxKind.ClassDeclaration &&
    !isClassDeclaration(node.parent) &&
    !isPartOfImportStatement(node)
  ) {
    const constructSignatures = await checker.getSignaturesOfType(type, SignatureKind.Construct);
    const constructSignature = constructSignatures[0];
    if (constructSignature) {
      return {
        typeTree: await getConstructorTypeInfo(context, constructSignature, name),
        declaration: getSyntaxKindDeclaration(SyntaxKind.Constructor, name),
        name,
        quickInfoTypeString: "",
      };
    }
  }

  // If the symbol has a declared type, use that when available
  // Don't use declared type for variable declarations
  const shouldUseDeclaredType = firstDeclarationKind !== SyntaxKind.VariableDeclaration;
  const declaredType = await checker.getDeclaredTypeOfSymbol(symbol);

  if (declaredType.flags !== TypeFlags.Any && shouldUseDeclaredType) {
    type = declaredType;
  }

  const [typeTree, quickInfoTypeString] = await Promise.all([
    getTypeTree(context, type, 0, new Set()),
    // Quick info shows a type alias's definition, not its name
    checker.typeToString(type, undefined, InTypeAlias),
  ]);

  return {
    typeTree,
    declaration: getSyntaxKindDeclaration(syntaxKind, name),
    name,
    quickInfoTypeString,
  };
}

/**
 * Check if a node is part of an import statement
 */
function isPartOfImportStatement(node: Node | undefined): boolean {
  while (node) {
    if (isImportDeclaration(node) || isImportSpecifier(node) || isImportClause(node)) {
      return true;
    }
    node = node.parent;
  }
  return false;
}

/**
 * Get the variable declaration kind (`let`, `const`, or `var`) based on the parent node
 */
function getVariableDeclarationKind(node: Node): SyntaxKind {
  const parent = node.parent;
  if (!parent || !isVariableDeclarationList(parent)) return SyntaxKind.ConstKeyword;

  if (parent.flags & NodeFlags.Let) return SyntaxKind.LetKeyword;
  if (parent.flags & NodeFlags.Const) return SyntaxKind.ConstKeyword;

  return SyntaxKind.VarKeyword;
}

/**
 * Resolve a declaration handle to its AST node, once per snapshot.
 *
 * Resolving fetches the declaration's whole source file. The API caches files, but
 * concurrent resolves in an uncached file each fetch it (e.g. hundreds of lib.dom.d.ts
 * members on a DOM type, ~4MB each), so later resolves in a file wait for the first.
 */
function resolveDeclaration(context: Context, handle: DeclarationHandle | undefined): Promise<Node | undefined> {
  if (!handle) return Promise.resolve(undefined);

  let resolved = context.resolvedDeclarations.get(handle);
  if (!resolved) {
    const fileFetch = context.fileFetches.get(handle.path);
    const resolve = () => handle.resolve(context.project).catch(() => undefined);
    resolved = fileFetch ? fileFetch.then(resolve) : resolve();
    if (!fileFetch) context.fileFetches.set(handle.path, resolved);
    context.resolvedDeclarations.set(handle, resolved);
  }
  return resolved;
}

async function getParameterTypeInfos(
  context: Context,
  parameters: readonly Symbol[],
  depth: number,
  visited: Set<number>,
): Promise<TypeFunctionSignature["parameters"]> {
  const parameterTypes = await context.cached.getTypesOfSymbols(parameters);
  return Promise.all(
    parameters.map((parameter, index) =>
      getParameterTypeInfo(context, parameter, parameterTypes[index], depth, new Set(visited)),
    ),
  );
}

async function getParameterTypeInfo(
  context: Context,
  parameter: Symbol,
  parameterType: Type | undefined,
  depth: number,
  visited: Set<number>,
): Promise<TypeFunctionSignature["parameters"][number]> {
  const declaration = await resolveDeclaration(context, parameter.valueDeclaration ?? parameter.declarations[0]);

  const isParameter = !!declaration && isParameterDeclaration(declaration);

  return {
    name: parameter.name,
    isRestParameter: isParameter && !!declaration.dotDotDotToken,
    optional: isParameter && !!declaration.questionToken,
    type: parameterType ? await getTypeTree(context, parameterType, depth, visited) : anyTypeTree(),
  };
}

/**
 * Get type information for a constructor type
 */
async function getConstructorTypeInfo(context: Context, signature: Signature, name: string): Promise<TypeTree> {
  const params = await context.cached.getParameters(signature);
  const parameters = await getParameterTypeInfos(context, params, 0, new Set());

  return {
    kind: "function",
    typeName: name,
    excessSignatures: 0,
    signatures: [
      {
        returnType: { kind: "reference", typeName: name },
        parameters,
      },
    ],
  };
}

function anyTypeTree(): TypeTree {
  return { kind: "primitive", typeName: "any" };
}

/**
 * Recursively get type information by building a TypeTree object from the given type
 */
async function getTypeTree(context: Context, type: Type, depth: number, visited: Set<number>): Promise<TypeTree> {
  const { cached, options } = context;

  // Primitive types
  if (isPrimitiveType(type)) {
    return { kind: "primitive", typeName: await cached.typeToString(type, NoTruncation) };
  }

  // Skip round trips whose answers follow from the type's flags (mirrors the checker):
  // the apparent type of a union or non-mapped object type is the type itself, and only
  // generic types and unions/intersections can have a primitive base constraint
  const apparentIsSelf =
    (type.flags & TypeFlags.Union) !== 0 ||
    ((type.flags & TypeFlags.Object) !== 0 && (getObjectFlags(type) & ObjectFlags.Mapped) === 0);
  const mayHavePrimitiveConstraint = (type.flags & (TypeFlags.Instantiable | TypeFlags.UnionOrIntersection)) !== 0;

  const [typeName, apparentTypeOrUndefined, baseConstraintType] = await Promise.all([
    cached.typeToString(type, NoTruncation),
    apparentIsSelf ? type : cached.getApparentType(type),
    mayHavePrimitiveConstraint ? cached.getBaseConstraintOfType(type) : undefined,
  ]);
  const apparentType = apparentTypeOrUndefined ?? type;

  if (isPrimitiveType(apparentType) || (baseConstraintType && isPrimitiveType(baseConstraintType))) {
    return { kind: "primitive", typeName };
  }

  // Skipped type names
  if (options.skippedTypeNames.includes(typeName)) {
    return { kind: "reference", typeName };
  }

  // Prevent infinite recursion when encountering circular references
  if (visited.has(type.id)) {
    if (typeName.includes("{") || typeName.includes("[") || typeName.includes("(")) {
      return { kind: "reference", typeName: "..." };
    }

    return {
      kind: "reference",
      typeName: await cached.typeToString(apparentType, NoTruncation),
    };
  }

  visited.add(type.id);

  // Unions
  if (apparentType.isUnionType()) {
    const memberTypes = (await cached.getTypesOfUnion(apparentType)) ?? [];
    const excessMembers = Math.max(0, memberTypes.length - options.maxUnionMembers);
    const types = await Promise.all(
      memberTypes
        .slice(0, options.maxUnionMembers)
        .sort(sortUnionTypes)
        .map((t) => getTypeTree(context, t, depth, new Set(visited))),
    );

    return { kind: "union", typeName, excessMembers, types };
  }

  // Enums (only enum literal types can be enum members, so skip the symbol fetch otherwise)
  const typeSymbol = type.flags & TypeFlags.EnumLiteral ? await cached.getSymbolOfType(type) : undefined;
  if (typeSymbol && typeSymbol.flags & SymbolFlags.EnumMember) {
    const parent = await typeSymbol.getParent();
    if (parent) {
      return { kind: "enum", typeName, member: `${parent.name}.${typeSymbol.name}` };
    }
  }

  // Functions
  const callSignatures = await cached.getCallSignatures(apparentType);
  if (callSignatures.length > 0) {
    if (!options.unwrapFunctions) {
      depth = options.maxDepth;
    }

    const signatures: TypeFunctionSignature[] = await Promise.all(
      callSignatures.slice(0, options.maxFunctionSignatures).map(async (signature) => {
        const [returnType, params] = await Promise.all([
          cached.getReturnTypeOfSignature(signature),
          cached.getParameters(signature),
        ]);

        const [returnTypeTree, parameters] = await Promise.all([
          returnType ? getTypeTree(context, returnType, depth, new Set(visited)) : anyTypeTree(),
          getParameterTypeInfos(context, params, depth, visited),
        ]);

        return { returnType: returnTypeTree, parameters };
      }),
    );

    // If there are more signatures than the max allowed, count them as excess
    const excessSignatures = Math.max(0, callSignatures.length - options.maxFunctionSignatures);

    return { kind: "function", excessSignatures, typeName, signatures };
  }

  // Tuples and arrays are always type references
  const isReference = apparentType.isTypeReference();

  // Tuples
  if (isReference && (await cached.isTupleType(apparentType))) {
    const target = (apparentType.isTypeReference() ? await cached.getTarget(apparentType) : undefined) as
      | { readonly?: boolean; elementFlags?: readonly ElementFlags[] }
      | undefined;

    // Optional, rest, and labeled elements can't be rebuilt from type arguments alone,
    // so keep the checker's rendering, e.g. `[a: string, b?: number, ...rest: boolean[]]`
    const hasNonRequiredElements = target?.elementFlags?.some((flags) => flags !== ElementFlags.Required) ?? false;
    if (hasNonRequiredElements || /^(readonly )?\[\s*[\w$]+\??:/.test(typeName)) {
      return {
        kind: "reference",
        typeName: await cached.typeToString(apparentType, NoTruncation | InTypeAlias),
      };
    }

    const readonly = target?.readonly ?? false;
    const typeArguments = await cached.getTypeArguments(apparentType);
    const elementTypes = await Promise.all(typeArguments.map((t) => getTypeTree(context, t, depth, new Set(visited))));

    return { kind: "tuple", typeName, readonly, elementTypes };
  }

  // Arrays
  if (isReference && (await cached.isArrayType(apparentType))) {
    if (!options.unwrapArrays) {
      depth = options.maxDepth;
    }

    const [typeArguments, arraySymbol] = await Promise.all([
      cached.getTypeArguments(apparentType),
      cached.getSymbolOfType(apparentType),
    ]);
    const arrayType = typeArguments[0];
    const elementType = arrayType ? await getTypeTree(context, arrayType, depth, new Set(visited)) : anyTypeTree();

    return {
      kind: "array",
      typeName,
      readonly: arraySymbol?.name === "ReadonlyArray",
      elementType,
    };
  }

  // Generics
  if (type.isTypeReference()) {
    const typeArguments = await cached.getTypeArguments(type);

    if (typeArguments.length > 0) {
      // Get the target type name without generic parameters
      // Ex: Promise<T> => Promise
      const fullTargetTypeName = await cached.typeToString(await cached.getTarget(type), NoTruncation);
      const targetTypeName = fullTargetTypeName.split("<")[0]?.trim() ?? fullTargetTypeName;

      // Skip generic types that are in the skippedTypeNames list, using ellipsis to indicate generic parameters
      if (options.skippedTypeNames.includes(targetTypeName)) {
        return { kind: "reference", typeName: `${targetTypeName}<...>` };
      }

      if (options.unwrapGenericArgumentsTypeNames.includes(targetTypeName)) {
        return {
          kind: "generic",
          typeName: targetTypeName,
          arguments: await Promise.all(typeArguments.map((t) => getTypeTree(context, t, depth, new Set(visited)))),
        };
      }
    }
  }

  // Object
  // At max depth a named type is shown as its name whether or not it's an object,
  // so skip fetching its properties (often hundreds, e.g. DOM types)
  if (depth >= options.maxDepth && !typeName.includes("{")) {
    return { kind: "reference", typeName };
  }

  let typeProperties = await cached.getPropertiesOfType(apparentType);
  if (apparentType.isClassOrInterface() || apparentType.flags & TypeFlags.Object || typeProperties.length > 0) {
    // Resolve how many properties to show based on the maxProperties option
    const depthMaxProps = depth >= 1 ? options.maxSubProperties : options.maxProperties;

    if (options.hidePrivateProperties) {
      const isPublic = await Promise.all(typeProperties.map((symbol) => isPublicProperty(context, symbol)));
      typeProperties = typeProperties.filter((_, index) => isPublic[index]);
    }

    let indexSignatures = await cached.getIndexInfosOfType(apparentType);

    if (depth >= options.maxDepth) {
      // If we've reached the max depth and has a type alias, return it as a reference type
      // Otherwise, return an object with the properties count
      // Example: { ... 3 more } or A & B
      if (!typeName.includes("{")) return { kind: "reference", typeName };

      // Return all properties as excess to avoid deeper nesting
      return {
        kind: "object",
        typeName,
        properties: [],
        excessProperties: typeProperties.length + indexSignatures.length,
      };
    }

    // Track how many properties are being cut off from the maxProperties option
    const excessProperties = Math.max(0, typeProperties.length + indexSignatures.length - depthMaxProps);
    indexSignatures = indexSignatures.slice(0, depthMaxProps);
    typeProperties = typeProperties.slice(0, Math.max(0, depthMaxProps - indexSignatures.length));

    // Index signatures displayed first
    const indexProperties = Promise.all(
      indexSignatures.map(async (indexSignature): Promise<TypeProperty> => {
        const [declaration, indexType, valueTypeTree] = await Promise.all([
          resolveDeclaration(context, indexSignature.declaration),
          cached.typeToString(indexSignature.keyType, NoTruncation),
          getTypeTree(context, indexSignature.valueType, depth + 1, new Set(visited)),
        ]);

        return {
          name: `[${getIndexIdentifierName(declaration)}: ${indexType}]`,
          optional: false,
          readonly: indexSignature.isReadonly,
          type: valueTypeTree,
        };
      }),
    );

    const symbolTypes = await cached.getTypesOfSymbols(typeProperties);
    const namedProperties = Promise.all(
      typeProperties.map(async (symbol, index): Promise<TypeProperty> => {
        const symbolType = symbolTypes[index];
        const [readonly, typeTree] = await Promise.all([
          isReadOnly(context, symbol),
          symbolType ? getTypeTree(context, symbolType, depth + 1, new Set(visited)) : anyTypeTree(),
        ]);

        return {
          name: symbol.name,
          optional: (symbol.flags & SymbolFlags.Optional) !== 0,
          readonly,
          type: typeTree, // Add depth for sub-properties
        };
      }),
    );

    return {
      kind: "object",
      typeName,
      properties: [...(await indexProperties), ...(await namedProperties)],
      excessProperties,
    };
  }

  return { kind: "reference", typeName };
}

function getIndexIdentifierName(declaration: Node | undefined): string {
  const parameter = (declaration as { parameters?: readonly Node[] } | undefined)?.parameters?.[0];
  const parameterName = (parameter as { name?: Node } | undefined)?.name;
  try {
    return parameterName?.getText() || "key";
  } catch {
    return "key";
  }
}

/**
 * Check if a type is a primitive type
 */
function isPrimitiveType(type: Type): boolean {
  const typeFlags = type.flags;

  if (typeFlags & TypeFlags.EnumLike) return false;

  return Boolean(
    typeFlags &
      (TypeFlags.String |
        TypeFlags.StringLiteral |
        TypeFlags.TemplateLiteral |
        TypeFlags.Number |
        TypeFlags.NumberLiteral |
        TypeFlags.Boolean |
        TypeFlags.BooleanLike |
        TypeFlags.BooleanLiteral |
        TypeFlags.Undefined |
        TypeFlags.Null |
        TypeFlags.Void |
        TypeFlags.BigInt |
        TypeFlags.BigIntLiteral |
        TypeFlags.ESSymbol |
        TypeFlags.UniqueESSymbol |
        TypeFlags.Never |
        TypeFlags.Unknown |
        TypeFlags.Any),
  );
}

/** `objectFlags` is sent for every type but isn't on the public `Type` interface */
function getObjectFlags(type: Type): number {
  return (type as { objectFlags?: number }).objectFlags ?? 0;
}

function getIntrinsicName(type: Type): string {
  return type.flags & TypeFlags.Intrinsic ? ((type as { intrinsicName?: string }).intrinsicName ?? "") : "";
}

/**
 * Sort union types by intrinsic types order, following ts quick info order
 * Ex.
 * string, number, bigint, { a: string }, null, undefined
 */
function sortUnionTypes(a: Type, b: Type): number {
  const primitiveTypesOrder = ["string", "number", "bigint", "boolean", "symbol"];
  const falsyTypesOrder = ["null", "undefined"];

  const aIntrinsicName = getIntrinsicName(a);
  const bIntrinsicName = getIntrinsicName(b);

  const aPrimitiveIndex = primitiveTypesOrder.indexOf(aIntrinsicName);
  const bPrimitiveIndex = primitiveTypesOrder.indexOf(bIntrinsicName);
  const aFalsyIndex = falsyTypesOrder.indexOf(aIntrinsicName);
  const bFalsyIndex = falsyTypesOrder.indexOf(bIntrinsicName);

  if (aPrimitiveIndex !== -1 && bPrimitiveIndex !== -1) return aPrimitiveIndex - bPrimitiveIndex;
  if (aPrimitiveIndex !== -1) return -1;
  if (bPrimitiveIndex !== -1) return 1;

  if (aFalsyIndex !== -1 && bFalsyIndex !== -1) return aFalsyIndex - bFalsyIndex;
  if (aFalsyIndex !== -1) return 1;
  if (bFalsyIndex !== -1) return -1;

  return 0;
}

/** Declaration kinds that can carry `private`/`protected` modifiers */
const memberDeclarationKinds = new Set<SyntaxKind>([
  SyntaxKind.MethodDeclaration,
  SyntaxKind.MethodSignature,
  SyntaxKind.PropertyDeclaration,
  SyntaxKind.PropertySignature,
]);

/**
 * Check if an object property is public
 */
async function isPublicProperty(context: Context, symbol: Symbol): Promise<boolean> {
  const name = symbol.name;
  if (name.startsWith("_") || name.startsWith("#")) return false;

  const memberDeclarations = symbol.declarations.filter((handle) => memberDeclarationKinds.has(handle.kind));
  const declarations = await Promise.all(memberDeclarations.map((handle) => resolveDeclaration(context, handle)));

  return declarations.every(
    (declaration) =>
      !declaration || !(getModifierFlags(declaration) & (ModifierFlags.Private | ModifierFlags.Protected)),
  );
}

/** Declaration kinds that can carry a `readonly` modifier */
const readonlyDeclarationKinds = new Set<SyntaxKind>([
  SyntaxKind.PropertyDeclaration,
  SyntaxKind.PropertySignature,
  SyntaxKind.GetAccessor,
  SyntaxKind.SetAccessor,
  SyntaxKind.Parameter,
]);

/**
 * Check if an object property is readonly
 */
async function isReadOnly(context: Context, symbol: Symbol): Promise<boolean> {
  if (symbol.checkFlags & CheckFlagsReadonly) return true;

  const readonlyCandidates = symbol.declarations.filter((handle) => readonlyDeclarationKinds.has(handle.kind));
  const declarations = await Promise.all(readonlyCandidates.map((handle) => resolveDeclaration(context, handle)));

  return declarations.some((declaration) => {
    if (!declaration) return false;
    if (
      !isPropertyDeclaration(declaration) &&
      !isPropertySignatureDeclaration(declaration) &&
      !isParameterDeclaration(declaration) &&
      declaration.kind !== SyntaxKind.GetAccessor &&
      declaration.kind !== SyntaxKind.SetAccessor
    ) {
      return false;
    }
    return (getModifierFlags(declaration) & ModifierFlags.Readonly) !== 0;
  });
}

function getModifierFlags(node: Node): number {
  const modifierFlags = (node as { modifierFlags?: number }).modifierFlags;
  if (modifierFlags !== undefined) return modifierFlags;

  // Fall back to scanning modifiers
  const modifiers = (node as { modifiers?: readonly Node[] }).modifiers ?? [];
  let flags = 0;
  for (const modifier of modifiers) {
    if (modifier.kind === SyntaxKind.PrivateKeyword) flags |= ModifierFlags.Private;
    if (modifier.kind === SyntaxKind.ProtectedKeyword) flags |= ModifierFlags.Protected;
    if (modifier.kind === SyntaxKind.ReadonlyKeyword) flags |= ModifierFlags.Readonly;
  }
  return flags;
}

/**
 * Builds a declaration string based on the syntax kind
 */
export function getSyntaxKindDeclaration(syntaxKind: SyntaxKind, typeName: string): string {
  // Handle imported types
  if (typeName.startsWith('"') && typeName.endsWith('"')) {
    const shortenedTypeName = typeName.replace(/"/g, "").split("node_modules/").pop()!;
    return `typeof import("${shortenedTypeName}"): `;
  }

  switch (syntaxKind) {
    case SyntaxKind.ClassDeclaration:
    case SyntaxKind.NewExpression:
      return `class ${typeName} `;

    case SyntaxKind.ExpressionWithTypeArguments:
    case SyntaxKind.InterfaceDeclaration:
    case SyntaxKind.QualifiedName:
      return `interface ${typeName} `;

    case SyntaxKind.ArrayType:
    case SyntaxKind.ConstructorType:
    case SyntaxKind.ConstructSignature:
    case SyntaxKind.EnumDeclaration:
    case SyntaxKind.FunctionType:
    case SyntaxKind.IndexedAccessType:
    case SyntaxKind.IndexSignature:
    case SyntaxKind.IntersectionType:
    case SyntaxKind.MappedType:
    case SyntaxKind.PropertySignature:
    case SyntaxKind.ThisType:
    case SyntaxKind.TupleType:
    case SyntaxKind.TypeAliasDeclaration:
    case SyntaxKind.TypeAssertionExpression:
    case SyntaxKind.TypeLiteral:
    case SyntaxKind.TypeOperator:
    case SyntaxKind.TypePredicate:
    case SyntaxKind.TypeQuery:
    case SyntaxKind.TypeReference:
    case SyntaxKind.UnionType:
      return `type ${typeName} = `;

    case SyntaxKind.FunctionDeclaration:
    case SyntaxKind.FunctionKeyword:
    case SyntaxKind.MethodDeclaration:
    case SyntaxKind.MethodSignature:
    case SyntaxKind.GetAccessor:
    case SyntaxKind.SetAccessor:
    case SyntaxKind.Constructor:
      return `function ${typeName}`;

    case SyntaxKind.LetKeyword:
      return `let ${typeName}: `;

    case SyntaxKind.VarKeyword:
      return `var ${typeName}: `;

    default:
      return `const ${typeName}: `;
  }
}

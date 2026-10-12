# `readonlyStyle` setting

> [!WARNING]
> **This code is slop.** It was written by [Claude Code](https://claude.com/claude-code). We didn't read the code at all. It passes its tests and works on our machines; beyond that, you're on your own.

`prettify-ts7.readonlyStyle` controls how Prettify writes readonly arrays and tuples in hovers and in the copy commands.

| Value | Readonly array | Readonly tuple |
|---|---|---|
| `"keyword"` (default) | `readonly string[]` | `readonly [string, number]` |
| `"generic"` | `ReadonlyArray<string>` | `Readonly<[string, number]>` |

Both styles describe exactly the same types. The generic style avoids the parentheses TypeScript needs when readonly types nest, so it can be easier to read:

```ts
// keyword
readonly (readonly [id: number, name: string])[]

// generic
ReadonlyArray<Readonly<[id: number, name: string]>>
```

## Enable it

In your VS Code `settings.json`:

```jsonc
{
  "prettify-ts7.readonlyStyle": "generic"
}
```

## What changes

- Readonly arrays and tuples that Prettify expands, e.g. `value: ReadonlyArray<string>`.
- Readonly arrays and tuples inside type names TypeScript prints whole, e.g. `Iterable<Readonly<[id: number, name: string]>>`.
- Parenthesized element types, e.g. `readonly (string | number)[]` becomes `ReadonlyArray<string | number>`.

## What stays the same

- `readonly` on object properties: `{ readonly id: number }`.
- `readonly` on index signatures: `{ readonly [key: string]: string }`.
- TypeScript's own hover, shown alongside Prettify's, keeps the `readonly` keyword.

## Things to know

- With `"generic"`, Prettify's hover also appears for readonly types that TypeScript already shows in full, because the different spelling no longer counts as a duplicate.
- The rewrite of TypeScript's own type text only converts `readonly T[]` when `T` is a plain name (like `string` or `User`) or is wrapped in parentheses. More complex element types keep the keyword form.

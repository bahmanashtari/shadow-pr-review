/**
 * Generates TypeScript types from schemas/*.schema.json (and config/config.schema.json)
 * into src/contracts/generated/.
 * Usage:
 *   pnpm gen:types            write the files
 *   pnpm check:types          fail if the committed files are out of date (used in CI)
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { compile, type JSONSchema } from "json-schema-to-typescript";
import { CONTRACT_NAMES, schemaPath } from "../src/contracts/schemas.js";
import { fromRoot } from "../src/lib/paths.js";

const OUT_DIR = fromRoot("src", "contracts", "generated");
const BANNER =
  "/* eslint-disable */\n" +
  "/**\n" +
  " * GENERATED FILE. Do not edit by hand.\n" +
  " * Source: %SOURCE%. Regenerate with `pnpm gen:types`.\n" +
  " */";

const TARGETS: readonly { out: string; schemaFile: string }[] = [
  ...CONTRACT_NAMES.map((name) => ({ out: `${name}.ts`, schemaFile: schemaPath(name) })),
  { out: "config.ts", schemaFile: fromRoot("config", "config.schema.json") },
];

async function generate(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const target of TARGETS) {
    const schema = JSON.parse(await readFile(target.schemaFile, "utf8")) as JSONSchema;
    const source = path.relative(fromRoot(), target.schemaFile).split(path.sep).join("/");
    const ts = await compile(schema, schema.title ?? target.out, {
      bannerComment: BANNER.replace("%SOURCE%", source),
      cwd: path.dirname(target.schemaFile),
      additionalProperties: false,
      ignoreMinAndMaxItems: true, // plain T[]; Ajv enforces minItems/maxItems at runtime
      strictIndexSignatures: true,
      style: { printWidth: 100, singleQuote: false, trailingComma: "all" },
    });
    out.set(path.join(OUT_DIR, target.out), ts);
  }
  return out;
}

async function main(): Promise<void> {
  const check = process.argv.includes("--check");
  const files = await generate();
  const stale: string[] = [];

  if (!check) await mkdir(OUT_DIR, { recursive: true });
  for (const [file, content] of files) {
    if (check) {
      const current = await readFile(file, "utf8").catch(() => "");
      if (current !== content) stale.push(path.relative(process.cwd(), file));
    } else {
      await writeFile(file, content, "utf8");
      console.log(`wrote ${path.relative(process.cwd(), file)}`);
    }
  }

  if (stale.length > 0) {
    console.error(`Generated types are out of date:\n  ${stale.join("\n  ")}\nRun: pnpm gen:types`);
    process.exitCode = 1;
  } else if (check) {
    console.log("Generated types are up to date.");
  }
}

await main();

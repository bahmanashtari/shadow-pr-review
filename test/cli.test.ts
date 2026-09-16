import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.js";
import { fromRoot } from "../src/lib/paths.js";

const run = (...args: string[]): Promise<void> => main(["node", "spr", ...args]);

describe("spr CLI", () => {
  let out: string[];
  let err: string[];

  beforeEach(() => {
    out = [];
    err = [];
    process.exitCode = undefined;
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void out.push(a.join(" ")));
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void err.push(a.join(" ")));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it("validate accepts the golden fixtures", async () => {
    const dir = fromRoot("golden", "sample-02-inventory-consumer");
    await run("validate", `${dir}/review.expected.json`, `${dir}/script.expected.json`);
    expect(process.exitCode).toBeUndefined();
    expect(out).toHaveLength(2);
    expect(out.every((line) => line.startsWith("ok"))).toBe(true);
  });

  it("validate fails when the contract cannot be inferred", async () => {
    await run("validate", fromRoot("golden", "sample-01-order-outbox", "labels.json"));
    expect(process.exitCode).toBe(1);
    expect(err.join("\n")).toContain("pass --schema");
  });

  it("validate --schema reports schema errors", async () => {
    await run("validate", "--schema", "timeline", fromRoot("config", "default.json"));
    expect(process.exitCode).toBe(1);
    expect(err.join("\n")).toContain("FAIL");
  });

  it("planned commands exit with code 2 and a clear message", async () => {
    await run("run", "--diff", "x.patch");
    expect(process.exitCode).toBe(2);
    expect(err.join("\n")).toContain("not implemented yet");
  });

  it("config prints the resolved config without secret values", async () => {
    const previous = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-secret-value";
    try {
      await run("config");
    } finally {
      if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previous;
    }
    const text = out.join("\n");
    expect(text).toContain('"maxFindings": 10');
    expect(text).toContain("ANTHROPIC_API_KEY: set");
    expect(text).not.toContain("sk-secret-value");
  });
});

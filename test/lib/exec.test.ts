import { describe, expect, it } from "vitest";
import { run } from "../../src/lib/exec.js";
import { sha256 } from "../../src/lib/hash.js";

describe("run", () => {
  it("returns stdout", async () => {
    expect(await run(process.execPath, ["-e", "process.stdout.write('hello')"])).toBe("hello");
  });

  it("names the command and quotes stderr when it fails", async () => {
    const script = "console.error('first line'); console.error('boom'); process.exit(3)";
    await expect(run(process.execPath, ["-e", script])).rejects.toThrow("Command failed:");
    await expect(run(process.execPath, ["-e", script])).rejects.toThrow("boom");
  });

  it("does not use a shell", async () => {
    const out = await run(process.execPath, [
      "-e",
      "process.stdout.write(process.argv[1] ?? '')",
      "a b; echo hi",
    ]);
    expect(out).toBe("a b; echo hi");
  });

  it("stops a command that runs past its timeout", async () => {
    await expect(
      run(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], { timeoutMs: 200 }),
    ).rejects.toThrow("Command failed:");
  });
});

describe("sha256", () => {
  it("is lowercase hex and matches the known digest of the empty string", () => {
    expect(sha256("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256("abc")).toMatch(/^[a-f0-9]{64}$/);
    expect(sha256(new Uint8Array([97, 98, 99]))).toBe(sha256("abc"));
  });
});

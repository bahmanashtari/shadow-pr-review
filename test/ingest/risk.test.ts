import { describe, expect, it } from "vitest";
import { matchedRules, riskScore, RISK_RULES } from "../../src/ingest/risk.js";

describe("RISK_RULES", () => {
  it("is the table documented in ARCHITECTURE.md", () => {
    expect(RISK_RULES.map((r) => [r.name, r.points])).toEqual([
      ["migration", 5],
      ["domain", 4],
      ["messaging", 4],
      ["security", 4],
      ["infrastructure", 2],
      ["source", 1],
      ["tests", -2],
      ["docs", -3],
    ]);
  });
});

describe("riskScore", () => {
  it.each([
    ["services/order-service/src/application/commands/place-order.handler.ts", 5],
    ["services/inventory-service/src/infrastructure/persistence/migrations/1726-Add.ts", 8],
    ["services/customer-service/src/domain/value-objects/email.ts", 5],
    ["services/customer-service/src/domain/value-objects/email.spec.ts", 3],
    ["db/migrations/001-init.sql", 5],
    ["src/messaging/order-placed.consumer.ts", 5],
    ["src/outbox/outbox.relay.ts", 5],
    ["src/auth/jwt.guard.ts", 5],
    ["src/common/crypto.ts", 5],
    [".github/workflows/ci.yml", 2],
    ["Dockerfile", 2],
    ["docker-compose.yml", 2],
    ["src/app.config.ts", 3],
    [".env.production", 2],
    ["src/plain.ts", 1],
    ["test/helpers.ts", -2],
    ["docs/ARCHITECTURE.md", -3],
    ["README.md", -3],
    ["vendor/lib/thing.ts", 0],
  ])("%s scores %i", (path, expected) => {
    expect(riskScore(path)).toBe(expected);
  });

  it("adds every matching rule and ignores case", () => {
    const path = "SERVICES/Src/Domain/Migrations/Order.Event.ts";
    expect(matchedRules(path)).toEqual(["migration", "domain", "messaging", "source"]);
    expect(riskScore(path)).toBe(5 + 4 + 4 + 1);
  });

  it("scores an unremarkable path at zero", () => {
    expect(riskScore("LICENSE")).toBe(0);
  });
});

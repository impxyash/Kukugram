import { describe, expect, it } from "vitest";
import { createProfileSchema, normalizeHandle } from "./index.js";

describe("profile validation", () => {
  it("normalizes handles before persistence", () => {
    expect(normalizeHandle("  Kuku_Creator ")).toBe("kuku_creator");
    expect(createProfileSchema.safeParse({ handle: "Kuku", displayName: "Kuku" }).success).toBe(
      false
    );
  });
});

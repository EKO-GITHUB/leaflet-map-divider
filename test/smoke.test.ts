import { describe, expect, it } from "vitest";
import { auto_max_zoom } from "@/services/tile_plan";

describe("test setup", () => {
  it("resolves the @/ alias to src", () => {
    expect(auto_max_zoom(1024)).toBe(3);
    expect(auto_max_zoom(1632)).toBe(3);
  });
});

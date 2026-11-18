import { describe, expect, it } from "vitest";
import { calculate_max_zoom_level } from "@/utils/image_validation";

describe("test setup", () => {
  it("resolves the @/ alias to src", () => {
    expect(calculate_max_zoom_level(1024)).toBe(3);
    expect(calculate_max_zoom_level(1632)).toBe(3);
  });
});

import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { icc_description, is_srgb_profile } from "../cli/icc";

// a minimal ICC profile with one v2 "desc" tag (textDescriptionType)
function v2_profile(description: string): Uint8Array {
  const text = new TextEncoder().encode(`${description}\0`);
  const tag_offset = 132 + 12;
  const tag_size = 12 + text.length + 67;
  const icc = new Uint8Array(tag_offset + tag_size);
  const view = new DataView(icc.buffer);
  view.setUint32(0, icc.length);
  view.setUint32(128, 1);
  icc.set(new TextEncoder().encode("desc"), 132);
  view.setUint32(136, tag_offset);
  view.setUint32(140, tag_size);
  icc.set(new TextEncoder().encode("desc"), tag_offset);
  view.setUint32(tag_offset + 8, text.length);
  icc.set(text, tag_offset + 12);
  return icc;
}

async function embedded_profile(profile: string): Promise<Uint8Array> {
  const png = await sharp(Buffer.alloc(4 * 4 * 3, 100), { raw: { width: 4, height: 4, channels: 3 } })
    .png()
    .withIccProfile(profile)
    .toBuffer();
  return new Uint8Array((await sharp(png).metadata()).icc!);
}

describe("ICC profiles", () => {
  it("reads v2 descriptions (HP's sRGB, GIMP's built-in sRGB) and v4 ones (libvips's sRGB and P3)", async () => {
    expect(icc_description(v2_profile("sRGB IEC61966-2.1"))).toBe("sRGB IEC61966-2.1");
    expect(icc_description(v2_profile("sRGB built-in"))).toBe("sRGB built-in");
    expect(icc_description(await embedded_profile("srgb"))).toBe("sRGB");
    expect(icc_description(await embedded_profile("p3"))).toBe("sP3C");
  });

  it("tells the common sRGB profiles from others", async () => {
    for (const description of ["sRGB IEC61966-2.1", "sRGB IEC61966-2-1", "sRGB built-in", "sRGB", "sRGB2014"]) {
      expect(is_srgb_profile(v2_profile(description)), description).toBe(true);
    }
    for (const description of ["Display P3", "Adobe RGB (1998)", "sRGB-elle-V4-g10", "Generic RGB Profile"]) {
      expect(is_srgb_profile(v2_profile(description)), description).toBe(false);
    }
    expect(is_srgb_profile(await embedded_profile("srgb"))).toBe(true);
    expect(is_srgb_profile(await embedded_profile("p3"))).toBe(false);
  });

  it("gives no description for a profile it cannot read", () => {
    expect(icc_description(new Uint8Array(0))).toBeNull();
    expect(icc_description(new Uint8Array(200))).toBeNull();
    const truncated = v2_profile("sRGB").subarray(0, 150);
    expect(icc_description(truncated)).toBeNull();
    expect(is_srgb_profile(truncated)).toBe(false);
  });
});

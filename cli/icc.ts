// Enough of an ICC profile to tell an sRGB profile from others: its description tag ("desc", a v2 textDescriptionType
// or a v4 multiLocalizedUnicodeType). A browser draws an image with an sRGB profile as it is, so the command-line
// cutter does not convert it either (lcms converting sRGB to sRGB moves a few values by 1); any other profile is
// converted to sRGB, as a browser would.

// the descriptions of the common sRGB profiles: the ICC's and HP's, GIMP's built-in, Chrome's and Skia's
const SRGB_DESCRIPTIONS = /^(srgb|srgb iec61966-2[.-]1|srgb built-in|srgb2014)$/i;

/** The profile's description, or null when it has none that can be read. */
export function icc_description(icc: Uint8Array): string | null {
  const view = new DataView(icc.buffer, icc.byteOffset, icc.byteLength);
  const ascii = (offset: number, length: number) =>
    String.fromCharCode(...icc.subarray(offset, offset + length));
  if (icc.length < 132) return null;
  const tags = view.getUint32(128);
  for (let i = 0; i < tags; i++) {
    const entry = 132 + i * 12;
    if (entry + 12 > icc.length) return null;
    if (ascii(entry, 4) !== "desc") continue;
    const offset = view.getUint32(entry + 4);
    const size = view.getUint32(entry + 8);
    if (offset + size > icc.length || size < 12) return null;
    const type = ascii(offset, 4);
    if (type === "desc") {
      // textDescriptionType: an ASCII count (with its trailing NUL), then the text
      const count = view.getUint32(offset + 8);
      if (count < 1 || 12 + count > size) return null;
      return ascii(offset + 12, count - 1).replace(/\0+$/, "");
    }
    if (type === "mluc") {
      // multiLocalizedUnicodeType: records of (language, country, length, offset); the first one, UTF-16BE
      if (size < 28 || view.getUint32(offset + 8) < 1) return null;
      const length = view.getUint32(offset + 20);
      const start = offset + view.getUint32(offset + 24);
      if (start + length > offset + size) return null;
      let text = "";
      for (let k = 0; k + 1 < length; k += 2) text += String.fromCharCode(view.getUint16(start + k));
      return text.replace(/\0+$/, "");
    }
    return null;
  }
  return null;
}

/** Whether a profile is one of the common sRGB profiles (by its description). */
export function is_srgb_profile(icc: Uint8Array): boolean {
  const description = icc_description(icc);
  return description !== null && SRGB_DESCRIPTIONS.test(description.trim());
}

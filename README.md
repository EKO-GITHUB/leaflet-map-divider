# https://leafletmapdivider.com

## Easily divide large maps into LeafletJS-compatible TileLayers!

- This tool slices your image into equally sized tiles across multiple zoom levels, making it ideal for use with
  LeafletJS.
- All operations are performed locally—your image never leaves your device.
- Tile Size: Each tile has a minimum width of 128px.
- Image Requirements: The source image must be a square with a minimum width of 128px.
- Zoom Levels: The maximum zoom level is determined by repeatedly halving the image size until it either reaches an odd
  width or is smaller than 128px.
  Divisibility: Ensure your image is easily divisible. For example, a width of 1366px is not optimal because it can only
  be divided once to 683px, leading to larger tile sizes.
- Supported Formats: Only pixel-based image formats are supported; SVGs are not compatible.
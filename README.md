# https://leafletmapdivider.com

Divides your large map into a LeafletJS compatible TileLayer!

- Divides your image into equally sized tiles at various zoom levels, perfect for LeafletJS!
- This service does not transfer your image to the internet; all operations are local.
- Each tile has a minimum width of 128px.
- The source image must be a square and at least 128px wide.
- The maximum zoom level is calculated by dividing the image in half until it reaches an odd width or is smaller than
  128px.
- Make sure your image is easily divisible.
  For example, a width of 1366px is a poor choice because it can only be divided once to 683px, resulting in a large
  minimum tile size.
- Only pixel based image formats are supported. SVGs are not supported.
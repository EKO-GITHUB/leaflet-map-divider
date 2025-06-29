# LeafletJS Map Tile Generator

[![Live Demo](https://img.shields.io/badge/demo-live-brightgreen.svg)](https://leafletmapdivider.com)

Transform large images into LeafletJS-compatible tile layers with this powerful web application. Process images entirely in your browser with real-time progress tracking and granular zoom-level monitoring.

## ✨ Features

### 🎯 Core Functionality
- **Tile Generation**: Automatically slices images into optimized tiles across multiple zoom levels
- **Local Processing**: 100% client-side processing - your images never leave your device
- **LeafletJS Compatible**: Generates tile structures perfect for LeafletJS map integration
- **Multiple Formats**: Export tiles as PNG or WebP with quality optimization

### 🚀 Advanced Progress Tracking
- **Granular Progress**: Real-time per-zoom-level progress monitoring
- **Performance Metrics**: Live tiles-per-second processing speed
- **Visual Feedback**: Color-coded progress bars with completion indicators
- **Time Estimation**: Accurate remaining time calculations

### 🖼️ Interactive Image Preview
- **Zoom Control**: Discrete zoom levels matching tile generation
- **Pan & Drag**: Mouse drag support for navigating zoomed images
- **Wheel Zoom**: Smooth scroll-wheel zooming with page scroll prevention
- **Auto Reset**: Position resets when returning to zoom level 0

## 🛠️ Image Requirements

### Image Specifications
- **Format**: Any pixel-based image format (PNG, JPG, WebP, etc.)
- **Dimensions**: Must be square (equal width and height)
- **Size**: Minimum 128×128 pixels
- **Divisibility**: Dimensions must be even numbers for proper tiling

### Optimal Image Sizing
For best results, use image dimensions that are powers of 2:
- ✅ 512×512, 1024×1024, 2048×2048, 4096×4096
- ❌ Avoid sizes like 1366×1366 (limited divisibility)

### Zoom Level Calculation
The maximum zoom level is determined by repeatedly halving the image size:
- **Starting**: 2048×2048 (Zoom 0)
- **Level 1**: 1024×1024 
- **Level 2**: 512×512
- **Level 3**: 256×256
- **Max Level**: Stops at minimum tile size (128px)

## 📦 Output Structure

Generated tiles follow the standard z/y/x structure:
```
tiles.zip
├── 0/
│   └── 0/
│       └── 0.png
├── 1/
│   ├── 0/
│   │   ├── 0.png
│   │   └── 1.png
│   └── 1/
│       ├── 0.png
│       └── 1.png
└── 2/...
```

### LeafletJS Integration
```javascript
import L from 'leaflet';

const tileLayer = L.tileLayer('/path/to/tiles/{z}/{y}/{x}.png', {
  maxZoom: calculatedMaxZoom,
  minZoom: 0,
  noWrap: true,
  continuousWorld: false
});

const map = L.map('map').setView([0, 0], 0);
tileLayer.addTo(map);
```

## 🚀 How It Works

1. **Upload Your Image**: Select a square image from your device
2. **Preview & Adjust**: Use the interactive preview to explore your image
3. **Choose Format**: Select PNG for lossless quality or WebP for smaller file sizes
4. **Generate Tiles**: Watch real-time progress as tiles are created for each zoom level
5. **Download**: Get your zip file containing all tiles ready for LeafletJS

## 💡 Use Cases

- **Custom Maps**: Create interactive maps from satellite imagery, floor plans, or artwork
- **Game Development**: Generate tile sets for 2D games with zoom functionality
- **Historical Maps**: Digitize and make old maps interactive
- **Large Images**: Make any large image zoomable and pannable on the web
- **Scientific Visualization**: Create interactive visualizations of large datasets

## 🎯 Why Use This Tool?

- **No Server Required**: Everything runs in your browser
- **Privacy First**: Your images never leave your device
- **Instant Results**: No waiting for server processing
- **Professional Quality**: Generates industry-standard tile structures
- **Easy Integration**: Drop-in compatibility with LeafletJS
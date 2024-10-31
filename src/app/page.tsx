"use client";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import React, { useEffect, useRef, useState } from "react";
import { Dropzone } from "@/components/ui/dropzone";
import { GithubIcon, UploadIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import JSZip from "jszip";
import Link from "next/link";
import { Switch } from "@/components/ui/switch";

export default function Home() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [chosenImage, setChosenImage] = useState<HTMLImageElement | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [imgWidth, setImgWidth] = useState<number>(0);
  const [imgHeight, setImgHeight] = useState<number>(0);
  const [fileName, setFileName] = useState<string | null>(null);
  const [maxZoomLevel, setMaxZoomLevel] = useState<number>(0);
  const [downloadDisabled, setDownloadDisabled] = useState<boolean>(false);
  const [progress, setProgress] = useState<number>(0);
  const [currentZoomLevel, setCurrentZoomLevel] = useState<number>(0);
  const [outputFormat, setOutputFormat] = useState<string>("png");
  const [imageSrc, setImageSrc] = useState<string | null>(null);

  const MIN_TILE_SIZE = 128;

  const handleChange = (files: FileList | null) => {
    const file = files?.[0];

    if (file) {
      if (!file.type.startsWith("image")) {
        const fileType = file.type !== "" ? file.type : "unknown";
        setStatusMessage(
          `File type: ${fileType} is not supported, select an image instead!`,
        );
        setChosenImage(null);
        setFileName(null);
      } else {
        setFileName(file.name);
        const img = new Image();
        const objectUrl = URL.createObjectURL(file);
        img.onload = function () {
          if (img.naturalHeight !== img.naturalWidth) {
            setStatusMessage("The selected image is not a square!");
            setChosenImage(null);
            setFileName(null);
            return;
          }
          if (
            img.naturalHeight < MIN_TILE_SIZE ||
            img.naturalWidth < MIN_TILE_SIZE
          ) {
            setStatusMessage(
              `The selected image is too small to process! Width and height must be at least ${MIN_TILE_SIZE}px`,
            );
            setChosenImage(null);
            setFileName(null);
            return;
          }
          if (img.naturalHeight % 2 > 0 || img.naturalWidth % 2 > 0) {
            setStatusMessage(
              "The image has an odd width or height, it cannot be divided!",
            );
            setChosenImage(null);
            setFileName(null);
            return;
          }

          setImgHeight(img.naturalHeight);
          setImgWidth(img.naturalWidth);

          // Calculate maximum zoom level
          let zoomLevel = 0;
          let tmpWidth = img.naturalWidth;
          while (tmpWidth % 2 === 0 && tmpWidth >= MIN_TILE_SIZE * 2) {
            tmpWidth = tmpWidth / 2;
            zoomLevel++;
          }
          setMaxZoomLevel(zoomLevel);

          setChosenImage(img);
          setImageSrc(objectUrl);
          setStatusMessage(null);
        };
        img.src = objectUrl;
      }
    }
  };

  function handleClickUpload() {
    inputRef.current?.click();
  }

  async function startTiling() {
    setDownloadDisabled(true);
    const zip = new JSZip();
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");

    const totalTiles = [];
    for (let z = maxZoomLevel; z >= 0; z--) {
      const tilesPerSide = Math.pow(2, z);
      totalTiles.push(tilesPerSide * tilesPerSide);
    }
    const totalTileCount = totalTiles.reduce((a, b) => a + b, 0);
    let processedTileCount = 0;

    for (let z = maxZoomLevel; z >= 0; z--) {
      setCurrentZoomLevel(z);
      const scale = Math.pow(2, maxZoomLevel - z);
      const scaledWidth = imgWidth / scale;
      const scaledHeight = imgHeight / scale;

      // Resize the image for the current zoom level
      canvas.width = scaledWidth;
      canvas.height = scaledHeight;
      ctx!.imageSmoothingEnabled = false; // Disable smoothing to prevent blurriness
      ctx!.clearRect(0, 0, scaledWidth, scaledHeight);

      if (scale === 1) {
        // At max zoom level, draw the original image
        ctx!.drawImage(chosenImage!, 0, 0, scaledWidth, scaledHeight);
      } else {
        // For lower zoom levels, draw a scaled version
        ctx!.drawImage(
          chosenImage!,
          0,
          0,
          imgWidth,
          imgHeight,
          0,
          0,
          scaledWidth,
          scaledHeight,
        );
      }

      const tilesPerSide = Math.pow(2, z);
      const tileSize = scaledWidth / tilesPerSide;

      for (let x = 0; x < tilesPerSide; x++) {
        for (let y = 0; y < tilesPerSide; y++) {
          const startX = x * tileSize;
          const startY = y * tileSize;

          // Create a tile canvas
          const tileCanvas = document.createElement("canvas");
          const tileCtx = tileCanvas.getContext("2d");
          tileCanvas.width = tileSize;
          tileCanvas.height = tileSize;

          tileCtx!.imageSmoothingEnabled = false;
          tileCtx!.drawImage(
            canvas,
            startX,
            startY,
            tileSize,
            tileSize,
            0,
            0,
            tileSize,
            tileSize,
          );

          const dataURL = tileCanvas.toDataURL(
            outputFormat === "png" ? "image/png" : "image/webp",
            1.0,
          );
          const base64Data = dataURL.replace(
            /^data:image\/(png|jpg|webp);base64,/,
            "",
          );
          zip.file(
            `${z}/${y}/${x}.${outputFormat === "png" ? "png" : "webp"}`,
            base64Data,
            {
              base64: true,
            },
          );
          processedTileCount++;
          setProgress(Math.floor((processedTileCount / totalTileCount) * 100));

          // Yield control back to the event loop every few tiles
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      }
    }

    // Allow the UI to update one last time before generating the zip
    await new Promise((resolve) => setTimeout(resolve, 0));

    zip.generateAsync({ type: "blob" }).then((content) => {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(content);
      a.download = `${fileName?.replace(/\.[^/.]+$/, "") || "tiles"}.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setDownloadDisabled(false);
      setProgress(0);
      setCurrentZoomLevel(0);
    });
  }

  useEffect(() => {
    return () => {
      // Cleanup object URL when component unmounts or image changes
      if (imageSrc) {
        URL.revokeObjectURL(imageSrc);
      }
    };
  }, [imageSrc]);

  return (
    <main className="min-h-screen bg-slate-800">
      <div className={"grid justify-center items-start text-white gap-4 p-12"}>
        <div
          className={
            "bg-slate-900 flex justify-center items-center text-4xl rounded-lg p-6 gap-4"
          }
        >
          <img
            src={"/leafletmapdivider-60.png"}
            width={60}
            height={60}
            alt={"leaflet map divider logo"}
          />
          Leaflet Map Divider
        </div>
        <Card className={"min-w-80 bg-slate-700 rounded-lg"}>
          <CardHeader>
            <CardTitle>
              <div className={"flex items-center justify-center gap-2"}>
                <span>Select your full map!</span>
              </div>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid items-center justify-items-center gap-2">
              <Dropzone
                ref={inputRef}
                onChange={handleChange}
                multiple={false}
                accept="image/*"
              >
                <div className="grid items-center justify-items-center gap-y-4">
                  <div className="flex justify-around w-full">
                    <Button onClick={handleClickUpload}>Select map</Button>
                    <Button
                      variant={"destructive"}
                      onClick={() => {
                        setChosenImage(null);
                        setFileName(null);
                        setStatusMessage(null);
                        if (imageSrc) {
                          URL.revokeObjectURL(imageSrc);
                          setImageSrc(null);
                        }
                      }}
                    >
                      Reset
                    </Button>
                  </div>
                  <div className={"flex gap-2"}>
                    <div className="rounded-full bg-slate-100 p-2">
                      <UploadIcon className="text-primary" size={12} />
                    </div>
                    <p className="text-lg font-semibold">
                      or drag and drop an image file
                    </p>
                  </div>
                  {fileName ? (
                    <span className={"text-green-500"}>{fileName}</span>
                  ) : (
                    <div
                      className={
                        "grid gap-1 justify-center items-center text-red-400"
                      }
                    >
                      {statusMessage != null && (
                        <span className={"max-w-[40rem]"}>{statusMessage}</span>
                      )}
                      <span>no file selected!</span>
                    </div>
                  )}
                </div>
              </Dropzone>
            </div>
          </CardContent>
          <CardFooter className={"text-sm"}>
            <ul className={"list-disc max-w-[40rem] [&_li]:p-2"}>
              <li>
                Leaflet Map Divider divides your image into equally sized tiles
                at various zoom levels, perfect for{" "}
                {
                  <a
                    className={"text-blue-400"}
                    href={"https://leafletjs.com/"}
                  >
                    LeafletJS
                  </a>
                }
                !
              </li>
              <li>
                <span>
                  {
                    "This service does not transfer your image to the internet; all operations are local."
                  }
                </span>
              </li>
              <li>Each tile has a minimum size of 256px.</li>
              <li>
                The source image must be a square and at least 256px wide.
              </li>
              <li>
                The maximum zoom level is calculated by dividing the image in
                half until it reaches an odd width or is smaller than twice the
                minimum tile size.
              </li>
              <li>
                Make sure your image is easily divisible.
                <br />
                For example, a width of 1366px is a poor choice because it can
                only be divided once to 683px, resulting in a large minimum tile
                size.
              </li>
            </ul>
          </CardFooter>
        </Card>
        {chosenImage != null && (
          <>
            <div className={"bg-slate-700 p-2 rounded-lg"}>
              <table>
                <tbody className={"[&_tr_th]:text-start [&_tr_th]:p-1"}>
                  <tr>
                    <th>Width</th>
                    <td>{imgWidth}px</td>
                  </tr>
                  <tr>
                    <th>Height</th>
                    <td>{imgHeight}px</td>
                  </tr>
                  <tr>
                    <th>Maximum Zoom Level</th>
                    <td>
                      {maxZoomLevel === 0 ? (
                        <span className={"text-red-400"}>
                          The selected image is too small to divide into tiles!
                        </span>
                      ) : (
                        <span>{maxZoomLevel}</span>
                      )}
                    </td>
                  </tr>
                  <tr>
                    <th>Tile Size at Max Zoom</th>
                    <td>{imgWidth / Math.pow(2, maxZoomLevel)}px</td>
                  </tr>
                </tbody>
              </table>
            </div>
            {/* Image Preview */}
            {imageSrc && (
              <div className="bg-slate-700 p-4 rounded-lg">
                <div className="text-xl mb-2">Image</div>
                <div className="flex justify-center items-center justify-items-center">
                  <img
                    src={chosenImage.src}
                    alt="Selected Map Preview"
                    className="max-w-[40rem] h-auto rounded-lg"
                  />
                </div>
              </div>
            )}
            <div className={"flex gap-4 justify-center items-center mt-4"}>
              Output Format:
              <div className={"flex justify-center gap-2"}>
                {".png"}
                <Switch
                  onCheckedChange={(checked) => {
                    setOutputFormat(checked ? "webp" : "png");
                  }}
                />
                {".webp"}
              </div>
            </div>
            <Button
              variant={"secondary"}
              disabled={downloadDisabled}
              onClick={startTiling}
            >
              Download Tiled Map
            </Button>
            {downloadDisabled && (
              <div className={"flex flex-col gap-2 mt-2 items-center"}>
                <span className={"flex-nowrap"}>Processing...</span>
                <Progress className="w-full" value={progress} />
              </div>
            )}
          </>
        )}
        <div className={"flex justify-center items-center mt-4"}>
          <div className={"text-sm"}>
            Developed by
            <Link
              className={
                "inline-flex items-center gap-1 rounded-lg p-1.5 font-bold text-blue-400"
              }
              href={"https://github.com/EKO-GITHUB"}
            >
              Murad Tochiev
              <img
                className={"rounded-lg"}
                width={25}
                height={25}
                src={"https://avatars.githubusercontent.com/u/25434461?v=4"}
                alt={"mtochiev profile icon"}
              />
              <span className={"text-white"}>{"@"}</span>
              <GithubIcon className={"text-white"} width={25} height={25} />
            </Link>
          </div>
        </div>
      </div>
    </main>
  );
}

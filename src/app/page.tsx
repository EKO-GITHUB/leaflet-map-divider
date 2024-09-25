"use client";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import React, { useRef, useState } from "react";
import { Dropzone } from "@/components/ui/dropzone";
import { GithubIcon, UploadIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import JSZip from "jszip";
import Link from "next/link";

type New_Image = {
  image: HTMLImageElement;
  new_width: number;
  new_height: number;
};

export default function Home() {
  const inputRef = useRef<HTMLInputElement>(null);
  let [chosen_image, setChosenImage] = useState<HTMLImageElement | null>(null);
  let [status_message, setStatus_message] = useState<string | null>(null);
  let [img_width, setImg_width] = useState<number>(0);
  let [img_height, setImg_height] = useState<number>(0);
  let [tile_width_display, setTile_width_display] = useState<number>(0);
  let [tile_height_display, setTile_height_display] = useState<number>(0);
  let [file_name, setFileName] = useState<string | null>(null);
  let [zoom_level_display, setZoom_level_display] = useState<number>(0);
  let [download_disabled, setDownloadDisabled] = useState<boolean>(false);
  let [progress, setProgress] = useState<number>(0);
  let [current_zoom_level, setCurrent_zoom_level] = useState<number>(0);
  let [zip, setZip] = useState<JSZip | null>(null);
  let zoom_level = 0;
  let tile_width = 0;
  let tile_height = 0;

  const handleChange = (files: FileList | null) => {
    const file = files?.[0];

    if (file) {
      if (!file.type.startsWith("image")) {
        let file_type = file.type != "" ? file.type : "unknown";
        setStatus_message(
          "File type: " +
            file_type +
            " is not supported, select an image instead!",
        );
        setChosenImage(null);
        setFileName(null);
      } else {
        setFileName(file.name);
        let img = new Image();
        let objectUrl = URL.createObjectURL(file);
        img.onload = function () {
          if (img.naturalHeight != img.naturalWidth) {
            setStatus_message("The selected image is not a square!");
            setChosenImage(null);
            setFileName(null);
          }
          if (img.naturalHeight < 256 || img.naturalWidth < 256) {
            setStatus_message(
              "The selected image is too small to process! Width and height must be at least 256px",
            );
            setChosenImage(null);
            setFileName(null);
          }
          if (img.naturalHeight % 2 > 0 || img.naturalWidth % 2 > 0) {
            setStatus_message(
              "The image has an odd width or height, it can not be divided!",
            );
            setChosenImage(null);
            setFileName(null);
          }
          setImg_height(img.naturalHeight);
          setImg_width(img.naturalWidth);

          let original_width = img.naturalWidth;
          let original_height = img.naturalHeight;
          let tmp_width = img.naturalWidth;
          while (tmp_width % 2 == 0 && tmp_width > 256) {
            if (tmp_width > 256) {
              tmp_width = tmp_width / 2;
              zoom_level++;
            }
          }
          if (zoom_level > 0) {
            tile_width = Math.round(original_width / Math.pow(2, zoom_level));
            tile_height = Math.round(original_height / Math.pow(2, zoom_level));
          }

          setZoom_level_display(zoom_level);
          setTile_height_display(tile_height);
          setTile_width_display(tile_width);
          URL.revokeObjectURL(objectUrl);
        };
        img.src = objectUrl;
        setChosenImage(img);
        setStatus_message(null);
      }
    }
  };

  function handleClickUpload() {
    inputRef.current?.click();
  }

  async function start_tiling() {
    setDownloadDisabled(true);
    const zip = new JSZip();
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");

    for (
      let zoom_level_curr = 0;
      zoom_level_curr < zoom_level_display;
      zoom_level_curr++
    ) {
      setCurrent_zoom_level(zoom_level_curr);
      let image_to_tile: New_Image = await resize_image_to_zoom_level(
        zoom_level_curr,
        chosen_image!,
      );
      const tilesX = Math.ceil(image_to_tile.new_width / tile_width_display);
      const tilesY = Math.ceil(image_to_tile.new_height / tile_height_display);
      for (let x = 0; x < tilesX; x++) {
        for (let y = 0; y < tilesY; y++) {
          const startX = x * tile_width_display;
          const startY = y * tile_height_display;

          canvas.width = tile_width_display;
          canvas.height = tile_height_display;

          ctx!.clearRect(0, 0, tile_width_display, tile_height_display);
          ctx!.drawImage(
            image_to_tile!.image,
            startX,
            startY,
            tile_width_display,
            tile_height_display,
            0,
            0,
            tile_width_display,
            tile_height_display,
          );

          const dataURL = canvas.toDataURL("image/png");
          const base64Data = dataURL.replace(
            /^data:image\/(png|jpg);base64,/,
            "",
          );
          zip.file(`${zoom_level_curr}/${y}/${x}.png`, base64Data, {
            base64: true,
          });
        }
        setProgress(Math.floor((x / tilesX) * 100));
      }
    }
    setZip(zip);

    if (zip) {
      zip.generateAsync({ type: "blob" }).then((content) => {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(content);
        a.download = "tiled_map.zip";
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
      });
    }
    setDownloadDisabled(false);
  }

  function resize_image_to_zoom_level(
    zoom_level: number,
    image: HTMLImageElement,
  ): Promise<New_Image> {
    return new Promise((resolve, reject) => {
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d");
      let new_width: number;
      let new_height: number;

      if (zoom_level == 0) {
        new_width = tile_width_display;
        new_height = tile_height_display;
        canvas.width = new_width;
        canvas.height = new_height;
      } else {
        new_width = Math.floor(tile_width_display * Math.pow(2, zoom_level));
        new_height = Math.floor(tile_height_display * Math.pow(2, zoom_level));
        canvas.width = new_width;
        canvas.height = new_height;
      }

      ctx!.drawImage(image, 0, 0, new_width, new_height);

      const resizedImage = new Image();
      resizedImage.src = canvas.toDataURL();
      resizedImage.onload = () =>
        resolve({
          image: resizedImage,
          new_height: new_height,
          new_width: new_width,
        });
      resizedImage.onerror = reject; // Handle errors if the image fails to load
    });
  }

  return (
    <main className="min-h-screen bg-slate-800">
      <div className={"grid justify-center items-start text-white gap-4 p-12"}>
        <div
          className={
            "bg-slate-900 flex justify-center items-center justify-items-center text-4xl rounded-lg p-6 gap-4"
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
            <div className="grid items-center justify-items-center justify-center gap-2">
              <Dropzone
                ref={inputRef}
                onChange={handleChange}
                multiple={false}
                accept="image/*"
              >
                <div className="grid items-center justify-items-center justify-center gap-y-4">
                  <div className="flex justify-around w-full">
                    <Button onClick={handleClickUpload}>Select map</Button>
                    <Button
                      variant={"destructive"}
                      onClick={() => {
                        setChosenImage(null);
                        setFileName(null);
                        setStatus_message(null);
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
                  {file_name ? (
                    <span className={"text-green-500"}>{file_name}</span>
                  ) : (
                    <div
                      className={
                        "grid gap-1 justify-center items-center justify-items-center text-red-400"
                      }
                    >
                      {status_message != null && (
                        <span className={"max-w-[40rem]"}>
                          {status_message}
                        </span>
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
              <li>Each tile has a minimum width of 128px.</li>
              <li>
                The source image must be a square and at least 128px wide.
              </li>
              <li>
                The maximum zoom level is calculated by dividing the image in
                half until it reaches an odd width or is smaller than 128px.
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
        {chosen_image != null && (
          <div className={"bg-slate-700 p-2 rounded-lg"}>
            <table>
              <tbody className={"[&_tr_th]:text-start [&_tr_th]:p-1"}>
                <tr>
                  <th>Width</th>
                  <td>{img_width}px</td>
                </tr>
                <tr>
                  <th>Height</th>
                  <td>{img_height}px</td>
                </tr>
                <tr>
                  <th>Maximum Zoom Level</th>
                  <td>
                    {zoom_level_display == 0 ? (
                      <span className={"text-red-400"}>
                        The selected image is too small to divide into tiles!
                      </span>
                    ) : (
                      <span>{zoom_level_display}</span>
                    )}
                  </td>
                </tr>
                <tr>
                  <th>Tile Width</th>
                  <td>{tile_width_display}px</td>
                </tr>
                <tr>
                  <th>Tile Height</th>
                  <td>{tile_height_display}px</td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
        {chosen_image != null && (
          <>
            <Button
              variant={"secondary"}
              disabled={download_disabled}
              onClick={start_tiling}
            >
              Download Tiled Map
            </Button>
            {download_disabled && (
              <div className={"flex gap-2"}>
                <span className={"flex-nowrap"}>
                  Zoom Lvl: {current_zoom_level}
                </span>
                <Progress value={progress} />
              </div>
            )}
          </>
        )}
        <div
          className={"flex justify-center items-center justify-items-center"}
        >
          <div className={"text-sm"}>
            Developed by
            <Link
              className={
                "inline-flex justify-items-center gap-1 rounded-lg  p-1.5 font-bold text-blue-400"
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

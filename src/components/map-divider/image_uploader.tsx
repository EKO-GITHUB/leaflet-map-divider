import React, { useRef } from "react";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dropzone } from "@/components/ui/dropzone";
import { AlertCircleIcon, CheckCircleIcon, UploadIcon } from "lucide-react";

interface ImageUploaderProps {
  on_image_upload: (files: FileList | null) => void;
  on_reset: () => void;
  file_name: string | null;
  error: string | null;
  is_loading: boolean;
}

export function ImageUploader({
                                on_image_upload,
                                on_reset,
                                file_name,
                                error,
                                is_loading
                              }: ImageUploaderProps) {
  const input_ref = useRef<HTMLInputElement>(null);

  const handle_click_upload = () => {
    input_ref.current?.click();
  };

  const handle_reset = () => {
    if (input_ref.current) {
      input_ref.current.value = "";
    }
    on_reset();
  };

  return (
    <Card className="w-full max-w-4xl bg-white/5 backdrop-blur-lg rounded-2xl border border-white/10 shadow-2xl">
      <CardHeader className="pb-6">
        <CardTitle className="text-center">
          <div className="flex items-center justify-center gap-3 text-2xl">
            <div className="p-3 rounded-full bg-gradient-to-r from-emerald-500 to-blue-500">
              <UploadIcon className="text-white" size={24} />
            </div>
            <span className="bg-gradient-to-r from-emerald-400 to-blue-400 bg-clip-text text-transparent font-bold">
              Select Your Map Image
            </span>
          </div>
        </CardTitle>
      </CardHeader>

      <CardContent className="px-8">
        <div className="grid items-center justify-items-center gap-6">
          <Dropzone
            ref={input_ref}
            onChange={on_image_upload}
            multiple={false}
            accept="image/*"
            disabled={is_loading}
            className="w-full"
          >
            <div className={`
              grid items-center justify-items-center gap-6 p-12 rounded-xl border-2 border-dashed transition-all duration-300
              ${is_loading ? "border-blue-400/50 bg-blue-500/10" : "border-white/30 hover:border-white/50 hover:bg-white/5"}
            `}>
              <div className="flex flex-col sm:flex-row justify-center items-center gap-4 w-full">
                <Button
                  onClick={handle_click_upload}
                  disabled={is_loading}
                  className="bg-gradient-to-r from-emerald-500 to-blue-500 hover:from-emerald-600 hover:to-blue-600 text-white border-0 px-8 py-3 rounded-lg font-semibold transition-all duration-300 transform hover:scale-105 disabled:opacity-50 disabled:transform-none"
                >
                  {is_loading ? "Processing..." : "Choose Image"}
                </Button>
                <Button
                  onClick={handle_reset}
                  disabled={is_loading || !file_name}
                  className={`
                    border-2 px-8 py-3 rounded-lg font-semibold transition-all duration-300 transform disabled:opacity-50 disabled:transform-none
                    ${file_name && !is_loading
                    ? "bg-red-500/20 border-red-500/50 text-red-300 hover:bg-red-500/30 hover:border-red-500/70 hover:scale-105"
                    : "bg-transparent border-white/20 text-white/40 cursor-not-allowed"
                  }
                  `}
                >
                  Reset
                </Button>
              </div>

              <div className="flex items-center gap-3">
                <div className="rounded-full bg-white/20 p-3">
                  <UploadIcon className="text-white/80" size={20} />
                </div>
                <p className="text-lg font-medium text-white/90">
                  or drag and drop your image file here
                </p>
              </div>

              <div className="text-center">
                {file_name ? (
                  <div
                    className="flex items-center gap-2 px-4 py-2 bg-emerald-500/20 border border-emerald-500/30 rounded-lg">
                    <CheckCircleIcon className="text-emerald-400" size={20} />
                    <span className="text-emerald-300 font-medium">{file_name}</span>
                  </div>
                ) : error ? (
                  <div
                    className="flex items-center gap-2 px-4 py-2 bg-red-500/20 border border-red-500/30 rounded-lg max-w-md">
                    <AlertCircleIcon className="text-red-400 flex-shrink-0" size={20} />
                    <span className="text-red-300 text-sm">{error}</span>
                  </div>
                ) : (
                  <div className="text-white/60">
                    No file selected
                  </div>
                )}
              </div>
            </div>
          </Dropzone>
        </div>
      </CardContent>

      <CardFooter className="px-8 pb-8">
        <div className="w-full bg-white/5 rounded-xl p-6 border border-white/10">
          <h3 className="text-lg font-semibold mb-4 text-white/90">Requirements & Tips</h3>
          <div className="grid md:grid-cols-2 gap-4 text-sm text-white/70">
            <div className="space-y-2">
              <div className="flex items-start gap-2">
                <div className="w-1.5 h-1.5 rounded-full bg-emerald-400 mt-2 flex-shrink-0"></div>
                <span>Perfect for <a className="text-emerald-400 hover:text-emerald-300 transition-colors"
                                     href="https://leafletjs.com/" target="_blank"
                                     rel="noopener noreferrer">LeafletJS</a> maps</span>
              </div>
              <div className="flex items-start gap-2">
                <div className="w-1.5 h-1.5 rounded-full bg-emerald-400 mt-2 flex-shrink-0"></div>
                <span>100% local processing - your image never leaves your device</span>
              </div>
              <div className="flex items-start gap-2">
                <div className="w-1.5 h-1.5 rounded-full bg-emerald-400 mt-2 flex-shrink-0"></div>
                <span>Minimum tile size: 128px</span>
              </div>
            </div>
            <div className="space-y-2">
              <div className="flex items-start gap-2">
                <div className="w-1.5 h-1.5 rounded-full bg-blue-400 mt-2 flex-shrink-0"></div>
                <span>Image must be square (equal width & height)</span>
              </div>
              <div className="flex items-start gap-2">
                <div className="w-1.5 h-1.5 rounded-full bg-blue-400 mt-2 flex-shrink-0"></div>
                <span>Dimensions must be even numbers for proper tiling</span>
              </div>
              <div className="flex items-start gap-2">
                <div className="w-1.5 h-1.5 rounded-full bg-blue-400 mt-2 flex-shrink-0"></div>
                <span>Choose sizes divisible by powers of 2 for best results</span>
              </div>
            </div>
          </div>
        </div>
      </CardFooter>
    </Card>
  );
}
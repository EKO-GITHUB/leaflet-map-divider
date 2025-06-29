import React, { ChangeEvent, useState } from "react";

import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

interface DropzoneProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "onChange"> {
  onChange: (files: FileList | null) => void;
}

export const Dropzone = React.forwardRef<HTMLInputElement, DropzoneProps>(({
                                                                             className,
                                                                             onChange,
                                                                             children,
                                                                             ...props
                                                                           }, ref) => {
  const [isDragging, setIsDragging] = useState(false);

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    onChange(e.dataTransfer.files);
  };

  const handleDragLeave = () => {
    setIsDragging(false);
  };

  const handleChange = (e: ChangeEvent<HTMLInputElement>) => {
    onChange(e.target.files);
  };

  return (<div
    className={cn({
      "rounded-md border-dashed border-2 border-green-400": isDragging
    }, className)}
    onDragOver={handleDragOver}
    onDrop={handleDrop}
    onDragLeave={handleDragLeave}
  >
    {children}
    <Input
      ref={ref}
      type="file"
      className="hidden"
      onChange={handleChange}
      {...props}
    />
  </div>);
});

Dropzone.displayName = "Dropzone";

import React, { useRef, useState } from 'react';
import { UploadCloud, FileType } from 'lucide-react';

interface DropzoneProps {
  onFileSelect: (files: File[]) => void;
  accept: string;
  label: string;
  multiple?: boolean;
  icon?: React.ReactNode;
}

export const Dropzone: React.FC<DropzoneProps> = ({ 
  onFileSelect, 
  accept, 
  label, 
  multiple = false,
  icon
}) => {
  const [isDragOver, setIsDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      onFileSelect(Array.from(e.dataTransfer.files));
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      onFileSelect(Array.from(e.target.files));
    }
  };

  return (
    <div
      onClick={() => inputRef.current?.click()}
      onDragOver={(e) => { e.preventDefault(); setIsDragOver(true); }}
      onDragLeave={() => setIsDragOver(false)}
      onDrop={handleDrop}
      className={`
        border-2 border-dashed rounded-xl p-8 cursor-pointer transition-all duration-200 flex flex-col items-center justify-center text-center group
        ${isDragOver 
          ? 'border-indigo-500 bg-indigo-50' 
          : 'border-slate-300 hover:border-indigo-400 hover:bg-slate-50'
        }
      `}
    >
      <input
        ref={inputRef}
        type="file"
        className="hidden"
        accept={accept}
        multiple={multiple}
        onChange={handleChange}
      />
      <div className={`mb-4 p-3 rounded-full ${isDragOver ? 'bg-indigo-100 text-indigo-600' : 'bg-slate-100 text-slate-500 group-hover:bg-indigo-50 group-hover:text-indigo-500'}`}>
        {icon || <UploadCloud size={24} />}
      </div>
      <p className="text-sm font-medium text-slate-700">{label}</p>
      <p className="text-xs text-slate-400 mt-1">
        Drag & drop or click to upload
      </p>
    </div>
  );
};
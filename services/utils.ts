import { Product } from '../types';

export const parseCSV = (text: string): Product[] => {
  const lines = text.split('\n').filter(line => line.trim() !== '');
  // Assuming simple CSV: ID, English Name, Local/Alt Name, Unit, Category
  // Skip header
  const data = lines.slice(1).map((line, index) => {
    // Handle quotes in CSV if necessary, simple split for prototype
    const cols = line.split(',').map(c => c.trim().replace(/^"|"$/g, ''));
    
    // Fallback if CSV structure varies, but mapping to our type
    return {
      id: cols[0] || `TEMP-${index}`,
      name: cols[1] || 'Unknown',
      localName: cols[2] || '',
      unit: cols[3] || 'pcs',
      category: cols[4] || 'General'
    };
  });
  return data;
};

export const fileToBase64 = (file: File): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = () => {
      const result = reader.result as string;
      // Remove data:image/jpeg;base64, prefix
      const base64 = result.split(',')[1];
      resolve(base64);
    };
    reader.onerror = error => reject(error);
  });
};

export const preprocessImage = (file: File): Promise<string[]> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        // OpenAI Vision Optimization:
        // - Upscale small images to ensure text is legible (min width 1024px).
        // - Slice long images to avoid downscaling (max height 1500px).
        
        let width = img.width;
        let height = img.height;
        
        // 1. Upscale if too narrow (improves OCR for small text)
        const MIN_WIDTH = 1024;
        let scale = 1;
        if (width < MIN_WIDTH) {
            scale = MIN_WIDTH / width;
            width = Math.round(width * scale);
            height = Math.round(height * scale);
        }
        
        const MAX_CHUNK_HEIGHT = 1500; // Safe limit below 2048
        const chunks: string[] = [];
        let currentY = 0;
        
        const canvas = document.createElement('canvas');
        canvas.width = width;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          reject(new Error('Canvas context not available'));
          return;
        }
        
        // High quality scaling settings
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';

        while (currentY < height) {
          const remainingHeight = height - currentY;
          const chunkHeight = Math.min(MAX_CHUNK_HEIGHT, remainingHeight);
          
          canvas.height = chunkHeight;
          ctx.clearRect(0, 0, width, chunkHeight);
          
          // Draw slice from original image, scaled
          // Source Y: currentY / scale
          // Source H: chunkHeight / scale
          const sourceY = currentY / scale;
          const sourceH = chunkHeight / scale;
          
          ctx.drawImage(
            img, 
            0, sourceY, img.width, sourceH, // Source
            0, 0, width, chunkHeight        // Destination
          );
          
          // High quality JPEG
          const dataUrl = canvas.toDataURL('image/jpeg', 0.95);
          chunks.push(dataUrl.split(',')[1]);
          
          currentY += chunkHeight;
        }
        
        resolve(chunks);
      };
      img.onerror = reject;
      img.src = e.target?.result as string;
    };
    reader.onerror = reject;
  });
};

export const preprocessForOCR = (base64: string): Promise<string> => {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      // Scale up for better OCR (target width ~2500px for A4 receipts)
      // Tesseract works best when characters are large (20px+ height)
      const targetWidth = 2500;
      const scale = img.width < targetWidth ? targetWidth / img.width : 1;
      const width = Math.round(img.width * scale);
      const height = Math.round(img.height * scale);

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        reject(new Error('Canvas context not available'));
        return;
      }
      
      // High quality scaling
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, width, height);
      
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const data = imageData.data;
      
      // Binarization (Thresholding)
      // Converting to pure black and white helps Tesseract separate text from background noise
      const threshold = 180; // Slightly higher threshold for faint text on receipts
      
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        
        // Luminance
        const gray = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        
        // Simple Threshold
        const val = gray > threshold ? 255 : 0;
        
        data[i] = val;
        data[i + 1] = val;
        data[i + 2] = val;
      }
      
      ctx.putImageData(imageData, 0, 0);
      resolve(canvas.toDataURL('image/jpeg', 0.9).split(',')[1]);
    };
    img.onerror = reject;
    img.src = `data:image/jpeg;base64,${base64}`;
  });
};

export const downloadJSON = (data: any, filename: string) => {
  const jsonStr = JSON.stringify(data, null, 2);
  const blob = new Blob([jsonStr], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
};

// --- Vector Utils ---

export const cosineSimilarity = (vecA: number[], vecB: number[]): number => {
  const dotProduct = vecA.reduce((sum, a, i) => sum + a * vecB[i], 0);
  const magnitudeA = Math.sqrt(vecA.reduce((sum, a) => sum + a * a, 0));
  const magnitudeB = Math.sqrt(vecB.reduce((sum, b) => sum + b * b, 0));
  return dotProduct / (magnitudeA * magnitudeB);
};

export const findNearestNeighbors = (
  queryEmbedding: number[],
  database: Product[],
  k: number = 5
): Product[] => {
  if (!database.some(p => p.embedding)) return [];
  
  return database
    .filter(p => p.embedding)
    .map(p => ({
      item: p,
      similarity: cosineSimilarity(queryEmbedding, p.embedding!)
    }))
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, k)
    .map(result => result.item);
};
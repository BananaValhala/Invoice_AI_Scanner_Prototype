import { Product } from '../types';

export const parseCSV = (text: string): Product[] => {
  const lines = text.split('\n').filter(line => line.trim() !== '');
  if (lines.length < 2) return [];

  // Parse Header
  const headerLine = lines[0];
  const headers = headerLine.split(',').map(h => h.trim().replace(/^"|"$/g, '').toLowerCase());

  // Helper to find column index by name (fuzzy match)
  const findCol = (keywords: string[]) => headers.findIndex(h => keywords.some(k => h.includes(k)));

  const idIdx = findCol(['id', 'code', 'sku']);
  const nameIdx = findCol(['name', 'product', 'description', 'english']);
  const localNameIdx = findCol(['local', 'alt', 'native', 'thai', 'chinese']);
  const unitIdx = findCol(['unit', 'uom']);
  const categoryIdx = findCol(['category', 'group', 'type']);

  // Skip header
  const data = lines.slice(1).map((line, index) => {
    // Handle quotes in CSV if necessary, simple split for prototype
    // Note: A robust CSV parser (like PapaParse) is better for production, 
    // but for this prototype we'll do a basic split that handles some quotes.
    const cols: string[] = [];
    let inQuote = false;
    let current = '';
    
    for (let i = 0; i < line.length; i++) {
        const char = line[i];
        if (char === '"') {
            inQuote = !inQuote;
        } else if (char === ',' && !inQuote) {
            cols.push(current.trim().replace(/^"|"$/g, ''));
            current = '';
        } else {
            current += char;
        }
    }
    cols.push(current.trim().replace(/^"|"$/g, ''));

    // Capture all other columns as metadata
    const metadata: Record<string, string> = {};
    headers.forEach((h, i) => {
        if (i !== idIdx && i !== nameIdx && i !== localNameIdx && i !== unitIdx && i !== categoryIdx) {
            if (cols[i]) metadata[h] = cols[i];
        }
    });
    
    return {
      id: (idIdx >= 0 ? cols[idIdx] : cols[0]) || `TEMP-${index}`,
      name: (nameIdx >= 0 ? cols[nameIdx] : cols[1]) || 'Unknown',
      localName: (localNameIdx >= 0 ? cols[localNameIdx] : cols[2]) || '',
      unit: (unitIdx >= 0 ? cols[unitIdx] : cols[3]) || 'pcs',
      category: (categoryIdx >= 0 ? cols[categoryIdx] : cols[4]) || 'General',
      metadata: metadata // Store extra columns here
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
import { Product, InvoiceItem, ProcessedInvoice } from '../types';

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

// --- State Persistence (using IndexedDB for all data) ---

const DB_NAME = 'InvoiceAI_DB';
const DB_VERSION = 3;
const STATE_STORE = 'appState';

// IndexedDB helpers for storing all app data
const openIDB = (): Promise<IDBDatabase> => {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    
    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STATE_STORE)) {
        db.createObjectStore(STATE_STORE, { keyPath: 'key' });
      }
    };
  });
};

export interface SavedState {
  key: string; // Always 'appState'
  database: Product[];
  aiConfig: {
    provider: string;
    apiKey: string;
  };
  invoices: Array<{
    id: string;
    fileName: string;
    status: string;
    items: InvoiceItem[];
    timestamp: string;
    error?: string;
    processTimeMs?: number;
  }>;
  savedAt: string;
}

// Save state to IndexedDB (stores everything including database and embeddings)
export const saveAppState = async (database: Product[], aiConfig: { provider: string; apiKey: string }, invoices: ProcessedInvoice[]): Promise<void> => {
  try {
    // Strip rawImageBase64 from invoices
    const invoicesWithoutImages = invoices.map(inv => {
      const { rawImageBase64, ...rest } = inv;
      return rest;
    });

    // Security: Don't store API key (XSS vulnerability)
    const state: SavedState = {
      key: 'appState',
      database,
      aiConfig: {
        provider: aiConfig.provider,
        apiKey: '' // API key intentionally not stored
      },
      invoices: invoicesWithoutImages,
      savedAt: new Date().toISOString()
    };

    const db = await openIDB();
    const tx = db.transaction(STATE_STORE, 'readwrite');
    tx.objectStore(STATE_STORE).put(state);
    
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => {
        console.log('App state saved to IndexedDB');
        resolve();
      };
      tx.onerror = () => {
        console.error('Failed to save app state:', tx.error);
        reject(tx.error);
      };
    });
    
    return; // Explicitly return void
  } catch (error) {
    console.error('Failed to save app state:', error);
    return;
  }
};

// Load state from IndexedDB
export const loadAppState = async (): Promise<SavedState | null> => {
  try {
    const db = await openIDB();
    const tx = db.transaction(STATE_STORE, 'readonly');
    const store = tx.objectStore(STATE_STORE);
    
    const request = store.get('appState');
    
    return new Promise((resolve, reject) => {
      request.onsuccess = () => {
        const result = request.result;
        if (result) {
          console.log('App state loaded from IndexedDB:', result.savedAt);
        }
        resolve(result || null);
      };
      request.onerror = () => reject(request.error);
    });
  } catch (error) {
    console.error('Failed to load app state:', error);
    return null;
  }
};

// Clear all app state
export const clearAppState = async (): Promise<void> => {
  try {
    const db = await openIDB();
    const tx = db.transaction(STATE_STORE, 'readwrite');
    tx.objectStore(STATE_STORE).delete('appState');
    
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    
    console.log('App state cleared from IndexedDB');
  } catch (error) {
    console.error('Failed to clear app state:', error);
  }
};

export const findNearestNeighbors = (
  queryEmbedding: number[],
  database: Product[],
  provider: string,
  k: number = 5
): Product[] => {
  if (!database.some(p => p.embeddings && p.embeddings[provider])) return [];
  
  return database
    .filter(p => p.embeddings && p.embeddings[provider])
    .map(p => ({
      item: p,
      similarity: cosineSimilarity(queryEmbedding, p.embeddings![provider])
    }))
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, k)
    .map(result => result.item);
};

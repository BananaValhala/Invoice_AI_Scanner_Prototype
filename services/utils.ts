import { Product, InvoiceItem, ProcessedInvoice } from '../types';

const DELIMITER_CANDIDATES = [',', ';', '\t', '|'] as const;

const stripUtf8Bom = (text: string): string => text.replace(/^\uFEFF/, '');

const parseDelimitedLine = (line: string, delimiter: string): string[] => {
  const cols: string[] = [];
  let current = '';
  let inQuote = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      // Escaped quote inside quoted field: ""
      if (inQuote && line[i + 1] === '"') {
        current += '"';
        i += 1;
        continue;
      }
      inQuote = !inQuote;
      continue;
    }

    if (char === delimiter && !inQuote) {
      cols.push(current.trim());
      current = '';
      continue;
    }

    current += char;
  }

  cols.push(current.trim());
  return cols.map(value => value.replace(/^"|"$/g, ''));
};

const detectDelimiter = (line: string): string => {
  const scores = DELIMITER_CANDIDATES.map((delimiter) => ({
    delimiter,
    score: parseDelimitedLine(line, delimiter).length
  }));

  return scores.sort((a, b) => b.score - a.score)[0].delimiter;
};

const parseDelimitedText = (text: string, delimiter: string): string[][] => {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuote = false;

  const flushField = () => {
    row.push(field.trim().replace(/^"|"$/g, ''));
    field = '';
  };

  const flushRow = () => {
    // Ignore fully empty rows
    if (row.some(col => col.length > 0)) rows.push(row);
    row = [];
  };

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    if (char === '"') {
      if (inQuote && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else {
        inQuote = !inQuote;
      }
      continue;
    }

    if (char === delimiter && !inQuote) {
      flushField();
      continue;
    }

    if ((char === '\n' || char === '\r') && !inQuote) {
      // Handle CRLF as a single row break.
      if (char === '\r' && text[i + 1] === '\n') i += 1;
      flushField();
      flushRow();
      continue;
    }

    field += char;
  }

  // Flush tail
  if (field.length > 0 || row.length > 0) {
    flushField();
    flushRow();
  }

  return rows;
};

const normalizeHeader = (header: string): string =>
  header
    .trim()
    .replace(/^"|"$/g, '')
    .toLowerCase()
    .replace(/[\s-]+/g, '_');

const findColumnExactFirst = (
  headers: string[],
  exactAliases: string[],
  fuzzyAliases: string[] = exactAliases,
  exclude: string[] = []
): number => {
  const exactSet = new Set(exactAliases.map(a => a.toLowerCase()));
  const excludeSet = new Set(exclude.map(e => e.toLowerCase()));

  const exactIndex = headers.findIndex(h => exactSet.has(h));
  if (exactIndex >= 0) return exactIndex;

  return headers.findIndex(h =>
    !excludeSet.has(h) && fuzzyAliases.some(alias => h.includes(alias.toLowerCase()))
  );
};

const safeParseNameObject = (value: string): Record<string, string> | null => {
  const text = value?.trim();
  if (!text || (!text.startsWith('{') && !text.startsWith('['))) return null;
  try {
    const parsed = JSON.parse(text);
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') return null;
    const normalized: Record<string, string> = {};
    Object.entries(parsed).forEach(([k, v]) => {
      if (typeof v === 'string' && v.trim()) normalized[k.toLowerCase()] = v.trim();
    });
    return Object.keys(normalized).length > 0 ? normalized : null;
  } catch {
    return null;
  }
};

const pickBestName = (nameObj: Record<string, string>, fallbacks: string[]): string => {
  for (const key of fallbacks) {
    if (nameObj[key]) return nameObj[key];
  }
  const first = Object.values(nameObj)[0];
  return first || 'Unknown';
};

export const normalizeTextForMatch = (input: string): string => {
  if (!input) return '';

  // NFKC handles full-width/half-width variants and compatibility forms.
  let normalized = input.normalize('NFKC');

  // Unify common Japanese and full-width bracket variants.
  normalized = normalized
    .replace(/[（［｛【〔〈《]/g, '(')
    .replace(/[）］｝】〕〉》]/g, ')')
    .replace(/[「『]/g, '"')
    .replace(/[」』]/g, '"');

  // Collapse repeated whitespace and normalize spacing around brackets.
  normalized = normalized
    .replace(/\s+/g, ' ')
    .replace(/\s*\(\s*/g, '(')
    .replace(/\s*\)\s*/g, ') ')
    .trim();

  return normalized;
};

const isDeletedValue = (value: string | undefined): boolean => {
  if (!value) return false;
  return /^(1|true|yes|y|deleted)$/i.test(value.trim());
};

const getMetadataValue = (metadata: Record<string, string> | undefined, key: string): string | undefined => {
  if (!metadata) return undefined;
  if (metadata[key] !== undefined) return metadata[key];

  const target = key.toLowerCase();
  const found = Object.entries(metadata).find(([k]) =>
    k.toLowerCase().replace(/[\s-]+/g, '_') === target
  );
  return found?.[1];
};

export const isDeletedProduct = (product: Product): boolean => {
  const rawValue =
    getMetadataValue(product.metadata, 'is_deleted') ??
    getMetadataValue(product.metadata, 'deleted') ??
    getMetadataValue(product.metadata, 'isdeleted');
  return isDeletedValue(rawValue);
};

const findKey = (obj: Record<string, any>, aliases: string[]): string | undefined => {
  const keys = Object.keys(obj);
  const normalized = keys.map(k => k.toLowerCase().replace(/[\s-]+/g, '_'));
  for (const alias of aliases) {
    const idx = normalized.indexOf(alias.toLowerCase());
    if (idx >= 0) return keys[idx];
  }
  for (const alias of aliases) {
    const idx = normalized.findIndex(k => k.includes(alias.toLowerCase()));
    if (idx >= 0) return keys[idx];
  }
  return undefined;
};

export const parseJSON = (text: string): Product[] => {
  const parsed = JSON.parse(text);
  const items: Record<string, any>[] = Array.isArray(parsed) ? parsed : (parsed.data ?? parsed.products ?? parsed.items ?? []);
  if (!items.length) return [];

  const sample = items[0];
  const idKey = findKey(sample, ['id', 'code', 'sku']);
  const nameKey = findKey(sample, ['name', 'product_name', 'product']);
  const localNameKey = findKey(sample, ['local_name', 'localName', 'alt_name', 'native_name', 'thai_name', 'chinese_name', 'japanese_name', 'ja_name']);
  const unitKey = findKey(sample, ['unit', 'units', 'uom']);
  const categoryKey = findKey(sample, ['category', 'group', 'type']);
  const knownKeys = new Set([idKey, nameKey, localNameKey, unitKey, categoryKey].filter(Boolean));

  return items.map((item, index) => {
    const rawName = nameKey ? String(item[nameKey] ?? '') : '';
    const parsedNameObj = typeof item[nameKey!] === 'object' && item[nameKey!] !== null && !Array.isArray(item[nameKey!])
      ? (Object.fromEntries(Object.entries(item[nameKey!]).filter(([, v]) => typeof v === 'string' && (v as string).trim()).map(([k, v]) => [k.toLowerCase(), (v as string).trim()])) as Record<string, string>)
      : safeParseNameObject(rawName);

    const primaryName = parsedNameObj
      ? pickBestName(parsedNameObj, ['en', 'english', 'name', 'ja', 'jp', 'japanese', 'zh', 'th'])
      : rawName || 'Unknown';
    const localNameFromObject = parsedNameObj
      ? pickBestName(parsedNameObj, ['ja', 'jp', 'japanese', 'zh', 'chinese', 'th', 'thai', 'local'])
      : '';
    const localNameRaw = localNameKey ? String(item[localNameKey] ?? '') : '';

    const metadata: Record<string, string> = {};
    Object.entries(item).forEach(([k, v]) => {
      if (!knownKeys.has(k) && v != null) {
        metadata[k.toLowerCase().replace(/[\s-]+/g, '_')] = typeof v === 'object' ? JSON.stringify(v) : String(v);
      }
    });
    if (parsedNameObj) metadata.name_json = typeof item[nameKey!] === 'object' ? JSON.stringify(item[nameKey!]) : rawName;

    return {
      id: idKey ? String(item[idKey] ?? `TEMP-${index}`) : `TEMP-${index}`,
      name: primaryName || 'Unknown',
      localName: localNameRaw || localNameFromObject || '',
      unit: unitKey ? String(item[unitKey] ?? 'pcs') : 'pcs',
      category: categoryKey ? String(item[categoryKey] ?? 'General') : 'General',
      metadata,
    };
  });
};

export const parseCSV = (text: string): Product[] => {
  const cleanedText = stripUtf8Bom(text || '').trim();
  if (!cleanedText) return [];

  const headerLine = cleanedText.split(/\r?\n/).find(line => line.trim() !== '');
  if (!headerLine) return [];

  const delimiter = detectDelimiter(headerLine);
  const rows = parseDelimitedText(cleanedText, delimiter);
  if (rows.length < 2) return [];

  const headers = rows[0].map(normalizeHeader);

  const idIdx = findColumnExactFirst(headers, ['id', 'code', 'sku'], ['id', 'code', 'sku']);
  const nameIdx = findColumnExactFirst(
    headers,
    ['name', 'product_name', 'product'],
    ['name', 'product', 'description', 'english'],
    ['scientific_name']
  );
  const localNameIdx = findColumnExactFirst(
    headers,
    ['local_name', 'localname', 'alt_name', 'native_name', 'thai_name', 'chinese_name', 'japanese_name', 'ja_name'],
    ['local', 'alt', 'native', 'thai', 'chinese', 'japanese', 'ja']
  );
  const unitIdx = findColumnExactFirst(headers, ['unit', 'units', 'uom'], ['unit', 'uom']);
  const categoryIdx = findColumnExactFirst(headers, ['category', 'group', 'type'], ['category', 'group', 'type']);
  const originsIdx = findColumnExactFirst(headers, ['origins', 'origin'], ['origin']);
  const isDeletedIdx = findColumnExactFirst(headers, ['is_deleted', 'deleted', 'isdeleted'], ['is_deleted', 'deleted']);

  // Skip header
  const data = rows.slice(1).map((cols, index) => {
    const rawName = (nameIdx >= 0 ? cols[nameIdx] : cols[1]) || '';
    const parsedNameObj = safeParseNameObject(rawName);
    const primaryName = parsedNameObj
      ? pickBestName(parsedNameObj, ['en', 'english', 'name', 'ja', 'jp', 'japanese', 'zh', 'th'])
      : rawName || 'Unknown';
    const localNameFromObject = parsedNameObj
      ? pickBestName(parsedNameObj, ['ja', 'jp', 'japanese', 'zh', 'chinese', 'th', 'thai', 'local'])
      : '';
    const localNameRaw = (localNameIdx >= 0 ? cols[localNameIdx] : cols[2]) || '';

    // Capture all other columns as metadata
    const metadata: Record<string, string> = {};
    headers.forEach((h, i) => {
        if (
          i !== idIdx &&
          i !== nameIdx &&
          i !== localNameIdx &&
          i !== unitIdx &&
          i !== categoryIdx
        ) {
            if (cols[i]) metadata[h] = cols[i];
        }
    });

    // Keep stable metadata keys for downstream logic.
    if (originsIdx >= 0 && cols[originsIdx]) metadata.origins = cols[originsIdx];
    if (isDeletedIdx >= 0 && cols[isDeletedIdx]) metadata.is_deleted = cols[isDeletedIdx];
    if (parsedNameObj) metadata.name_json = rawName;
    
    return {
      id: (idIdx >= 0 ? cols[idIdx] : cols[0]) || `TEMP-${index}`,
      name: primaryName || 'Unknown',
      localName: localNameRaw || localNameFromObject || '',
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
  if (!database.some(p => p.embeddings?.[provider] && !isDeletedProduct(p))) return [];
  
  return database
    // Explicit business rule: never retrieve deleted products.
    .filter(p => p.embeddings?.[provider] && !isDeletedProduct(p))
    .map(p => ({
      item: p,
      similarity: cosineSimilarity(queryEmbedding, p.embeddings![provider])
    }))
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, k)
    .map(result => result.item);
};

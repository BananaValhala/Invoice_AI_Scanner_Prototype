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
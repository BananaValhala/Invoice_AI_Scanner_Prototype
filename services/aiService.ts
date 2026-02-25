import { GoogleGenAI, Type } from "@google/genai";
import { Product, InvoiceItem, AIConfig } from "../types";
import { findNearestNeighbors } from "./utils";

// --- Providers Setup ---
const getEffectiveKey = (config: AIConfig) => {
  return (config.provider === 'gemini' && !config.apiKey) 
    ? process.env.API_KEY 
    : config.apiKey;
};

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Helper: Safe JSON Parse
const safeJSONParse = <T>(text: string, fallback: T): T => {
  try {
    // Remove markdown code blocks if present
    let cleanText = text.replace(/```json\s*|```/g, '').trim();
    // Attempt to find JSON array or object if surrounded by text
    const match = cleanText.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
    if (match) cleanText = match[0];
    return JSON.parse(cleanText);
  } catch (e) {
    console.warn("JSON Parse Warning:", e);
    return fallback;
  }
};

// --- 1. Embedding Generation ---

const embedTextGemini = async (text: string, apiKey: string): Promise<number[]> => {
  const ai = new GoogleGenAI({ apiKey });
  const response = await ai.models.embedContent({
    model: 'gemini-embedding-001',
    contents: { parts: [{ text }] }
  });
  return response.embeddings?.[0]?.values || [];
};

const embedTextOpenAI = async (text: string, apiKey: string): Promise<number[]> => {
  const response = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
    body: JSON.stringify({ model: "text-embedding-3-small", input: text })
  });
  const data = await response.json();
  if (data.error) throw new Error(data.error.message);
  return data.data[0].embedding;
};

// Retry helper for rate limits and transient server errors
const retryOperation = async <T>(
  operation: () => Promise<T>, 
  maxRetries = 5, 
  initialDelay = 1000
): Promise<T> => {
  let delay = initialDelay;
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await operation();
    } catch (error: any) {
      const msg = (error?.message || '').toLowerCase();
      const status = error?.status || error?.code;
      
      const isRetryable = 
        msg.includes('429') || 
        msg.includes('quota') || 
        msg.includes('resource_exhausted') ||
        msg.includes('internal error') ||
        msg.includes('500') ||
        msg.includes('503') ||
        status === 429 || 
        status === 500 || 
        status === 503;

      if (i === maxRetries - 1 || !isRetryable) throw error;
      
      console.warn(`Transient error (${status || msg}). Retrying in ${delay}ms...`);
      await sleep(delay);
      delay *= 2; // Exponential backoff
    }
  }
  throw new Error("Max retries exceeded");
};

// Helper: Batch processing for database
export const generateEmbeddingsForDatabase = async (
  products: Product[],
  config: AIConfig,
  onProgress?: (current: number, total: number) => void
): Promise<Product[]> => {
  const apiKey = getEffectiveKey(config);
  if (!apiKey) throw new Error("API Key required for indexing");

  const updatedProducts = [...products];
  
  // Serial processing to strictly respect rate limits
  for (let i = 0; i < updatedProducts.length; i++) {
    const product = updatedProducts[i];
    // Skip if already has embedding
    if (product.embedding && product.embedding.length > 0) continue;

    // Sanitize input
    const textToEmbed = `${product.name} ${product.localName} ${product.category || ''}`.trim();
    if (!textToEmbed) continue;
    
    try {
      const embedding = await retryOperation(async () => {
        if (config.provider === 'openai') {
          return await embedTextOpenAI(textToEmbed, apiKey);
        } else {
          // Default to Gemini
          const embedKey = config.provider === 'anthropic' ? process.env.API_KEY : apiKey;
          if (embedKey) {
             return await embedTextGemini(textToEmbed, embedKey);
          }
          return undefined;
        }
      });
      
      product.embedding = embedding;

    } catch (e) {
      console.error(`Failed to embed ${product.id}`, e);
      // Continue processing other items even if one fails
    }

    if (onProgress) {
      onProgress(i + 1, updatedProducts.length);
    }
    
    // Base delay between requests
    await sleep(200);
  }

  return updatedProducts;
};

// --- 2. Extraction (Phase 1) ---

const extractRawItems = async (imageBase64: string, config: AIConfig): Promise<Partial<InvoiceItem>[]> => {
  const apiKey = getEffectiveKey(config);
  if (!apiKey) throw new Error(`API Key required for ${config.provider}`);

  const prompt = `
    Extract all line items from this invoice image.
    Return a JSON object with a key "items" containing an array of:
    - raw_name (text as seen)
    - raw_quantity (number)
    - raw_price (total number)
    
    Do not attempt to normalize or map product names yet. Just extract raw text.
  `;

  return retryOperation(async () => {
    if (config.provider === 'openai') {
      const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: "gpt-4o", 
          messages: [
            { role: "system", content: "You are a precise OCR agent. Return JSON object." },
            { role: "user", content: [{ type: "text", text: prompt }, { type: "image_url", image_url: { url: `data:image/jpeg;base64,${imageBase64}` } }] }
          ],
          response_format: { type: "json_object" }
        })
      });
      const data = await response.json();
      if (data.error) throw new Error(data.error.message);
      const content = safeJSONParse(data.choices[0].message.content, { items: [] });
      return content.items || [];
      
    } else if (config.provider === 'anthropic') {
      const response = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json", "anthropic-dangerously-allow-browser": "true" },
          body: JSON.stringify({
            model: "claude-3-5-sonnet-20241022", max_tokens: 4096,
            messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: imageBase64 } }, { type: "text", text: prompt + " Return JSON." }] }]
          })
      });
      const data = await response.json();
      if (data.error) throw new Error(data.error.message);
      const text = data.content[0].text;
      const parsed = safeJSONParse(text, { items: [] });
      return Array.isArray(parsed) ? parsed : (parsed.items || []);

    } else {
      // Gemini
      const ai = new GoogleGenAI({ apiKey });
      const response = await ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: {
          parts: [{ inlineData: { mimeType: 'image/jpeg', data: imageBase64 } }, { text: prompt }]
        },
        config: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
               items: {
                  type: Type.ARRAY,
                  items: {
                    type: Type.OBJECT,
                    properties: {
                      raw_name: { type: Type.STRING },
                      raw_quantity: { type: Type.NUMBER },
                      raw_price: { type: Type.NUMBER }
                    }
                  }
               }
            }
          }
        }
      });
      const result = safeJSONParse(response.text || "{}", { items: [] });
      return result.items || [];
    }
  });
};

// --- 3. RAG Mapping (Phase 2 & 3) ---

const mapItemsWithRAG = async (
  rawItems: Partial<InvoiceItem>[], 
  database: Product[], 
  config: AIConfig
): Promise<InvoiceItem[]> => {
  const apiKey = getEffectiveKey(config);
  
  // A. Retrieval Step: Find candidates for each item
  const itemsWithCandidates = await Promise.all(rawItems.map(async (item) => {
    if (!item.raw_name) return { ...item, candidates: [] };
    
    // Embed the query
    let queryEmbedding: number[] = [];
    try {
        if (config.provider === 'openai') {
            queryEmbedding = await retryOperation(() => embedTextOpenAI(item.raw_name!, apiKey!));
        } else {
            const embedKey = config.provider === 'anthropic' ? process.env.API_KEY : apiKey;
            if (embedKey) {
                // Use retry for query embedding too
                queryEmbedding = await retryOperation(() => embedTextGemini(item.raw_name!, embedKey));
            }
        }
    } catch (e) { console.warn("Embedding failed for item", item.raw_name); }

    // Vector Search
    const candidates = queryEmbedding.length > 0 
        ? findNearestNeighbors(queryEmbedding, database, 5) // Top 5
        : []; 
        
    return { ...item, candidates };
  }));

  // B. Synthesis Step: Ask LLM to pick the best one
  // BATCHING: Split items into chunks to avoid output token limits and JSON truncation
  const CHUNK_SIZE = 8;
  const chunkedItems = [];
  for (let i = 0; i < itemsWithCandidates.length; i += CHUNK_SIZE) {
    chunkedItems.push(itemsWithCandidates.slice(i, i + CHUNK_SIZE));
  }

  let finalMappedResults: any[] = [];

  for (const chunk of chunkedItems) {
    const prompt = `
      You are a mapping agent. Map the RAW INVOICE ITEMS to the CANDIDATE PRODUCTS.
      
      Instructions:
      1. For each item, look at the provided "Candidates" (which were retrieved via vector search).
      2. Select the ID of the product that is the exact or logical match.
      3. If none of the candidates are a correct match, return matched_product_id: null.
      4. Provide a confidence score (0.0 - 1.0).

      ITEMS TO MAP:
      ${JSON.stringify(chunk.map((i: any) => ({
        raw_name: i.raw_name,
        raw_price: i.raw_price,
        candidates: i.candidates.map((c: Product) => ({
          id: c.id,
          name: c.name,
          localName: c.localName
        }))
      })), null, 2)}

      OUTPUT:
      Return a JSON Object with a key "mappings" containing an Array of { raw_name, matched_product_id, confidence_score }.
    `;

    // Process chunk with retry
    const chunkResults = await retryOperation(async () => {
      if (config.provider === 'openai') {
          const response = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
          body: JSON.stringify({
              model: "gpt-4o",
              messages: [{ role: "system", content: "Return strictly JSON object." }, { role: "user", content: prompt }],
              response_format: { type: "json_object" }
          })
          });
          const data = await response.json();
          const content = safeJSONParse(data.choices[0].message.content, { mappings: [] });
          return content.mappings || [];
      } else if (config.provider === 'anthropic') {
          const response = await fetch("https://api.anthropic.com/v1/messages", {
              method: "POST",
              headers: { "x-api-key": apiKey!, "anthropic-version": "2023-06-01", "content-type": "application/json", "anthropic-dangerously-allow-browser": "true" },
              body: JSON.stringify({
              model: "claude-3-5-sonnet-20241022", max_tokens: 4096,
              messages: [{ role: "user", content: prompt + " Return JSON Object." }]
              })
          });
          const data = await response.json();
          const text = data.content[0].text;
          const parsed = safeJSONParse(text, { mappings: [] });
          return parsed.mappings || [];
      } else {
          const ai = new GoogleGenAI({ apiKey: apiKey! });
          const response = await ai.models.generateContent({
          model: 'gemini-3-flash-preview',
          contents: { parts: [{ text: prompt }] },
          config: { responseMimeType: 'application/json' }
          });
          const parsed = safeJSONParse(response.text || "{}", { mappings: [] });
          return parsed.mappings || [];
      }
    });

    finalMappedResults = [...finalMappedResults, ...chunkResults];
  }

  // Merge results back
  return rawItems.map((raw, idx) => {
    // Find decision in mappedResults (matching by name primarily)
    const decision = finalMappedResults.find((m: any) => m.raw_name === raw.raw_name);
    
    return {
        raw_name: raw.raw_name!,
        raw_quantity: raw.raw_quantity || 0,
        raw_price: raw.raw_price || 0,
        matched_product_id: decision?.matched_product_id || null,
        confidence_score: decision?.confidence_score || 0
    };
  });
};

// --- Main Workflow ---

export const processInvoice = async (
  imageBase64: string,
  database: Product[],
  config: AIConfig
): Promise<InvoiceItem[]> => {
    // Phase 1: OCR
    const rawItems = await extractRawItems(imageBase64, config);
    if (rawItems.length === 0) return [];

    // Phase 2 & 3: RAG & Mapping
    const finalItems = await mapItemsWithRAG(rawItems, database, config);
    
    return finalItems;
};
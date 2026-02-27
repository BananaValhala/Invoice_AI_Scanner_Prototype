import { GoogleGenAI, Type } from "@google/genai";
import { Product, InvoiceItem, AIConfig } from "../types";
import { findNearestNeighbors } from "./utils";

// --- Providers Setup ---
const getEffectiveKey = (config: AIConfig) => {
  if (config.apiKey) return config.apiKey;
  
  if (config.provider === 'gemini') return process.env.API_KEY;
  if (config.provider === 'openai') return process.env.OPENAI_API_KEY;
  
  return '';
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
  
  // For OpenAI, we can parallelize more aggressively.
  // For Gemini, we still need to be careful with rate limits on the free tier.
  const BATCH_SIZE = config.provider === 'openai' ? 20 : 1; 
  
  for (let i = 0; i < updatedProducts.length; i += BATCH_SIZE) {
    const batch = updatedProducts.slice(i, i + BATCH_SIZE);
    
    // Optimization: Check if ALL items in this batch already have embeddings
    const allEmbedded = batch.every(p => p.embedding && p.embedding.length > 0);
    
    if (allEmbedded) {
        // Skip API calls and delay entirely for this batch
        if (onProgress) {
            // Update progress immediately but don't sleep
            onProgress(Math.min(i + BATCH_SIZE, updatedProducts.length), updatedProducts.length);
        }
        continue; 
    }

    await Promise.all(batch.map(async (product) => {
        // Skip if already has embedding
        if (product.embedding && product.embedding.length > 0) return;

        // Sanitize input
        const metadataText = product.metadata ? Object.values(product.metadata).join(' ') : '';
        const textToEmbed = `${product.name} ${product.localName} ${product.category || ''} ${metadataText}`.trim();
        if (!textToEmbed) return;
        
        try {
          const embedding = await retryOperation(async () => {
            if (config.provider === 'openai') {
              return await embedTextOpenAI(textToEmbed, apiKey);
            } else {
              // Default to Gemini
              if (apiKey) {
                 return await embedTextGemini(textToEmbed, apiKey);
              }
              return undefined;
            }
          });
          
          product.embedding = embedding;
    
        } catch (e) {
          console.error(`Failed to embed ${product.id}`, e);
          // Continue processing other items even if one fails
        }
    }));

    if (onProgress) {
      onProgress(Math.min(i + BATCH_SIZE, updatedProducts.length), updatedProducts.length);
    }
    
    // Minimal delay for OpenAI, longer for Gemini
    const delay = config.provider === 'openai' ? 10 : 200;
    await sleep(delay);
  }

  return updatedProducts;
};

// --- 2. Extraction (Phase 1) ---

const extractRawItems = async (
  imageBase64: string | string[], 
  config: AIConfig,
  database: Product[],
  feedback?: { incorrectItems: InvoiceItem[] }
): Promise<Partial<InvoiceItem>[]> => {
  const apiKey = getEffectiveKey(config);
  if (!apiKey) throw new Error(`API Key required for ${config.provider}`);

  // Normalize input to array
  const imageChunks = Array.isArray(imageBase64) ? imageBase64 : [imageBase64];
  let allItems: Partial<InvoiceItem>[] = [];

  // Refined Vocabulary Hint Generation:
  // Prioritize "complex" products: those with local names (often non-English/harder to OCR) 
  // or metadata (specific variants), and longer names.
  // This helps the model recognize difficult items.
  const vocabularyHint = [...database]
    .sort((a, b) => {
        // Heuristic: Local Name (20pts) + Metadata (10pts) + Length (1pt per char)
        const scoreA = (a.localName ? 20 : 0) + (a.metadata ? 10 : 0) + a.name.length;
        const scoreB = (b.localName ? 20 : 0) + (b.metadata ? 10 : 0) + b.name.length;
        return scoreB - scoreA;
    })
    .slice(0, 200)
    .map(p => {
        let hint = p.name;
        if (p.localName) hint += ` / ${p.localName}`;
        return hint;
    })
    .join(", ");

  let feedbackPrompt = "";
  if (feedback && feedback.incorrectItems.length > 0) {
    feedbackPrompt = `
    PREVIOUS ATTEMPT FEEDBACK:
    The user marked the following extracted items as INCORRECT in a previous run. 
    Please pay extra attention to correctly extracting these items (or similar ones) from the image.
    
    Incorrect Items:
    ${JSON.stringify(feedback.incorrectItems.map(i => ({ name: i.raw_name, price: i.raw_price })), null, 2)}
    `;
  }

  const prompt = `
    Analyze this invoice image and extract ALL line items into a MARKDOWN TABLE, only extract text ignoring formating, do not translate.
    
    CONTEXT AWARENESS (RAG):
    Here is a list of known product names in our database. Use this as a "vocabulary list" to help you decipher blurry or abbreviated text. 
    If you see something that looks like one of these, prefer the known spelling.
    
    KNOWN PRODUCTS (Vocabulary):
    [${vocabularyHint}...]
    
    STRATEGY: SPATIAL ALIGNMENT
    1. **Identify Rows**: Look for the numeric columns (Quantity, Price, Amount).
    2. **Extract**: For each row with numbers, extract the corresponding Description text.
    
    CRITICAL - MULTI-LINE DESCRIPTIONS:
    - If a product description spans multiple lines (e.g. Name on line 1, Region on line 2), you MUST combine them into the "Description" column for that single row.
    - Do NOT create a new row for the second line of text if it doesn't have its own price/quantity.
    
    ${feedbackPrompt}

    OUTPUT FORMAT:
    Return ONLY a Markdown table with the following columns:
    | Description | Quantity | Price |
    
    - Description: The full product name/description (verbatim).
    - Quantity: The numeric quantity (number only).
    - Price: The total amount (number only).
    
    Example:
    | Product A Region X | 2 | 1000 |
    | Product B | 1 | 500 |
  `;

  // Process chunks sequentially
  for (let i = 0; i < imageChunks.length; i++) {
    const chunkBase64 = imageChunks[i];
    
    const chunkPrompt = imageChunks.length > 1 
      ? `${prompt}\n\nNOTE: This is part ${i + 1} of ${imageChunks.length} of a long invoice. Extract items visible in this section.`
      : prompt;

    const chunkItems = await retryOperation(async () => {
      let textResponse = "";
      
      if (config.provider === 'openai') {
        // Use Gemini Vision as OCR for OpenAI provider (Hybrid Approach)
        // This leverages Gemini's superior free vision capabilities while keeping OpenAI for RAG/Mapping
        const geminiApiKey = process.env.API_KEY; // Always use the system env key for Gemini
        
        if (geminiApiKey) {
           const ai = new GoogleGenAI({ apiKey: geminiApiKey });
           const response = await ai.models.generateContent({
             model: 'gemini-3-flash-preview',
             contents: {
               parts: [{ inlineData: { mimeType: 'image/jpeg', data: chunkBase64 } }, { text: chunkPrompt }]
             }
           });
           textResponse = response.text || "";
        } else {
           // Fallback to OpenAI Vision (GPT-4o-mini) if no Gemini key available (unlikely in this env)
           const response = await fetch("https://api.openai.com/v1/chat/completions", {
            method: "POST",
            headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
            body: JSON.stringify({
              model: "gpt-4o", 
              messages: [
                { role: "system", content: "You are an expert OCR agent. You output strictly Markdown tables." },
                { role: "user", content: [{ type: "text", text: chunkPrompt }, { type: "image_url", image_url: { url: `data:image/jpeg;base64,${chunkBase64}`, detail: "high" } }] }
              ]
            })
          });
          const data = await response.json();
          if (data.error) throw new Error(data.error.message);
          textResponse = data.choices[0].message.content;
        }
        
      } else {
        // Gemini
        const ai = new GoogleGenAI({ apiKey });
        const response = await ai.models.generateContent({
          model: 'gemini-3-flash-preview',
          contents: {
            parts: [{ inlineData: { mimeType: 'image/jpeg', data: chunkBase64 } }, { text: chunkPrompt }]
          }
        });
        textResponse = response.text || "";
      }

      // Parse Markdown Table
      const items: Partial<InvoiceItem>[] = [];
      const lines = textResponse.split('\n');
      let inTable = false;
      
      for (const line of lines) {
        if (line.includes('|') && line.includes('---')) {
          inTable = true;
          continue;
        }
        if (!inTable && line.includes('|') && (line.toLowerCase().includes('description') || line.toLowerCase().includes('quantity'))) {
           // Header row, skip but mark start
           continue;
        }
        
        if (line.trim().startsWith('|')) {
          const cols = line.split('|').map(c => c.trim()).filter(c => c !== '');
          if (cols.length >= 3) {
            const raw_name = cols[0];
            const raw_quantity = parseFloat(cols[1].replace(/[^0-9.]/g, '')) || 1;
            const raw_price = parseFloat(cols[2].replace(/[^0-9.]/g, '')) || 0;
            
            // Basic validation to skip header/separator lines if they slipped through
            if (!raw_name.includes('---') && raw_name.toLowerCase() !== 'description') {
               items.push({ raw_name, raw_quantity, raw_price });
            }
          }
        }
      }
      return items;
    });

    allItems = [...allItems, ...chunkItems];
  }

  return allItems;
};

// --- 3. RAG Mapping (Phase 2 & 3) ---

const mapItemsWithRAG = async (
  rawItems: Partial<InvoiceItem>[], 
  database: Product[], 
  config: AIConfig,
  feedback?: { incorrectItems: InvoiceItem[] }
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
            if (apiKey) {
                // Use retry for query embedding too
                queryEmbedding = await retryOperation(() => embedTextGemini(item.raw_name!, apiKey));
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
  // OPTIMIZATION: Increased chunk size for speed (gpt-4o-mini handles larger context well)
  const CHUNK_SIZE = config.provider === 'openai' ? 40 : 15;
  const chunkedItems = [];
  for (let i = 0; i < itemsWithCandidates.length; i += CHUNK_SIZE) {
    chunkedItems.push(itemsWithCandidates.slice(i, i + CHUNK_SIZE));
  }

  let finalMappedResults: any[] = [];

  let feedbackPrompt = "";
  if (feedback && feedback.incorrectItems.length > 0) {
      feedbackPrompt = `
      PREVIOUS ATTEMPT FEEDBACK:
      The user marked the following mappings as INCORRECT in a previous run.
      Please try to find a DIFFERENT or BETTER match for these items. If no good match exists, set matched_product_id to null.
      
      Incorrect Mappings:
      ${JSON.stringify(feedback.incorrectItems.map(i => ({ 
          raw_name: i.raw_name, 
          previous_match_id: i.matched_product_id 
      })), null, 2)}
      `;
  }

  // Parallelize mapping chunks for OpenAI
  const processChunk = async (chunk: any[]) => {
    // Dynamically detect all metadata keys present in this chunk's candidates
    const metadataKeys = new Set<string>();
    chunk.forEach((i: any) => {
        i.candidates.forEach((c: Product) => {
            if (c.metadata) Object.keys(c.metadata).forEach(k => metadataKeys.add(k));
        });
    });
    const keysList = Array.from(metadataKeys).join(', ');

    const prompt = `
      You are a strict mapping agent. Map the RAW INVOICE ITEMS to the CANDIDATE PRODUCTS.
      
      Instructions:
      1. Analyze the "raw_name", "raw_quantity", and "calculated_unit_price" from the invoice.
      2. Compare against each "Candidate". Look at 'name', 'localName', and ALL 'metadata' fields.
      3. **Strict Matching Rules**:
         - **Dynamic Metadata Validation**: Strictly validate against these detected database columns: [${keysList}].
           - If the database has a column (e.g. "Brand", "Flavor", "Size", "Barcode"), the raw item MUST match it or be compatible.
           - Example: If metadata "Brand" is "Pepsi", do not map a raw item saying "Coke".
           - Example: If metadata "Size" is "1L", do not map a raw item saying "325ml".
         - **Origin/Location Trap**: Do NOT match solely because the Origin matches (e.g. "Hokkaido"). "Scallop Hokkaido" is NOT "Surf Clam Hokkaido". The CORE PRODUCT NAME must match.
         - **Price Check**: If metadata contains price information, compare it with "calculated_unit_price". Significant deviation suggests a mismatch (or different pack size).
      4. Select the ID of the product that satisfies these rules.
      5. **CRITICAL**: If NO candidate satisfies these rules, return matched_product_id: null.
      6. Provide a brief "reasoning" for your decision (e.g. "Exact match on name and [Field Name]", "Mismatch on [Field Name]", "Price deviation too high", "Rejected: Only location matches").

      ${feedbackPrompt}

      ITEMS TO MAP:
      ${JSON.stringify(chunk.map((i: any) => ({
        raw_name: i.raw_name,
        raw_quantity: i.raw_quantity,
        raw_total_price: i.raw_price,
        calculated_unit_price: i.raw_quantity ? (i.raw_price / i.raw_quantity).toFixed(2) : i.raw_price,
        candidates: i.candidates.map((c: Product) => ({
          id: c.id,
          name: c.name,
          localName: c.localName,
          metadata: c.metadata
        }))
      })), null, 2)}

      OUTPUT:
      Return a JSON Object with a key "mappings" containing an Array of { 
        raw_name: string, 
        matched_product_id: string | null,
        reasoning: string 
      }.
    `;

    return await retryOperation(async () => {
      if (config.provider === 'openai') {
          const response = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
          body: JSON.stringify({
              model: "gpt-4o", // High reasoning power
              messages: [{ role: "system", content: "Return strictly JSON object." }, { role: "user", content: prompt }],
              response_format: { type: "json_object" }
          })
          });
          const data = await response.json();
          const content = safeJSONParse(data.choices[0].message.content, { mappings: [] });
          return content.mappings || [];
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
  };

  if (config.provider === 'openai') {
    // Parallel execution for OpenAI
    const results = await Promise.all(chunkedItems.map(processChunk));
    finalMappedResults = results.flat();
  } else {
    // Serial execution for Gemini (Rate limits)
    for (const chunk of chunkedItems) {
        const res = await processChunk(chunk);
        finalMappedResults = [...finalMappedResults, ...res];
    }
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
        reasoning: decision?.reasoning, // Capture reasoning
        candidates: itemsWithCandidates[idx]?.candidates || [] // Capture candidates for debugging
    };
  });
};

// --- Main Workflow ---

export const processInvoice = async (
  imageBase64: string | string[],
  database: Product[],
  config: AIConfig,
  feedback?: { incorrectItems: InvoiceItem[] }
): Promise<InvoiceItem[]> => {
    // Phase 1: OCR
    const rawItems = await extractRawItems(imageBase64, config, database, feedback);
    if (rawItems.length === 0) return [];

    // Phase 2 & 3: RAG & Mapping
    const finalItems = await mapItemsWithRAG(rawItems, database, config, feedback);
    
    return finalItems;
};
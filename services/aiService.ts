import { GoogleGenAI, Type } from "@google/genai";
import { Product, InvoiceItem, AIConfig, MatchStatus } from "../types";
import { cosineSimilarity, findNearestNeighbors, isDeletedProduct, normalizeTextForMatch } from "./utils";

// --- Providers Setup ---
const getEffectiveKey = (config: AIConfig) => {
  if (config.apiKey) return config.apiKey;

  if (config.provider === 'gemini') return process.env.API_KEY;
  if (config.provider === 'openai') return process.env.OPENAI_API_KEY;
  if (config.provider === 'claude') return process.env.CLAUDE_API_KEY;

  return '';
};

// Claude has no embedding API — fall back to Gemini for embeddings
const getGeminiKeyForEmbedding = () => process.env.API_KEY || process.env.GEMINI_API_KEY || '';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const collapseSpaces = (input: string): string => input.replace(/\s+/g, " ").trim();

const removeBracketedSegments = (input: string): string =>
  collapseSpaces(input.replace(/\([^)]*\)/g, " "));

const toCompactText = (input: string): string => normalizeTextForMatch(input).replace(/\s+/g, "");

const buildCoreName = (input: string): string => {
  const noBracket = removeBracketedSegments(input || "");
  return normalizeTextForMatch(noBracket);
};

const expandJapaneseOrthographicVariants = (input: string): string[] => {
  const base = normalizeTextForMatch(input || "");
  if (!base) return [];

  const variants = new Set<string>([base]);
  const replacementPairs: Array<[string, string]> = [
    ["ダイ", "タイ"],
    ["ダイ", "鯛"],
    ["タイ", "ダイ"],
    ["タイ", "鯛"],
    ["鯛", "ダイ"],
    ["鯛", "タイ"]
  ];

  for (const [from, to] of replacementPairs) {
    if (base.includes(from)) {
      variants.add(normalizeTextForMatch(base.replaceAll(from, to)));
    }
  }

  return Array.from(variants).filter(Boolean);
};

const buildNameSearchForms = (input: string): string[] => {
  const normalized = normalizeTextForMatch(input || "");
  if (!normalized) return [];

  const noBracket = normalizeTextForMatch(removeBracketedSegments(normalized));
  const forms = new Set<string>([normalized]);
  if (noBracket) forms.add(noBracket);

  for (const base of Array.from(forms)) {
    expandJapaneseOrthographicVariants(base).forEach(v => forms.add(v));
  }

  return Array.from(forms).filter(Boolean);
};

const toBigrams = (input: string): string[] => {
  const text = input.replace(/\s+/g, "");
  if (text.length < 2) return text ? [text] : [];
  const grams: string[] = [];
  for (let i = 0; i < text.length - 1; i++) grams.push(text.slice(i, i + 2));
  return grams;
};

const diceSimilarity = (a: string, b: string): number => {
  const gramsA = toBigrams(normalizeTextForMatch(a));
  const gramsB = toBigrams(normalizeTextForMatch(b));
  if (gramsA.length === 0 || gramsB.length === 0) return 0;

  const counts = new Map<string, number>();
  gramsA.forEach(g => counts.set(g, (counts.get(g) || 0) + 1));
  let intersection = 0;
  gramsB.forEach(g => {
    const n = counts.get(g) || 0;
    if (n > 0) {
      intersection += 1;
      counts.set(g, n - 1);
    }
  });
  return (2 * intersection) / (gramsA.length + gramsB.length);
};

const buildProductTextForMatch = (product: Product): string =>
  normalizeTextForMatch([
    product.name || "",
    product.localName || "",
    product.category || "",
    ...(product.metadata ? Object.values(product.metadata) : [])
  ].join(" "));

const getLexicalCandidates = (rawName: string, database: Product[], limit: number): Product[] => {
  const queryForms = buildNameSearchForms(rawName);
  if (queryForms.length === 0) return [];

  const scored = database
    .filter(p => !isDeletedProduct(p))
    .map(product => {
      const productNameText = normalizeTextForMatch(`${product.name || ""} ${product.localName || ""}`.trim());
      const productText = buildProductTextForMatch(product);
      const score = queryForms.reduce((best, q) => {
        const queryTokens = q.split(" ").filter(Boolean);
        const longestToken = queryTokens.sort((a, b) => b.length - a.length)[0] || "";
        const exactNameBoost = productNameText.includes(q) ? 1 : 0;
        const coreTokenBoost = longestToken && longestToken.length >= 2 && productNameText.includes(longestToken) ? 0.92 : 0;
        const fuzzyName = diceSimilarity(q, productNameText);
        const fuzzyFull = diceSimilarity(q, productText);
        return Math.max(best, exactNameBoost, coreTokenBoost, fuzzyName, fuzzyFull);
      }, 0);
      return { product, score };
    })
    .filter(r => r.score >= 0.22)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(r => r.product);

  return scored;
};

const computeNameAffinity = (rawName: string, candidate: Product): number => {
  const rawCore = buildCoreName(rawName);
  const rawCoreCompact = toCompactText(rawCore);
  const candidateCore = buildCoreName(`${candidate.name || ""} ${candidate.localName || ""}`.trim());
  const candidateCoreCompact = toCompactText(candidateCore);

  const signals = [
    diceSimilarity(rawCore, candidateCore),
    diceSimilarity(rawCoreCompact, candidateCoreCompact),
    candidateCore.includes(rawCore) ? 1 : 0,
    rawCore.includes(candidateCore) ? 0.98 : 0
  ];

  return Math.max(...signals);
};

const isLocationLikeKey = (key: string): boolean => {
  const k = key.toLowerCase().replace(/[\s-]+/g, "_");
  return [
    "origin",
    "origins",
    "location",
    "region",
    "area",
    "province",
    "prefecture",
    "country",
    "state",
    "city"
  ].some(token => k.includes(token));
};

const mergeCandidates = (primary: Product[], fallback: Product[], limit: number): Product[] => {
  const merged: Product[] = [];
  const seen = new Set<string>();
  [...primary, ...fallback].forEach(candidate => {
    if (seen.has(candidate.id)) return;
    seen.add(candidate.id);
    merged.push(candidate);
  });
  return merged.slice(0, limit);
};

const getVectorSimilarity = (queryEmbedding: number[], candidate: Product, provider: string): number => {
  const candidateEmbedding = candidate.embeddings?.[provider];
  if (
    !queryEmbedding?.length ||
    !candidateEmbedding?.length
  ) return 0;

  try {
    const score = cosineSimilarity(queryEmbedding, candidateEmbedding);
    return Number.isFinite(score) ? score : 0;
  } catch {
    return 0;
  }
};

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

const buildEmbeddingTextForProduct = (product: Product): string => {
  const nameForms = buildNameSearchForms(`${product.name || ""} ${product.localName || ""}`);
  const metadataText = product.metadata
    ? Object.values(product.metadata).map(v => normalizeTextForMatch(v)).join(" ")
    : "";

  return normalizeTextForMatch(
    `${nameForms.join(" ")} ${product.category || ""} ${metadataText}`.trim()
  );
};

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

const embedTextsGemini = async (texts: string[], apiKey: string): Promise<number[][]> => {
  const BATCH_SIZE = 100; // Gemini batch limit
  const allEmbeddings: number[][] = [];
  
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      const chunk = texts.slice(i, i + BATCH_SIZE);
      
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:batchEmbedContents?key=${apiKey}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
              requests: chunk.map(text => ({
                  model: 'models/gemini-embedding-001',
                  content: { parts: [{ text }] }
              }))
          })
      });

      if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          throw new Error(`Gemini Batch Embed Error: ${response.status} - ${JSON.stringify(errorData)}`);
      }

      const data = await response.json();
      const chunkEmbeddings = data.embeddings?.map((e: any) => e.values || []) || [];
      
      // Ensure alignment
      if (chunkEmbeddings.length === chunk.length) {
          allEmbeddings.push(...chunkEmbeddings);
      } else {
          console.warn("Mismatch in returned embeddings count, padding with empty arrays");
          chunk.forEach((_, idx) => {
              allEmbeddings.push(chunkEmbeddings[idx] || []);
          });
      }
  }
  
  return allEmbeddings;
};

const embedTextsOpenAI = async (texts: string[], apiKey: string): Promise<number[][]> => {
  const BATCH_SIZE = 100; // Safe batch size
  const allEmbeddings: number[][] = [];

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const chunk = texts.slice(i, i + BATCH_SIZE);
    const response = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
      body: JSON.stringify({ model: "text-embedding-3-small", input: chunk })
    });
    const data = await response.json();
    if (data.error) throw new Error(data.error.message);
    
    const chunkEmbeddings = data.data
        .sort((a: any, b: any) => a.index - b.index)
        .map((d: any) => d.embedding);
    allEmbeddings.push(...chunkEmbeddings);
  }
  return allEmbeddings;
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

  // Larger batch size since we are using batch APIs
  const BATCH_SIZE = 100;

  for (let i = 0; i < updatedProducts.length; i += BATCH_SIZE) {
    const batch = updatedProducts.slice(i, i + BATCH_SIZE);

    // Identify items needing embeddings
    const itemsToEmbed = batch.filter(p => !p.embeddings || !p.embeddings[config.provider] || p.embeddings[config.provider].length === 0);

    if (itemsToEmbed.length > 0) {
        const textsToEmbed = itemsToEmbed.map(buildEmbeddingTextForProduct);

        try {
            const embeddings = await retryOperation(async () => {
                if (config.provider === 'openai') {
                    return await embedTextsOpenAI(textsToEmbed, apiKey);
                } else {
                    return await embedTextsGemini(textsToEmbed, apiKey);
                }
            });

            // Assign embeddings back to products
            itemsToEmbed.forEach((product, idx) => {
                const indexInUpdated = updatedProducts.findIndex(p => p.id === product.id);
                if (indexInUpdated !== -1) {
                    updatedProducts[indexInUpdated] = {
                        ...product,
                        embeddings: {
                            ...(product.embeddings || {}),
                            [config.provider]: embeddings[idx]
                        }
                    };
                }
            });
        } catch (e) {
            console.error(`Failed to embed batch starting at ${i}`, e);
        }
    }

    if (onProgress) {
      onProgress(Math.min(i + BATCH_SIZE, updatedProducts.length), updatedProducts.length);
    }
    
    // Minimal delay
    await sleep(50);
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
    | Description | Core Name | Quantity | Price |

    - Description: The full product name/description (verbatim).
    - Core Name: The core product identity for database matching. Apply these rules in order:
      1. Strip parenthetical modifiers (grades, notes), trailing location/origin names, size/grade indicators, freshness prefixes (e.g. 青 when used as a modifier).
      2. Expand abbreviated/shortened product names to their MOST SPECIFIC match in the KNOWN PRODUCTS vocabulary above. Invoice writers often shorten names. Always prefer the most specific product over a general category. Examples: 柱 → 貝柱 (NOT ホタテ — 柱 specifically means the adductor muscle), 金目 → 金目鯛, イカ → スルメイカ. If multiple known products could match, pick the one whose name is the closest semantic match to the abbreviation.
      3. If the entire description IS already a full product name, repeat it as-is.
    - Quantity: The numeric quantity (number only).
    - Price: The total amount (number only).

    Example:
    | 金目ダイ(泰魯斯) 高知 | 金目ダイ | 2 | 1000 |
    | 穂紫蘇 | 穂紫蘇 | 1 | 500 |
    | 青すだち (泰魯斯) 徳島 | すだち | 3 | 300 |
    | 柱(塊) 北海道 | 貝柱 | 5 | 2000 |
  `;

  const parseMarkdownTable = (textResponse: string): Partial<InvoiceItem>[] => {
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
        if (cols.length >= 4) {
          // 4-column format: Description | Core Name | Quantity | Price
          const raw_name = cols[0];
          const core_name = cols[1];
          const raw_quantity = parseFloat(cols[2].replace(/[^0-9.]/g, '')) || 1;
          const raw_price = parseFloat(cols[3].replace(/[^0-9.]/g, '')) || 0;

          if (!raw_name.includes('---') && raw_name.toLowerCase() !== 'description') {
             items.push({ raw_name, core_name: core_name || raw_name, raw_quantity, raw_price });
          }
        } else if (cols.length >= 3) {
          // Fallback: 3-column format (no core name)
          const raw_name = cols[0];
          const raw_quantity = parseFloat(cols[1].replace(/[^0-9.]/g, '')) || 1;
          const raw_price = parseFloat(cols[2].replace(/[^0-9.]/g, '')) || 0;

          if (!raw_name.includes('---') && raw_name.toLowerCase() !== 'description') {
             items.push({ raw_name, raw_quantity, raw_price });
          }
        }
      }
    }
    return items;
  };

  if (config.provider === 'openai') {
    // OpenAI supports multiple images in a single API call.
    // Batch all image chunks into one request for faster processing.
    return await retryOperation(async () => {
      const userContent: any[] = [{ type: "text", text: prompt }];

      imageChunks.forEach((chunkBase64, i) => {
        if (imageChunks.length > 1) {
          userContent.push({ type: "text", text: `Image part ${i + 1}:` });
        }
        userContent.push({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${chunkBase64}`, detail: "high" } });
      });

      const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: "gpt-5-mini",
          messages: [
            { role: "system", content: "You are an expert OCR agent. You output strictly Markdown tables." },
            { role: "user", content: userContent }
          ]
        })
      });

      const data = await response.json();
      if (data.error) throw new Error(data.error.message);

      return parseMarkdownTable(data.choices[0].message.content);
    });
  }

  if (config.provider === 'claude') {
    // Claude supports multiple images in a single request.
    return await retryOperation(async () => {
      const userContent: any[] = [];

      imageChunks.forEach((chunkBase64, i) => {
        if (imageChunks.length > 1) {
          userContent.push({ type: "text", text: `Image part ${i + 1}:` });
        }
        userContent.push({
          type: "image",
          source: { type: "base64", media_type: "image/jpeg", data: chunkBase64 }
        });
      });

      userContent.push({ type: "text", text: prompt });

      const requestBody = {
        model: "claude-sonnet-4-20250514",
        max_tokens: 4096,
        system: "You are an expert OCR agent. You output strictly Markdown tables.",
        messages: [{ role: "user", content: userContent }]
      };

      console.log("[Claude OCR] Request URL:", "https://api.anthropic.com/v1/messages");
      console.log("[Claude OCR] Model:", requestBody.model);
      console.log("[Claude OCR] Image chunks:", imageChunks.length);
      console.log("[Claude OCR] API key present:", !!apiKey, "length:", apiKey?.length);

      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true"
        },
        body: JSON.stringify(requestBody)
      });

      console.log("[Claude OCR] Response status:", response.status, response.statusText);

      const data = await response.json();
      console.log("[Claude OCR] Response data:", JSON.stringify(data).slice(0, 500));

      if (data.error) {
        console.error("[Claude OCR] API error:", data.error);
        throw new Error(data.error?.message || JSON.stringify(data.error));
      }

      const text = data.content?.[0]?.text || "";
      console.log("[Claude OCR] Extracted text length:", text.length);
      console.log("[Claude OCR] Extracted text preview:", text.slice(0, 300));

      const parsed = parseMarkdownTable(text);
      console.log("[Claude OCR] Parsed items:", parsed.length);

      return parsed;
    });
  }

  // Process chunks in parallel for Gemini
  const chunkPromises = imageChunks.map(async (chunkBase64, i) => {
    const chunkPrompt = imageChunks.length > 1 
      ? `${prompt}\n\nNOTE: This is part ${i + 1} of ${imageChunks.length} of a long invoice. Extract items visible in this section.`
      : prompt;

    return await retryOperation(async () => {
      const ai = new GoogleGenAI({ apiKey });
      const response = await ai.models.generateContent({
        model: 'gemini-3.1-flash-lite-preview',
        contents: {
          parts: [{ inlineData: { mimeType: 'image/jpeg', data: chunkBase64 } }, { text: chunkPrompt }]
        }
      });
      return parseMarkdownTable(response.text || "");
    });
  });

  const results = await Promise.all(chunkPromises);
  results.forEach(chunkItems => {
    allItems = [...allItems, ...chunkItems];
  });

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
  // Claude has no embedding API — uses Gemini embeddings, so retrieval must match on 'gemini' provider
  const embeddingProvider = config.provider === 'claude' ? 'gemini' : config.provider;

  // A. Retrieval Step: Find candidates for each item
  // BATCHING OPTIMIZATION: Embed all queries in batches
  const validIndices = rawItems.map((item, idx) => item.raw_name ? idx : -1).filter(idx => idx !== -1);
  const queryTexts = validIndices.map(idx => {
    const item = rawItems[idx];
    const queryName = item.core_name || item.raw_name!;
    return buildNameSearchForms(queryName).join(" | ");
  });
  
  let queryEmbeddings: number[][] = [];
  if (queryTexts.length > 0) {
      try {
        if (config.provider === 'openai') {
            queryEmbeddings = await retryOperation(() => embedTextsOpenAI(queryTexts, apiKey!));
        } else {
            // Gemini or Claude (Claude uses Gemini for embeddings)
            const embeddingKey = config.provider === 'claude'
              ? getGeminiKeyForEmbedding()
              : apiKey;
            if (embeddingKey) {
                queryEmbeddings = await retryOperation(() => embedTextsGemini(queryTexts, embeddingKey));
            }
        }
      } catch (e) { console.error("Batch embedding failed", e); }
  }

  const itemsWithCandidates = rawItems.map((item, idx) => {
    if (!item.raw_name) return { ...item, candidates: [] };

    const queryName = item.core_name || item.raw_name;

    // Find embedding for this item
    const embeddingIndex = validIndices.indexOf(idx);
    const embedding = (embeddingIndex !== -1 && queryEmbeddings[embeddingIndex]) ? queryEmbeddings[embeddingIndex] : [];

    // Vector Search
    const vectorCandidates = embedding.length > 0
      ? findNearestNeighbors(embedding, database, embeddingProvider, 5)
      : [];
    const lexicalCandidates = getLexicalCandidates(queryName, database, 5);
    const rankedCandidates = mergeCandidates(vectorCandidates, lexicalCandidates, 12)
      .map(c => {
        const nameAffinity = computeNameAffinity(queryName, c);
        const vectorSimilarity = getVectorSimilarity(embedding, c, embeddingProvider);
        const retrievalScore = Math.max(nameAffinity, vectorSimilarity);
        return { candidate: c, nameAffinity, vectorSimilarity, retrievalScore };
      })
      .sort((a, b) => b.retrievalScore - a.retrievalScore)
      .slice(0, 7);
    const candidates = rankedCandidates.map(r => ({ ...r.candidate, _score: Number(r.retrievalScore.toFixed(3)) }));
    const topNameAffinity = rankedCandidates[0]?.nameAffinity ?? 0;
    const secondNameAffinity = rankedCandidates[1]?.nameAffinity ?? 0;
    const topVectorSimilarity = rankedCandidates[0]?.vectorSimilarity ?? 0;
    const secondVectorSimilarity = rankedCandidates[1]?.vectorSimilarity ?? 0;
    const topRetrievalScore = rankedCandidates[0]?.retrievalScore ?? 0;
    const secondRetrievalScore = rankedCandidates[1]?.retrievalScore ?? 0;
        
    return {
      ...item,
      item_index: idx,
      candidates,
      topNameAffinity,
      secondNameAffinity,
      topVectorSimilarity,
      secondVectorSimilarity,
      topRetrievalScore,
      secondRetrievalScore
    };
  });

  // B. Synthesis Step: Ask LLM to pick the best one
  // BATCHING: Split items into chunks to avoid output token limits and JSON truncation
  // OPTIMIZATION: Increased chunk size for speed (gpt-5-mini handles larger context well)
  const CHUNK_SIZE = 100;
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
    const strictKeys = Array.from(metadataKeys).filter(k => !isLocationLikeKey(k));
    const keysList = strictKeys.join(', ') || '(none)';
    const locationLikeKeys = Array.from(metadataKeys).filter(isLocationLikeKey);
    const locationKeysList = locationLikeKeys.join(', ') || '(none)';

    const prompt = `
      You are a strict mapping agent. Map the RAW INVOICE ITEMS to the CANDIDATE PRODUCTS.
      
      Instructions:
      1. Analyze the "raw_name", "core_name", "normalized_raw_name", "raw_quantity", and "calculated_unit_price" from the invoice. The "core_name" is the LLM-extracted product identity (abbreviations expanded, modifiers stripped) — use it as the primary matching signal.
      2. Compare against each "Candidate". Look at 'name', 'localName', 'normalized_name', 'normalized_local_name', 'candidate_core_name', 'name_affinity', and ALL 'metadata' fields.
      3. **Strict Matching Rules**:
         - **Dynamic Metadata Validation**: Strictly validate against these detected database columns: [${keysList}].
           - If the database has a column (e.g. "Brand", "Flavor", "Size", "Barcode"), the raw item MUST match it or be compatible.
           - Example: If metadata "Brand" is "Pepsi", do not map a raw item saying "Coke".
           - Example: If metadata "Size" is "1L", do not map a raw item saying "325ml".
           - **Location-like keys are NON-BLOCKING**: [${locationKeysList}] are secondary tie-breakers only. A mismatch in these keys alone must NOT force null.
         - **Japanese Orthographic Variants**: Treat common equivalent forms as potentially the same core name (e.g. "金目ダイ", "金目鯛", "キンメダイ"), but still validate with quantity/price/metadata.
         - **Core-name first, qualifier second (language-agnostic)**: Parenthetical and trailing tokens in any language/script can be qualifiers (origin, supplier, notes). Match by CORE PRODUCT NAME first, then use qualifiers as secondary evidence.
         - **Specificity rule**: When multiple candidates are semantically related (e.g. both are scallop products), prefer the candidate whose name most specifically matches the core name. If the core name is a substring of a candidate name (e.g. core "貝柱" appears in candidate "貝柱/カイバシラ"), that candidate is more specific than a general category (e.g. "帆立/ホタテ"). Always prefer the most specific match.
         - **Price Check**: If metadata contains price information, compare it with "calculated_unit_price". Significant deviation suggests a mismatch (or different pack size).
      4. Select the ID of the product that satisfies these rules.
      5. **CRITICAL**: If NO candidate satisfies these rules, return matched_product_id: null.
      6. Provide a brief "reasoning" for your decision (MAX 5 WORDS. e.g. "Exact match on name/Brand", "Price deviation too high").

      ${feedbackPrompt}

      ITEMS TO MAP:
      ${JSON.stringify(chunk.map((i: any) => ({
        item_index: i.item_index,
        raw_name: i.raw_name,
        core_name: i.core_name || buildCoreName(i.raw_name || ''),
        normalized_raw_name: normalizeTextForMatch(i.raw_name || ''),
        core_raw_name: buildCoreName(i.raw_name || ''),
        compact_core_raw_name: toCompactText(buildCoreName(i.raw_name || '')),
        precomputed_top_name_affinity: Number((i.topNameAffinity || 0).toFixed(3)),
        precomputed_second_name_affinity: Number((i.secondNameAffinity || 0).toFixed(3)),
        precomputed_top_vector_similarity: Number((i.topVectorSimilarity || 0).toFixed(3)),
        precomputed_second_vector_similarity: Number((i.secondVectorSimilarity || 0).toFixed(3)),
        precomputed_top_retrieval_score: Number((i.topRetrievalScore || 0).toFixed(3)),
        precomputed_second_retrieval_score: Number((i.secondRetrievalScore || 0).toFixed(3)),
        raw_quantity: i.raw_quantity,
        raw_total_price: i.raw_price,
        calculated_unit_price: i.raw_quantity ? (i.raw_price / i.raw_quantity).toFixed(2) : i.raw_price,
        candidates: i.candidates.map((c: Product) => ({
          id: c.id,
          name: c.name,
          localName: c.localName,
          normalized_name: normalizeTextForMatch(c.name || ''),
          normalized_local_name: normalizeTextForMatch(c.localName || ''),
          candidate_core_name: buildCoreName(`${c.name || ''} ${c.localName || ''}`.trim()),
          candidate_compact_core_name: toCompactText(buildCoreName(`${c.name || ''} ${c.localName || ''}`.trim())),
          name_affinity: Number(computeNameAffinity(i.raw_name || '', c).toFixed(3)),
          metadata: c.metadata
        }))
      })), null, 2)}

      OUTPUT:
      Return a JSON Object with a key "mappings" containing an Array of { 
        item_index: number,
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
              model: "gpt-5-mini", // High reasoning power
              messages: [{ role: "system", content: "Return strictly JSON object." }, { role: "user", content: prompt }],
              response_format: { type: "json_object" }
          })
          });
          const data = await response.json();
          const content = safeJSONParse(data.choices[0].message.content, { mappings: [] });
          return content.mappings || [];
      } else if (config.provider === 'claude') {
          const response = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-api-key": apiKey!,
              "anthropic-version": "2023-06-01",
              "anthropic-dangerous-direct-browser-access": "true"
            },
            body: JSON.stringify({
              model: "claude-sonnet-4-20250514",
              max_tokens: 4096,
              system: "Return strictly JSON object.",
              messages: [{ role: "user", content: prompt }]
            })
          });
          const data = await response.json();
          if (data.error) throw new Error(data.error?.message || JSON.stringify(data.error));
          const rawText = data.content?.[0]?.text || "{}";
          console.log("[Claude Re-rank] Raw response:", rawText.slice(0, 500));
          const parsed = safeJSONParse(rawText, { mappings: [] });
          console.log("[Claude Re-rank] Parsed mappings:", parsed.mappings?.length, parsed.mappings);
          return parsed.mappings || [];
      } else {
          const ai = new GoogleGenAI({ apiKey: apiKey! });
          const response = await ai.models.generateContent({
          model: 'gemini-3.1-flash-lite-preview',
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
    // Serial execution for Gemini/Claude (Rate limits)
    for (const chunk of chunkedItems) {
        const res = await processChunk(chunk);
        finalMappedResults = [...finalMappedResults, ...res];
    }
  }

  // Merge results back
  const decisionByIndex = new Map<number, any>();
  finalMappedResults.forEach((m: any) => {
    if (typeof m?.item_index === 'number') decisionByIndex.set(m.item_index, m);
  });

  return rawItems.map((raw, idx) => {
    // Prefer index-based mapping to avoid ambiguity when raw_name repeats.
    const decision = decisionByIndex.get(idx) ?? finalMappedResults.find((m: any) => m.raw_name === raw.raw_name);
    const itemCandidates: any = itemsWithCandidates[idx];
    const topCandidate: Product | undefined = itemCandidates?.candidates?.[0];
    const topAffinity = Number(itemCandidates?.topNameAffinity || 0);
    const secondAffinity = Number(itemCandidates?.secondNameAffinity || 0);
    const topVector = Number(itemCandidates?.topVectorSimilarity || 0);
    const secondVector = Number(itemCandidates?.secondVectorSimilarity || 0);
    const topRetrieval = Number(itemCandidates?.topRetrievalScore || 0);
    const secondRetrieval = Number(itemCandidates?.secondRetrievalScore || 0);
    const marginAffinity = topAffinity - secondAffinity;
    const marginVector = topVector - secondVector;
    const marginRetrieval = topRetrieval - secondRetrieval;

    const modelReturnedNoMatch = !decision?.matched_product_id;
    const reasoningText = String(decision?.reasoning || '').toLowerCase();
    const originOnlyRejection = reasoningText.includes('origin mismatch') || reasoningText.includes('location mismatch');
    const priceConflictRejection =
      reasoningText.includes('price') &&
      (reasoningText.includes('mismatch') || reasoningText.includes('deviation') || reasoningText.includes('conflict'));

    const deterministicOverride = topCandidate && (
      (topAffinity >= 0.93 && marginAffinity >= 0.08) ||
      (topVector >= 0.80 && marginVector >= 0.05) ||
      (topRetrieval >= 0.82 && marginRetrieval >= 0.06) ||
      (originOnlyRejection && topRetrieval >= 0.62 && marginRetrieval >= 0.08)
    );

    // Final safety net: if model returns null, keep the top-ranked retrieval candidate
    // unless there is an explicit price-conflict rejection.
    const fallbackToTopCandidate = topCandidate && modelReturnedNoMatch && !priceConflictRejection && (
      deterministicOverride ||
      originOnlyRejection ||
      itemCandidates?.candidates?.length === 1 ||
      topRetrieval >= 0.45
    );

    const matchedId = fallbackToTopCandidate ? topCandidate.id : (decision?.matched_product_id || null);
    const finalReasoning = fallbackToTopCandidate
      ? `Top candidate fallback ${topRetrieval.toFixed(2)}`
      : decision?.reasoning;
    const hasMatch = Boolean(matchedId);

    const baseFromRetrieval = clamp01(topRetrieval);
    const marginBoost = clamp01(marginRetrieval) * 0.25;
    const modelSupportBoost = !modelReturnedNoMatch ? 0.08 : 0;
    const fallbackPenalty = fallbackToTopCandidate ? -0.06 : 0;
    const conflictPenalty = priceConflictRejection ? -0.15 : 0;

    const confidenceScore = hasMatch
      ? clamp01(baseFromRetrieval + marginBoost + modelSupportBoost + fallbackPenalty + conflictPenalty)
      : 0;

    const finalMatchedId = modelReturnedNoMatch ? matchedId : (decision?.matched_product_id || null);

    const matchStatus: MatchStatus = !finalMatchedId
      ? 'no_match'
      : confidenceScore > 0.70
        ? 'matched'
        : 'low_confidence';

    return {
        raw_name: raw.raw_name!,
        core_name: raw.core_name,
        raw_quantity: raw.raw_quantity || 0,
        raw_price: raw.raw_price || 0,
        matched_product_id: finalMatchedId,
        match_status: matchStatus,
        reasoning: finalReasoning,
        confidence_score: Number(confidenceScore.toFixed(3)),
        candidates: itemsWithCandidates[idx]?.candidates || []
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
    // Phase 1: OCR (uses selected provider — Claude/Gemini/OpenAI)
    const rawItems = await extractRawItems(imageBase64, config, database, feedback);
    if (rawItems.length === 0) return [];

    // Phase 2 & 3: RAG & Matching (Claude uses own API for re-ranking, Gemini for embeddings)
    const matchingConfig: AIConfig = config.provider === 'claude'
      ? { provider: 'claude', apiKey: config.apiKey }
      : config;
    const finalItems = await mapItemsWithRAG(rawItems, database, matchingConfig, feedback);

    return finalItems;
};
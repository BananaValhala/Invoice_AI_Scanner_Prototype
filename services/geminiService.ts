import { GoogleGenAI, Type } from "@google/genai";
import { Product, InvoiceItem } from "../types";

// Helper to chunk database if it's too large, though Flash has huge context.
const formatDatabaseForPrompt = (products: Product[]): string => {
  return JSON.stringify(products.map(p => ({
    id: p.id,
    local_name: p.localName,
    en_name: p.name
  })));
};

export const processInvoiceImage = async (
  imageBase64: string,
  database: Product[]
): Promise<InvoiceItem[]> => {
  const apiKey = process.env.API_KEY;
  if (!apiKey) {
    throw new Error("API Key is missing");
  }

  const ai = new GoogleGenAI({ apiKey });

  // Prompt engineering with Context Injection (RAG-lite)
  const dbContext = formatDatabaseForPrompt(database);
  
  const prompt = `
    Analyze the attached invoice image.
    
    CONTEXT:
    You are an expert data extraction agent. You have access to a reference Product Database.
    
    PRODUCT DATABASE:
    ${dbContext}

    TASK:
    1. Extract every line item from the invoice image (product name, quantity, price).
    2. The invoice may be in ANY language. 
    3. For each extracted item, attempt to find the EXACT match in the PRODUCT DATABASE provided above.
       - The database contains 'en_name' (English) and 'local_name' (Local/Regional/Alternative).
       - Match the invoice item against either name, or semantically if it's a translation.
       - If the exact name isn't there, look for the closest logical match (e.g., "Tomato A" invoice vs "Tomato" db).
    4. If a match is found, include the 'matched_product_id'. If not, set it to null.
    5. Provide a confidence score (0-1) for the match.

    REQUIREMENTS:
    - Raw extraction must be 100% accurate to the image text.
    - Database mapping must be precise.

    OUTPUT FORMAT:
    Return a JSON array of objects.
  `;

  try {
    const response = await ai.models.generateContent({
      model: 'gemini-3-flash-preview',
      contents: {
        parts: [
          {
            inlineData: {
              mimeType: 'image/jpeg', // Assuming jpeg for simplicity, API handles standard types
              data: imageBase64
            }
          },
          { text: prompt }
        ]
      },
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              raw_name: { type: Type.STRING, description: "The product name exactly as it appears on the invoice" },
              raw_quantity: { type: Type.NUMBER, description: "The numeric quantity" },
              raw_price: { type: Type.NUMBER, description: "The total price for this line item" },
              matched_product_id: { type: Type.STRING, description: "The ID from the Product Database, or null if no match", nullable: true },
              confidence_score: { type: Type.NUMBER, description: "Confidence in the database match (0.0 to 1.0)" }
            },
            required: ["raw_name", "raw_quantity", "raw_price", "confidence_score"]
          }
        }
      }
    });

    const text = response.text;
    if (!text) return [];
    
    return JSON.parse(text) as InvoiceItem[];
  } catch (error) {
    console.error("Gemini API Error:", error);
    throw error;
  }
};
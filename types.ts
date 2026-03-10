export interface Product {
  id: string;
  name: string;
  localName: string;
  unit: string;
  category?: string;
  embeddings?: Record<string, number[]>;
  metadata?: Record<string, string>;
}

export type MatchStatus = 'matched' | 'low_confidence' | 'no_match';

export interface InvoiceItem {
  raw_name: string;
  core_name?: string;
  raw_price: number;
  raw_quantity: number;
  matched_product_id: string | null;
  match_status?: MatchStatus;
  reasoning?: string;
  confidence_score?: number;
  candidates?: Product[];
}

export interface ProcessedInvoice {
  id: string;
  fileName: string;
  status: 'pending' | 'processing' | 'completed' | 'error' | 'restored';
  items: InvoiceItem[];
  timestamp: string;
  rawImageBase64?: string | string[];
  error?: string;
  processTimeMs?: number;
  aiProvider?: AIProvider;
}

export type AIProvider = 'gemini' | 'openai' | 'claude';

export interface AIConfig {
  provider: AIProvider;
  apiKey: string;
}

export interface AppState {
  database: Product[];
  invoices: ProcessedInvoice[];
  isProcessing: boolean;
  aiConfig: AIConfig;
}
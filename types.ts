export interface Product {
  id: string;
  name: string;
  localName: string;
  unit: string;
  category?: string;
  embedding?: number[];
}

export interface InvoiceItem {
  raw_name: string;
  raw_price: number;
  raw_quantity: number;
  matched_product_id: string | null;
}

export interface ProcessedInvoice {
  id: string;
  fileName: string;
  status: 'pending' | 'processing' | 'completed' | 'error';
  items: InvoiceItem[];
  timestamp: string;
  rawImageBase64?: string | string[];
  error?: string;
}

export type AIProvider = 'gemini' | 'openai';

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
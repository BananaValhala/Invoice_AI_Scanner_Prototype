# Invoice AI Scanner Prototype

Maps "dirty" product names from scanned invoices to records in a product database using RAG (vector search + lexical search + LLM re-rank).

## Tech Stack

- React 19 + Vite + TailwindCSS 4
- Gemini / OpenAI / Claude APIs for OCR, embeddings, and LLM re-ranking
- In-memory vector store with IndexedDB persistence

## Commands

- `npm run dev` — Start dev server
- `npm run build` — Production build

## Architecture

```
services/aiService.ts   — Core AI pipeline: OCR extraction, embedding generation, RAG matching, confidence scoring
services/utils.ts       — CSV/JSON parsing, text normalization (NFKC), vector ops (cosine similarity), IndexedDB persistence
types.ts                — All type definitions (Product, InvoiceItem, ProcessedInvoice, MatchStatus, AppState)
components/             — React UI (ProcessedResults, DatabaseViewer, Settings, Dropzone)
```

## App Workflow

```
Step 1: Upload Reference Dataset
  ├─ User uploads CSV or JSON product database
  ├─ Parsed by parseCSV / parseJSON (services/utils.ts)
  ├─ Smart merge preserves existing embeddings on re-upload
  └─ Stored in React state + persisted to IndexedDB

Step 2: Index Products (Embeddings)
  ├─ Batch-embeds all product names (name + localName)
  ├─ Gemini: gemini-embedding-001 (768d) — batchEmbedContents API
  ├─ OpenAI: text-embedding-3-small (1536d) — /v1/embeddings API
  ├─ Claude: uses Gemini embeddings automatically (no native embedding API)
  └─ Embeddings stored in-memory on each Product object

Step 3: Upload Invoice Image(s)
  ├─ User uploads scanned invoice images (JPG/PNG)
  ├─ preprocessImage (services/utils.ts) upscales small images + slices tall ones into chunks
  └─ Multiple images queued for sequential processing

Step 4: OCR Extraction
  ├─ Image chunks sent to vision LLM for structured extraction
  ├─ Gemini: gemini-3.1-flash-lite-preview — multimodal prompt
  ├─ OpenAI: gpt-5-mini — vision prompt
  ├─ Claude: claude-sonnet-4-20250514 — Anthropic Messages API (OCR only)
  ├─ Outputs markdown table: | Description | Core Name | Quantity | Price |
  └─ Core Name = product identity stripped of modifiers/grades/origins

Step 5: RAG Matching (per item) — always uses Gemini/OpenAI (Claude falls back to Gemini)
  ├─ 5a. Retrieval
  │   ├─ Vector search: embed core_name → cosine similarity → top 5
  │   ├─ Lexical search: Dice bigram similarity on normalized text → top 5
  │   └─ Merge + deduplicate → top 12 candidates
  ├─ 5b. LLM Re-rank
  │   ├─ Candidates + precomputed scores sent to LLM
  │   ├─ Gemini: gemini-3.1-flash-lite-preview
  │   ├─ OpenAI: gpt-5-mini
  │   └─ Returns best match ID + reasoning (or null)
  └─ 5c. Confidence Scoring
      ├─ Formula: baseRetrieval + marginBoost + modelSupport - fallbackPenalty - conflictPenalty
      ├─ Deterministic fallback overrides LLM null when retrieval signals are very strong
      └─ match_status: matched (>0.70), low_confidence (0.50-0.70), no_match (<0.50, score=0.0)

Step 6: Display Results
  ├─ Table: raw_name → matched product (with status badge, confidence %, reasoning)
  ├─ Expandable candidate list with UUID + retrieval scores
  └─ Users can mark incorrect items → retry with feedback to LLM

Step 7: Persistence
  ├─ Full state (database + embeddings + invoices) saved to IndexedDB
  ├─ Auto-saves on state change (1s debounce)
  └─ Restored on page reload (invoices marked as 'restored', images stripped)
```

## Key Conventions

- **Multi-provider**: Gemini (`gemini-embedding-001`, 768d), OpenAI (`text-embedding-3-small`, 1536d), and Claude (`claude-sonnet-4-20250514`, OCR only — matching falls back to Gemini). Embeddings track their provider.
- **Core name extraction**: OCR extracts both `raw_name` (verbatim) and `core_name` (stripped of modifiers, grades, origins). `core_name` is used for matching queries.
- **Match status**: `matched` (confidence > 0.70), `low_confidence` (0.50-0.70), `no_match` (null or < 0.50). No-match items have confidence = 0.0.
- **Japanese text**: NFKC normalization, orthographic variant expansion (ダイ↔タイ↔鯛), bracket stripping for core names.
- **is_deleted filtering**: Products with `is_deleted=1` are excluded from matching.
- **Retry with feedback**: Users mark incorrect items → feedback sent to LLM on re-processing.

## Product Database

Loaded from CSV or JSON with flexible column/key detection. Accepts `.csv` (auto-detects delimiter) and `.json` (flat array or wrapped in `data`/`products`/`items` key). Name fields can be JSON objects (`{"en": "...", "jp": "...", "ka": "..."}`). Fields `ka` and `jp` are most reliable (~99.3% populated); `en` is missing for ~19% of records.

import React, { useState, useCallback, useEffect } from 'react';
import { Product, ProcessedInvoice, AIConfig, InvoiceItem } from './types';
import { parseCSV, parseJSON, fileToBase64, preprocessImage, downloadJSON, saveAppState, loadAppState } from './services/utils';
import { processInvoice, generateEmbeddingsForDatabase } from './services/aiService';
import { Dropzone } from './components/Dropzone';
import { DatabaseViewer } from './components/DatabaseViewer';
import { ProcessedResults } from './components/ProcessedResults';
import { Settings } from './components/Settings';
import { 
  Bot, 
  Upload, 
  FileText, 
  Download, 
  RefreshCw, 
  Zap,
  LayoutDashboard,
  Trash2
} from 'lucide-react';

export default function App() {
  const [database, setDatabase] = useState<Product[]>([]);
  const [invoices, setInvoices] = useState<ProcessedInvoice[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [indexingStatus, setIndexingStatus] = useState<string>("");
  const [aiConfig, setAiConfig] = useState<AIConfig>({ provider: 'gemini', apiKey: '' });
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [showRestoreMessage, setShowRestoreMessage] = useState(false);
  const isFirstRender = React.useRef(true);

  // Load saved state on mount
  useEffect(() => {
    let dbConnection: IDBDatabase | null = null;
    
    const initApp = async () => {
      // Load everything from IndexedDB (includes database with embeddings + invoices)
      const savedState = await loadAppState();
      
      if (savedState) {
        // Restore database (with embeddings)
        if (savedState.database && savedState.database.length > 0) {
          // Migrate older state to use embeddings dictionary
          const migratedDatabase = savedState.database.map(p => {
            const newP = { ...p };
            if (!newP.embeddings) {
              newP.embeddings = {};
            }
            // Handle legacy single embedding format
            if ((newP as any).embedding && (newP as any).embedding.length > 0) {
              const provider = (newP as any).embeddingProvider || ((newP as any).embedding.length === 1536 ? 'openai' : 'gemini');
              newP.embeddings[provider] = (newP as any).embedding;
              delete (newP as any).embedding;
              delete (newP as any).embeddingProvider;
            }
            return newP;
          });
          setDatabase(migratedDatabase);
          console.log(`Restored database with ${savedState.database.length} products`);
        }
        // Restore AI config (only provider, not API key for security)
        if (savedState.aiConfig) {
          setAiConfig(prev => ({
            ...prev,
            provider: savedState.aiConfig.provider || prev.provider
          }));
        }
        // Restore invoice metadata (without images)
        if (savedState.invoices && savedState.invoices.length > 0) {
          const restoredInvoices: ProcessedInvoice[] = savedState.invoices.map(inv => ({
            ...inv,
            status: 'restored' as const, // Mark as restored since images are not available
            items: inv.items || [],
            rawImageBase64: undefined
          }));
          setInvoices(restoredInvoices);
          setShowRestoreMessage(true);
          setTimeout(() => setShowRestoreMessage(false), 5000);
        }
      }
    };
    
    initApp();
    
    return () => {
      if (dbConnection) {
        dbConnection.close();
      }
    };
  }, []);

  // Save state when database, aiConfig, or invoices change (with debounce)
  // Skip the first render to avoid overwriting saved state with empty defaults
  useEffect(() => {
    // Skip first render (initial mount)
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }

    const timeoutId = setTimeout(() => {
      // Only save if there's actual data (not initial empty state)
      const hasData = database.length > 0 || invoices.length > 0;
      if (hasData) {
        saveAppState(database, aiConfig, invoices);
      }
    }, 1000); // Debounce saves by 1 second
    return () => clearTimeout(timeoutId);
  }, [database, aiConfig, invoices]);

  // Handle Database Upload (CSV or JSON)
  const handleDatabaseUpload = async (files: File[]) => {
    if (files.length === 0) return;
    const file = files[0];
    const text = await file.text();
    const isJSON = file.name.toLowerCase().endsWith('.json');
    const parsedData = isJSON ? parseJSON(text) : parseCSV(text);
    
    // Smart Merge: Preserve existing embeddings if IDs/Names match
    // This prevents re-indexing the entire database when just adding new items
    if (database.length > 0) {
        // Create maps for fast lookup
        // Note: If multiple items share the same ID/Name, the last one wins in the map.
        const existingMap = new Map();
        const nameMap = new Map();
        
        database.forEach(p => {
            if (p.id) existingMap.set(p.id, { embeddings: p.embeddings });
            if (p.name) nameMap.set(p.name, { embeddings: p.embeddings });
        });

        let preservedCount = 0;
        
        const mergedData = parsedData.map(newItem => {
            // Priority 1: Match by ID (most reliable)
            let existingData = newItem.id ? existingMap.get(newItem.id) : undefined;
            
            // Priority 2: Match by Name (fallback)
            if (!existingData && newItem.name) {
                existingData = nameMap.get(newItem.name);
            }
            
            if (existingData && existingData.embeddings && Object.keys(existingData.embeddings).length > 0) {
                preservedCount++;
                return { ...newItem, embeddings: existingData.embeddings };
            }
            
            // If no embedding found, return the new item as-is (it will be indexed later)
            return { ...newItem, embeddings: {} };
        });
        
        setDatabase(mergedData);
        
        const newCount = mergedData.length - preservedCount;
        
        if (preservedCount > 0) {
            alert(`Database Updated:\n- Total Items: ${mergedData.length}\n- Preserved Embeddings: ${preservedCount}\n- New Items to Index: ${newCount}`);
        }
    } else {
        setDatabase(parsedData);
    }
  };

  // Handle Invoice Images Upload
  const handleInvoiceUpload = async (files: File[]) => {
    const newInvoices: ProcessedInvoice[] = [];
    
    for (const file of files) {
      // Use preprocessImage to handle long receipts by slicing them
      const chunks = await preprocessImage(file);
      
      newInvoices.push({
        id: Math.random().toString(36).substr(2, 9),
        fileName: file.name,
        status: 'pending',
        items: [],
        timestamp: new Date().toLocaleString(),
        // Store chunks array if multiple, or single string if one
        rawImageBase64: chunks.length === 1 ? chunks[0] : chunks
      });
    }
    
    setInvoices(prev => [...prev, ...newInvoices]);
  };

  const removeInvoice = (id: string) => {
    setInvoices(prev => prev.filter(inv => inv.id !== id));
  };

  const handleRetryInvoice = async (invoice: ProcessedInvoice, incorrectItems: InvoiceItem[]) => {
    if (database.length === 0) {
      alert("Please upload a product database CSV first.");
      return;
    }

    const hasApiKey = aiConfig.apiKey ||
      (aiConfig.provider === 'gemini' && process.env.GEMINI_API_KEY) ||
      (aiConfig.provider === 'openai' && process.env.OPENAI_API_KEY) ||
      (aiConfig.provider === 'claude' && process.env.CLAUDE_API_KEY);

    if (!hasApiKey) {
      alert(`Please enter an API Key for ${aiConfig.provider} in Settings.`);
      setIsSettingsOpen(true);
      return;
    }

    // Set status to processing
    setInvoices(prev => prev.map(inv => 
      inv.id === invoice.id ? { ...inv, status: 'processing', error: undefined } : inv
    ));

    try {
      if (!invoice.rawImageBase64) throw new Error("No image data");
      
      // 1. Check/Index Database (Claude uses Gemini for indexing)
      let currentDb = database;
      const indexingProvider = aiConfig.provider === 'claude' ? 'gemini' : aiConfig.provider;
      const indexingConfig = aiConfig.provider === 'claude'
        ? { provider: 'gemini' as const, apiKey: '' }
        : aiConfig;
      const needsIndexing = database.some(p => !p.embeddings || !p.embeddings[indexingProvider] || p.embeddings[indexingProvider].length === 0);

      if (needsIndexing) {
        setIndexingStatus("Initializing database indexing...");
        currentDb = await generateEmbeddingsForDatabase(database, indexingConfig, (current, total) => {
            const percentage = Math.round((current / total) * 100);
            setIndexingStatus(`Indexing product database: ${percentage}% (${current}/${total})...`);
        });
        setDatabase(currentDb);
        setIndexingStatus("");
      }

      // Pass feedback to processInvoice
      const processStartTime = Date.now();
      const extractedItems = await processInvoice(
        invoice.rawImageBase64, 
        currentDb, 
        aiConfig,
        { incorrectItems }
      );
      const processTimeMs = Date.now() - processStartTime;
      
      setInvoices(prev => prev.map(inv => 
        inv.id === invoice.id ? { 
          ...inv, 
          status: 'completed', 
          items: extractedItems,
          processTimeMs,
          aiProvider: aiConfig.provider
        } : inv
      ));
    } catch (e: any) {
      console.error(e);
      setInvoices(prev => prev.map(inv => 
        inv.id === invoice.id ? { ...inv, status: 'error', error: e.message } : inv
      ));
      setIndexingStatus("");
    }
  };

  const [processingStats, setProcessingStats] = useState<{
    startTime: number | null;
    completedCount: number;
    totalCount: number;
  }>({ startTime: null, completedCount: 0, totalCount: 0 });

  // Process Invoices
  const handleProcessInvoices = async () => {
    if (database.length === 0) {
      alert("Please upload a product database CSV first.");
      return;
    }
    
    const hasApiKey = aiConfig.apiKey ||
      (aiConfig.provider === 'gemini' && process.env.GEMINI_API_KEY) ||
      (aiConfig.provider === 'openai' && process.env.OPENAI_API_KEY) ||
      (aiConfig.provider === 'claude' && process.env.CLAUDE_API_KEY);

    if (!hasApiKey) {
      alert(`Please enter an API Key for ${aiConfig.provider} in Settings.`);
      setIsSettingsOpen(true);
      return;
    }
    
    setIsProcessing(true);

    // 1. Check/Index Database (Claude uses Gemini for indexing)
    let currentDb = database;
    const indexingProvider = aiConfig.provider === 'claude' ? 'gemini' : aiConfig.provider;
    const indexingConfig = aiConfig.provider === 'claude'
      ? { provider: 'gemini' as const, apiKey: '' }
      : aiConfig;
    const needsIndexing = database.some(p => !p.embeddings || !p.embeddings[indexingProvider] || p.embeddings[indexingProvider].length === 0);

    if (needsIndexing) {
      setIndexingStatus("Initializing database indexing...");
      try {
        currentDb = await generateEmbeddingsForDatabase(database, indexingConfig, (current, total) => {
            const percentage = Math.round((current / total) * 100);
            setIndexingStatus(`Indexing product database: ${percentage}% (${current}/${total})...`);
        });
        setDatabase(currentDb);
        setIndexingStatus("");
      } catch (e: any) {
        console.error("Indexing failed", e);
        alert(`Database indexing failed: ${e.message}. Check your API quota or key.`);
        setIsProcessing(false);
        setIndexingStatus("");
        return;
      }
    }
    
    // 2. Process Invoices
    const pendingInvoices = invoices.filter(inv => inv.status === 'pending');
    setProcessingStats({
      startTime: Date.now(),
      completedCount: 0,
      totalCount: pendingInvoices.length
    });
    
    // Parallelize invoice processing for speed (batch of 5)
    const BATCH_SIZE = 5;
    for (let i = 0; i < pendingInvoices.length; i += BATCH_SIZE) {
        const batch = pendingInvoices.slice(i, i + BATCH_SIZE);
        
        await Promise.all(batch.map(async (invoice) => {
             setInvoices(prev => prev.map(inv => 
                inv.id === invoice.id ? { ...inv, status: 'processing' } : inv
              ));

              try {
                if (!invoice.rawImageBase64) throw new Error("No image data");
                
                const processStartTime = Date.now();
                const extractedItems = await processInvoice(invoice.rawImageBase64, currentDb, aiConfig);
                const processTimeMs = Date.now() - processStartTime;
                
                setInvoices(prev => prev.map(inv => 
                  inv.id === invoice.id ? { 
                    ...inv, 
                    status: 'completed', 
                    items: extractedItems,
                    processTimeMs,
                    aiProvider: aiConfig.provider
                  } : inv
                ));
              } catch (e: any) {
                console.error(e);
                setInvoices(prev => prev.map(inv => 
                  inv.id === invoice.id ? { ...inv, status: 'error', error: e.message } : inv
                ));
              } finally {
                  setProcessingStats(prev => ({
                      ...prev,
                      completedCount: prev.completedCount + 1
                  }));
              }
        }));
    }
    
    setIsProcessing(false);
    setProcessingStats({ startTime: null, completedCount: 0, totalCount: 0 });
  };

  const handleExport = () => {
    const exportData = {
      meta: {
        exportedAt: new Date().toISOString(),
        totalInvoices: invoices.length,
        databaseSize: database.length,
        // Removed global provider since each invoice tracks its own
      },
      invoices: invoices.map(inv => ({
        fileName: inv.fileName,
        processedAt: inv.timestamp,
        processTimeMs: inv.processTimeMs,
        aiProvider: inv.aiProvider || aiConfig.provider, // Fallback for older invoices
        // Remove candidates list completely to reduce clutter
        items: inv.items.map(item => {
          const { candidates, ...itemWithoutCandidates } = item;
          return itemWithoutCandidates;
        })
      }))
    };
    downloadJSON(exportData, `invoice_export_${Date.now()}.json`);
  };

  const clearInvoices = () => setInvoices([]);

  return (
    <div className="min-h-screen flex flex-col" onClick={() => isSettingsOpen && setIsSettingsOpen(false)}>
      {/* Header */}
      <header className="bg-white border-b border-slate-200 sticky top-0 z-10" onClick={e => e.stopPropagation()}>
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className={`p-2 rounded-lg text-white transition-colors ${
              aiConfig.provider === 'gemini' ? 'bg-indigo-600' : 
              aiConfig.provider === 'openai' ? 'bg-emerald-600' : 'bg-amber-600'
            }`}>
              <Bot size={24} />
            </div>
            <div>
              <h1 className="text-xl font-bold text-slate-900">InvoiceAI Pro</h1>
              <div className="flex items-center gap-2">
                <span className="text-xs text-slate-500 font-medium">Context Mapping Prototype</span>
                <span className="text-[10px] uppercase font-bold tracking-wider px-1.5 py-0.5 rounded bg-slate-100 text-slate-600">
                  {aiConfig.provider}
                </span>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-3">
             <Settings 
                config={aiConfig} 
                onConfigChange={setAiConfig} 
                isOpen={isSettingsOpen} 
                onToggle={() => setIsSettingsOpen(!isSettingsOpen)} 
             />
             <div className="h-6 w-px bg-slate-200 mx-1"></div>
            <button 
              onClick={handleExport}
              disabled={invoices.length === 0}
              className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Download size={16} />
              Export
            </button>
            <button 
              onClick={handleProcessInvoices}
              disabled={isProcessing || invoices.filter(i => i.status === 'pending').length === 0}
              className={`flex items-center gap-2 px-4 py-2 text-sm font-medium text-white rounded-lg hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed shadow-sm ${
                 aiConfig.provider === 'gemini' ? 'bg-indigo-600 shadow-indigo-200' : 
                 aiConfig.provider === 'openai' ? 'bg-emerald-600 shadow-emerald-200' : 'bg-amber-600 shadow-amber-200'
              }`}
            >
              {isProcessing ? <RefreshCw size={16} className="animate-spin" /> : <Zap size={16} />}
              {isProcessing ? (indexingStatus ? 'Indexing...' : 'Processing...') : 'Process Batch'}
            </button>
          </div>
        </div>
      </header>

      {/* Restore Message */}
      {showRestoreMessage && (
        <div className="bg-emerald-500 text-white text-xs py-2 px-4 text-center">
          Previous session restored
        </div>
      )}

      {/* Main Content */}
      <main className="flex-1 max-w-7xl mx-auto w-full p-6 lg:p-8">
         
        {indexingStatus && (
          <div className="mb-6 p-4 bg-indigo-50 border border-indigo-100 rounded-xl flex items-center gap-3">
            <RefreshCw size={20} className="text-indigo-600 animate-spin shrink-0" />
            <div className="flex-1">
               <p className="text-indigo-800 font-medium text-sm">{indexingStatus}</p>
               <div className="w-full bg-indigo-200 rounded-full h-1.5 mt-2">
                 <div 
                    className="bg-indigo-600 h-1.5 rounded-full transition-all duration-300"
                    style={{ width: `${parseInt(indexingStatus.match(/(\d+)%/)?.[1] || '0')}%` }}
                 ></div>
               </div>
            </div>
          </div>
        )}

        {/* Processing Speed Indicator */}
        {isProcessing && !indexingStatus && processingStats.startTime && (
            <div className="mb-6 p-4 bg-emerald-50 border border-emerald-100 rounded-xl flex items-center gap-3">
                <Zap size={20} className="text-emerald-600 animate-pulse shrink-0" />
                <div className="flex-1">
                    <div className="flex justify-between items-center mb-1">
                        <p className="text-emerald-800 font-medium text-sm">
                            Processing Invoices ({processingStats.completedCount}/{processingStats.totalCount})
                        </p>
                        <span className="text-xs text-emerald-600 font-mono">
                            {(() => {
                                const elapsed = (Date.now() - processingStats.startTime) / 1000;
                                const speed = processingStats.completedCount > 0 ? processingStats.completedCount / elapsed : 0;
                                const remaining = processingStats.totalCount - processingStats.completedCount;
                                const eta = speed > 0 ? Math.ceil(remaining / speed) : 0;
                                return `${speed.toFixed(1)} inv/s | ETA: ${eta}s`;
                            })()}
                        </span>
                    </div>
                    <div className="w-full bg-emerald-200 rounded-full h-1.5">
                        <div 
                            className="bg-emerald-600 h-1.5 rounded-full transition-all duration-300"
                            style={{ width: `${(processingStats.completedCount / processingStats.totalCount) * 100}%` }}
                        ></div>
                    </div>
                </div>
            </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 h-full">
          
          {/* Left Panel: Configuration & Uploads */}
          <div className="lg:col-span-4 space-y-6">
            
            {/* Database Section */}
            <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-5">
              <h2 className="text-lg font-semibold text-slate-800 mb-4 flex items-center gap-2">
                <LayoutDashboard className="text-indigo-500" size={20} />
                1. Reference Dataset
              </h2>
              <div className="space-y-4">
                <Dropzone
                  onFileSelect={handleDatabaseUpload}
                  accept=".csv,.json"
                  label="Upload Product Table (CSV / JSON)"
                  icon={<FileText size={24} />}
                />
                <div className="h-64">
                   <DatabaseViewer data={database} />
                </div>
              </div>
            </div>

            {/* Invoices Upload Section */}
            <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-5">
              <div className="flex justify-between items-center mb-4">
                <h2 className="text-lg font-semibold text-slate-800 flex items-center gap-2">
                  <Upload className="text-indigo-500" size={20} />
                  2. Upload Invoices
                </h2>
                {invoices.length > 0 && (
                   <button onClick={clearInvoices} className="text-xs text-red-500 hover:text-red-700 font-medium">Clear All</button>
                )}
              </div>
              
              <Dropzone 
                onFileSelect={handleInvoiceUpload}
                accept="image/*"
                label="Upload Invoice Images"
                multiple={true}
              />
              
              <div className="mt-4 space-y-2">
                {invoices.map((inv) => (
                   <div key={inv.id} className="flex items-center justify-between p-3 bg-slate-50 rounded-lg border border-slate-100 text-sm group">
                      <div className="flex items-center gap-2 overflow-hidden flex-1 min-w-0 mr-2">
                        <FileText size={16} className="text-slate-400 shrink-0" />
                        <span className="truncate text-slate-700 font-medium" title={inv.fileName}>{inv.fileName}</span>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        {inv.aiProvider && (
                          <span className="text-[10px] text-slate-500 bg-slate-200 px-1.5 py-0.5 rounded-full capitalize">
                            {inv.aiProvider}
                          </span>
                        )}
                        {inv.processTimeMs !== undefined && (
                          <span className="text-xs text-slate-500 font-mono">
                            {(inv.processTimeMs / 1000).toFixed(1)}s
                          </span>
                        )}
                        <span className={`
                          text-[10px] font-medium px-1.5 py-0.5 rounded-full shrink-0
                          ${inv.status === 'pending' ? 'bg-slate-200 text-slate-600' : ''}
                          ${inv.status === 'processing' ? 'bg-indigo-100 text-indigo-700' : ''}
                          ${inv.status === 'completed' ? 'bg-emerald-100 text-emerald-700' : ''}
                          ${inv.status === 'error' ? 'bg-red-100 text-red-700' : ''}
                          ${inv.status === 'restored' ? 'bg-amber-100 text-amber-700' : ''}
                        `}>
                          {inv.status}
                        </span>
                        <button 
                          onClick={() => removeInvoice(inv.id)}
                          className="opacity-0 group-hover:opacity-100 text-slate-400 hover:text-red-500 transition-all"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                   </div>
                ))}
              </div>
            </div>
          </div>

          {/* Right Panel: Results */}
          <div className="lg:col-span-8 space-y-6">
            {/* Process Results */}
            {invoices.length > 0 && (
              <div className="space-y-4">
                {invoices.map(invoice => (
                  <ProcessedResults 
                    key={invoice.id} 
                    invoice={invoice} 
                    database={database}
                    onRetry={handleRetryInvoice}
                  />
                ))}
              </div>
            )}

            {/* Empty State */}
            {invoices.length === 0 && (
              <div className="flex flex-col items-center justify-center h-64 text-slate-400 border-2 border-dashed border-slate-200 rounded-xl">
                <Upload size={48} className="mb-4 text-slate-300" />
                <p className="text-lg font-medium text-slate-500">No invoices uploaded yet</p>
                <p className="text-sm">Upload invoice images to get started</p>
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

import React, { useState, useCallback } from 'react';
import { Product, ProcessedInvoice, AIConfig } from './types';
import { parseCSV, fileToBase64, downloadJSON } from './services/utils';
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

  // Handle CSV Database Upload
  const handleDatabaseUpload = async (files: File[]) => {
    if (files.length === 0) return;
    const file = files[0];
    const text = await file.text();
    const parsedData = parseCSV(text);
    setDatabase(parsedData);
  };

  // Handle Invoice Images Upload
  const handleInvoiceUpload = async (files: File[]) => {
    const newInvoices: ProcessedInvoice[] = [];
    
    for (const file of files) {
      const base64 = await fileToBase64(file);
      newInvoices.push({
        id: Math.random().toString(36).substr(2, 9),
        fileName: file.name,
        status: 'pending',
        items: [],
        timestamp: new Date().toLocaleString(),
        rawImageBase64: base64
      });
    }
    
    setInvoices(prev => [...prev, ...newInvoices]);
  };

  const removeInvoice = (id: string) => {
    setInvoices(prev => prev.filter(inv => inv.id !== id));
  };

  // Process Invoices
  const handleProcessInvoices = async () => {
    if (database.length === 0) {
      alert("Please upload a product database CSV first.");
      return;
    }
    
    if (aiConfig.provider !== 'gemini' && !aiConfig.apiKey) {
      alert(`Please enter an API Key for ${aiConfig.provider} in Settings.`);
      setIsSettingsOpen(true);
      return;
    }
    
    setIsProcessing(true);

    // 1. Check/Index Database
    let currentDb = database;
    const needsIndexing = database.length > 0 && !database[0].embedding;
    
    if (needsIndexing) {
      setIndexingStatus("Initializing database indexing...");
      try {
        currentDb = await generateEmbeddingsForDatabase(database, aiConfig, (current, total) => {
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
    
    for (const invoice of pendingInvoices) {
      setInvoices(prev => prev.map(inv => 
        inv.id === invoice.id ? { ...inv, status: 'processing' } : inv
      ));

      try {
        if (!invoice.rawImageBase64) throw new Error("No image data");
        
        const extractedItems = await processInvoice(invoice.rawImageBase64, currentDb, aiConfig);
        
        setInvoices(prev => prev.map(inv => 
          inv.id === invoice.id ? { 
            ...inv, 
            status: 'completed', 
            items: extractedItems 
          } : inv
        ));
      } catch (e: any) {
        console.error(e);
        setInvoices(prev => prev.map(inv => 
          inv.id === invoice.id ? { ...inv, status: 'error', error: e.message } : inv
        ));
      }
    }
    
    setIsProcessing(false);
  };

  const handleExport = () => {
    const exportData = {
      meta: {
        exportedAt: new Date().toISOString(),
        totalInvoices: invoices.length,
        databaseSize: database.length,
        provider: aiConfig.provider
      },
      invoices: invoices.map(inv => ({
        fileName: inv.fileName,
        processedAt: inv.timestamp,
        items: inv.items
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
                  accept=".csv"
                  label="Upload Product Table (CSV)"
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
                        <span className={`
                            text-xs px-2 py-0.5 rounded-full font-medium uppercase tracking-wide
                            ${inv.status === 'completed' ? 'bg-emerald-100 text-emerald-700' : ''}
                            ${inv.status === 'processing' ? 'bg-indigo-100 text-indigo-700' : ''}
                            ${inv.status === 'pending' ? 'bg-slate-200 text-slate-600' : ''}
                            ${inv.status === 'error' ? 'bg-red-100 text-red-700' : ''}
                        `}>
                            {inv.status}
                        </span>
                        <button 
                          onClick={() => removeInvoice(inv.id)}
                          className="p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-md transition-colors"
                          title="Remove image"
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
          <div className="lg:col-span-8 flex flex-col h-full">
            <h2 className="text-lg font-semibold text-slate-800 mb-4 flex items-center gap-2">
               <Zap className="text-indigo-500" size={20} />
               3. Extracted Data
            </h2>
            
            <div className="flex-1 space-y-6">
              {invoices.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center bg-slate-50 border-2 border-dashed border-slate-200 rounded-2xl p-12 text-center">
                  <div className="bg-white p-4 rounded-full shadow-sm mb-4">
                    <Bot size={32} className="text-slate-300" />
                  </div>
                  <h3 className="text-lg font-medium text-slate-900">Ready to Process</h3>
                  <p className="text-slate-500 max-w-sm mt-2">
                    Upload your product database CSV and invoice images to begin the AI extraction and mapping process.
                  </p>
                </div>
              ) : (
                invoices
                  .filter(inv => inv.status !== 'pending')
                  .map(inv => (
                    <div key={inv.id} className="relative group">
                       <ProcessedResults invoice={inv} database={database} />
                       {inv.status === 'error' && inv.error && (
                         <div className="absolute inset-0 flex items-center justify-center bg-white/80 rounded-xl">
                            <div className="text-red-600 text-sm font-medium bg-red-50 p-4 rounded-lg border border-red-200">
                               Error: {inv.error}
                            </div>
                         </div>
                       )}
                    </div>
                ))
              )}
              
              {invoices.length > 0 && invoices.every(i => i.status === 'pending') && (
                <div className="p-8 text-center bg-indigo-50 border border-indigo-100 rounded-xl">
                   <p className="text-indigo-800 font-medium">Invoices queued.</p>
                   <p className="text-indigo-600 text-sm mt-1">Click "Process Batch" in the top right to start.</p>
                </div>
              )}
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
import React, { useState } from 'react';
import { ProcessedInvoice, Product, InvoiceItem } from '../types';
import { AlertCircle, CheckCircle2, FileJson, ArrowRight, Image as ImageIcon, ChevronDown, ChevronUp, RefreshCw } from 'lucide-react';

interface ProcessedResultsProps {
  invoice: ProcessedInvoice;
  database: Product[];
  onRetry: (invoice: ProcessedInvoice, incorrectItems: InvoiceItem[]) => void;
}

export const ProcessedResults: React.FC<ProcessedResultsProps> = ({ invoice, database, onRetry }) => {
  const [showPreview, setShowPreview] = useState(false);
  const [isRolledUp, setIsRolledUp] = useState(false);
  const [selectedIncorrectIndices, setSelectedIncorrectIndices] = useState<Set<number>>(new Set());

  if (invoice.status === 'pending') return null;

  // For restored invoices, show items but disable image preview and retry
  const isRestored = invoice.status === 'restored';
  // Show items for completed or restored invoices
  const showItems = invoice.status === 'completed' || invoice.status === 'restored';

  const getProduct = (id: string | null) => database.find(p => p.id === id);
  
  const images = Array.isArray(invoice.rawImageBase64) 
    ? invoice.rawImageBase64 
    : (invoice.rawImageBase64 ? [invoice.rawImageBase64] : []);

  const toggleIncorrect = (idx: number) => {
    const newSet = new Set(selectedIncorrectIndices);
    if (newSet.has(idx)) {
      newSet.delete(idx);
    } else {
      newSet.add(idx);
    }
    setSelectedIncorrectIndices(newSet);
  };

  const handleRetry = () => {
    const incorrectItems = invoice.items.filter((_, idx) => selectedIncorrectIndices.has(idx));
    onRetry(invoice, incorrectItems);
    setSelectedIncorrectIndices(new Set()); // Reset selection after retry
  };

  return (
    <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden mt-4">
      <div className="p-4 border-b border-slate-100 bg-slate-50 flex justify-between items-center">
        <div className="flex items-center gap-2">
          <FileJson className="text-emerald-600" size={18} />
          <h3 className="font-semibold text-slate-700">Extraction Results: {invoice.fileName}</h3>
        </div>
        <div className="flex items-center gap-3">
            <span className="text-xs text-slate-400">{invoice.timestamp}</span>
            {invoice.processTimeMs !== undefined && (
              <span className="text-xs text-slate-500 bg-slate-200 px-2 py-0.5 rounded-full">
                {(invoice.processTimeMs / 1000).toFixed(2)}s
              </span>
            )}
            {images.length > 0 && !isRestored && (
                <button 
                    onClick={() => setShowPreview(!showPreview)}
                    className="flex items-center gap-1 text-xs font-medium text-indigo-600 hover:text-indigo-700 bg-indigo-50 hover:bg-indigo-100 px-2 py-1 rounded transition-colors"
                >
                    <ImageIcon size={14} />
                    {showPreview ? 'Hide Image' : 'Show Image'}
                    {showPreview ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                </button>
            )}
            {isRestored && (
                <span className="text-xs bg-amber-100 text-amber-700 px-2 py-1 rounded-full">
                    Restored
                </span>
            )}
            {(invoice.status === 'completed' || invoice.status === 'restored') && (
                <button 
                    onClick={handleRetry}
                    disabled={isRestored}
                    className={`flex items-center gap-1 text-xs font-medium text-white px-3 py-1.5 rounded transition-colors shadow-sm ${
                        isRestored 
                            ? 'bg-slate-400 cursor-not-allowed' 
                            : 'bg-indigo-600 hover:bg-indigo-700'
                    }`}
                    title={isRestored ? 'Re-upload invoice image to retry' : 'Retry processing this invoice'}
                >
                    <RefreshCw size={14} />
                    {isRestored ? 'Re-upload to Retry' : 'Retry Process'}
                </button>
            )}
            {(invoice.status === 'completed' || invoice.status === 'restored') && (
                <button 
                    onClick={() => setIsRolledUp(!isRolledUp)}
                    className="flex items-center gap-1 text-xs font-medium text-slate-600 hover:text-slate-700 bg-slate-100 hover:bg-slate-200 px-2 py-1.5 rounded transition-colors"
                    title={isRolledUp ? 'Expand results' : 'Collapse results'}
                >
                    {isRolledUp ? 'Expand' : 'Collapse'}
                    {isRolledUp ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
                </button>
            )}
        </div>
      </div>

      {showPreview && images.length > 0 && (
        <div className="p-4 bg-slate-100 border-b border-slate-200 overflow-x-auto">
            <div className="flex gap-4">
                {images.map((img, idx) => (
                    <img 
                        key={idx} 
                        src={`data:image/jpeg;base64,${img}`} 
                        alt={`Invoice chunk ${idx + 1}`} 
                        className="h-96 w-auto object-contain rounded-lg border border-slate-300 shadow-sm bg-white"
                    />
                ))}
            </div>
        </div>
      )}

      {invoice.status === 'processing' && (
        <div className="p-8 text-center text-slate-500 animate-pulse">
            <div className="w-12 h-12 border-4 border-indigo-200 border-t-indigo-600 rounded-full animate-spin mx-auto mb-4"></div>
            <p>Analyzing invoice...</p>
        </div>
      )}

      {invoice.status === 'error' && (
        <div className="p-6 bg-red-50 text-red-700 flex flex-col gap-2">
          <div className="flex items-center gap-3">
            <AlertCircle />
            <p className="font-medium">Failed to process this invoice.</p>
          </div>
          {invoice.error && (
            <pre className="text-xs bg-red-100 rounded p-3 overflow-x-auto whitespace-pre-wrap break-all">{invoice.error}</pre>
          )}
        </div>
      )}

      {(showItems && isRolledUp) && (
        <div className="p-4 text-sm text-slate-500 bg-slate-50 border-t border-slate-100 flex justify-between">
            <span>{invoice.items.length} items extracted.</span>
            <span>{invoice.items.filter(i => i.match_status === 'matched').length} matched.</span>
        </div>
      )}
      {(showItems && !isRolledUp) && (
        <div className="overflow-x-auto">
            <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs uppercase text-slate-500">
                <tr>
                {!isRestored && (
                    <th className="px-4 py-3 text-center w-10" title="Mark as incorrect">
                        <AlertCircle size={14} className="mx-auto text-slate-400" />
                    </th>
                )}
                <th className="px-4 py-3 text-left">Raw Extraction (From Image)</th>
                <th className="px-4 py-3 text-center w-8"></th>
                <th className="px-4 py-3 text-left">Mapped DB Product</th>
                <th className="px-4 py-3 text-right">Qty</th>
                <th className="px-4 py-3 text-right">Price</th>
                
                </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
                {invoice.items.map((item, idx) => {
                const matchedProduct = getProduct(item.matched_product_id);
                const isSelected = selectedIncorrectIndices.has(idx);
                
                return (
                    <tr key={idx} className={`hover:bg-slate-50 transition-colors ${isSelected ? 'bg-red-50/50' : ''}`}>
                    {!isRestored && (
                        <td className="px-4 py-3 text-center">
                            <input 
                                type="checkbox" 
                                checked={isSelected}
                                onChange={() => toggleIncorrect(idx)}
                                className="rounded border-slate-300 text-red-600 focus:ring-red-500 cursor-pointer"
                                title="Mark as incorrect for retry"
                            />
                        </td>
                    )}
                    <td className="px-4 py-3">
                        <div className="font-medium text-slate-800">{item.raw_name}</div>
                    </td>
                    <td className="px-4 py-3 text-center">
                        <ArrowRight size={14} className="text-slate-300 mx-auto" />
                    </td>
                    <td className="px-4 py-3">
                        {matchedProduct ? (
                        <div className="flex items-start gap-2">
                            <CheckCircle2 size={16} className={`mt-0.5 shrink-0 ${item.match_status === 'matched' ? 'text-emerald-500' : 'text-amber-500'}`} />
                            <div>
                            <div className="font-medium text-slate-800">{matchedProduct.localName}</div>
                            <div className="text-xs text-slate-500">{matchedProduct.name} ({matchedProduct.id})</div>
                            {item.match_status && (
                                <span className={`inline-block text-[10px] font-medium px-1.5 py-0.5 rounded mt-1 ${
                                    item.match_status === 'matched'
                                        ? 'bg-emerald-100 text-emerald-700'
                                        : 'bg-amber-100 text-amber-700'
                                }`}>
                                    {item.match_status === 'matched' ? 'Matched' : 'Review'}
                                </span>
                            )}
                            {item.reasoning && (
                                <div className="text-[10px] text-slate-400 mt-1 italic border-l-2 border-slate-200 pl-2">
                                    "{item.reasoning}"
                                </div>
                            )}
                            {typeof item.confidence_score === 'number' && (
                                <div className="text-[10px] text-slate-500 mt-1">
                                    Confidence: {(item.confidence_score * 100).toFixed(1)}%
                                </div>
                            )}
                            {item.candidates && item.candidates.length > 0 && (
                                <details className="mt-1">
                                    <summary className="text-[10px] text-indigo-500 cursor-pointer hover:underline select-none">
                                        View {item.candidates.length} Candidates
                                    </summary>
                                    <div className="pl-2 border-l-2 border-indigo-100 mt-1">
                                        {item.candidates.map(c => (
                                            <div key={c.id} className="text-[10px] text-slate-500 truncate" title={`${c.id} — ${c.name} / ${c.localName}`}>
                                                • {c.localName} ({c.name}) <span className="text-slate-400 font-mono">{c.id.slice(0, 8)}</span>{(c as any)._score != null && <span className="text-indigo-400 ml-1">{((c as any)._score * 100).toFixed(0)}%</span>}
                                            </div>
                                        ))}
                                    </div>
                                </details>
                            )}
                            </div>
                        </div>
                        ) : (
                        <div className="flex flex-col gap-1 text-slate-400 italic">
                            <div className="flex items-center gap-2">
                                <AlertCircle size={16} className="text-red-400" />
                                <span>No match found</span>
                                <span className="inline-block text-[10px] font-medium px-1.5 py-0.5 rounded bg-red-100 text-red-700 not-italic">
                                    No Match
                                </span>
                            </div>
                            {item.reasoning && (
                                <div className="text-[10px] text-slate-400 ml-6 border-l-2 border-slate-200 pl-2">
                                    "{item.reasoning}"
                                </div>
                            )}
                            {typeof item.confidence_score === 'number' && (
                                <div className="text-[10px] text-slate-500 ml-6">
                                    Confidence: {(item.confidence_score * 100).toFixed(1)}%
                                </div>
                            )}
                            {item.candidates && item.candidates.length > 0 && (
                                <details className="ml-6">
                                    <summary className="text-[10px] text-indigo-500 cursor-pointer hover:underline select-none">
                                        View {item.candidates.length} Candidates
                                    </summary>
                                    <div className="pl-2 border-l-2 border-indigo-100 mt-1">
                                        {item.candidates.map(c => (
                                            <div key={c.id} className="text-[10px] text-slate-500 truncate" title={`${c.id} — ${c.name} / ${c.localName}`}>
                                                • {c.localName} ({c.name}) <span className="text-slate-400 font-mono">{c.id.slice(0, 8)}</span>{(c as any)._score != null && <span className="text-indigo-400 ml-1">{((c as any)._score * 100).toFixed(0)}%</span>}
                                            </div>
                                        ))}
                                    </div>
                                </details>
                            )}
                        </div>
                        )}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-slate-600">{item.raw_quantity}</td>
                    <td className="px-4 py-3 text-right font-mono text-slate-600">{item.raw_price.toLocaleString()}</td>
                    </tr>
                );
                })}
            </tbody>
            </table>
        </div>
      )}
    </div>
  );
};
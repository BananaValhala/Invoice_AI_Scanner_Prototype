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
  const [selectedIncorrectIndices, setSelectedIncorrectIndices] = useState<Set<number>>(new Set());

  if (invoice.status === 'pending') return null;

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
            {images.length > 0 && (
                <button 
                    onClick={() => setShowPreview(!showPreview)}
                    className="flex items-center gap-1 text-xs font-medium text-indigo-600 hover:text-indigo-700 bg-indigo-50 hover:bg-indigo-100 px-2 py-1 rounded transition-colors"
                >
                    <ImageIcon size={14} />
                    {showPreview ? 'Hide Image' : 'Show Image'}
                    {showPreview ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                </button>
            )}
            {(invoice.status === 'completed' || invoice.status === 'error') && (
                <button 
                    onClick={handleRetry}
                    className="flex items-center gap-1 text-xs font-medium text-white bg-indigo-600 hover:bg-indigo-700 px-3 py-1.5 rounded transition-colors shadow-sm"
                >
                    <RefreshCw size={14} />
                    Retry Process
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
        <div className="p-6 bg-red-50 text-red-700 flex items-center gap-3">
            <AlertCircle />
            <p>Failed to process this invoice. Please try again.</p>
        </div>
      )}

      {invoice.status === 'completed' && (
        <div className="overflow-x-auto">
            <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs uppercase text-slate-500">
                <tr>
                <th className="px-4 py-3 text-center w-10" title="Mark as incorrect">
                    <AlertCircle size={14} className="mx-auto text-slate-400" />
                </th>
                <th className="px-4 py-3 text-left w-1/3">Raw Extraction (From Image)</th>
                <th className="px-4 py-3 text-center w-8"></th>
                <th className="px-4 py-3 text-left w-1/3">Mapped DB Product</th>
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
                    <td className="px-4 py-3 text-center">
                        <input 
                            type="checkbox" 
                            checked={isSelected}
                            onChange={() => toggleIncorrect(idx)}
                            className="rounded border-slate-300 text-red-600 focus:ring-red-500 cursor-pointer"
                            title="Mark as incorrect for retry"
                        />
                    </td>
                    <td className="px-4 py-3">
                        <div className="font-medium text-slate-800">{item.raw_name}</div>
                    </td>
                    <td className="px-4 py-3 text-center">
                        <ArrowRight size={14} className="text-slate-300 mx-auto" />
                    </td>
                    <td className="px-4 py-3">
                        {matchedProduct ? (
                        <div className="flex items-start gap-2">
                            <CheckCircle2 size={16} className="text-emerald-500 mt-0.5 shrink-0" />
                            <div>
                            <div className="font-medium text-slate-800">{matchedProduct.localName}</div>
                            <div className="text-xs text-slate-500">{matchedProduct.name} ({matchedProduct.id})</div>
                            {item.reasoning && (
                                <div className="text-[10px] text-slate-400 mt-1 italic border-l-2 border-slate-200 pl-2">
                                    "{item.reasoning}"
                                </div>
                            )}
                            {item.candidates && item.candidates.length > 0 && (
                                <details className="mt-1">
                                    <summary className="text-[10px] text-indigo-500 cursor-pointer hover:underline select-none">
                                        View {item.candidates.length} Candidates
                                    </summary>
                                    <div className="pl-2 border-l-2 border-indigo-100 mt-1">
                                        {item.candidates.map(c => (
                                            <div key={c.id} className="text-[10px] text-slate-500 truncate" title={`${c.name} / ${c.localName}`}>
                                                • {c.localName} ({c.name})
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
                                <AlertCircle size={16} />
                                <span>No match found</span>
                            </div>
                            {item.reasoning && (
                                <div className="text-[10px] text-slate-400 ml-6 border-l-2 border-slate-200 pl-2">
                                    "{item.reasoning}"
                                </div>
                            )}
                            {item.candidates && item.candidates.length > 0 && (
                                <details className="ml-6">
                                    <summary className="text-[10px] text-indigo-500 cursor-pointer hover:underline select-none">
                                        View {item.candidates.length} Candidates
                                    </summary>
                                    <div className="pl-2 border-l-2 border-indigo-100 mt-1">
                                        {item.candidates.map(c => (
                                            <div key={c.id} className="text-[10px] text-slate-500 truncate" title={`${c.name} / ${c.localName}`}>
                                                • {c.localName} ({c.name})
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
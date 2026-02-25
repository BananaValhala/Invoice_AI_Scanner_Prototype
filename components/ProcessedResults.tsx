import React from 'react';
import { ProcessedInvoice, Product } from '../types';
import { AlertCircle, CheckCircle2, FileJson, ArrowRight } from 'lucide-react';

interface ProcessedResultsProps {
  invoice: ProcessedInvoice;
  database: Product[];
}

export const ProcessedResults: React.FC<ProcessedResultsProps> = ({ invoice, database }) => {
  if (invoice.status === 'processing') {
    return (
      <div className="p-8 text-center text-slate-500 bg-white rounded-xl border border-slate-200 animate-pulse">
        <div className="w-12 h-12 border-4 border-indigo-200 border-t-indigo-600 rounded-full animate-spin mx-auto mb-4"></div>
        <p>Analyzing invoice...</p>
      </div>
    );
  }

  if (invoice.status === 'error') {
    return (
      <div className="p-6 bg-red-50 text-red-700 rounded-xl border border-red-200 flex items-center gap-3">
        <AlertCircle />
        <p>Failed to process this invoice. Please try again.</p>
      </div>
    );
  }

  if (invoice.status === 'pending') return null;

  const getProduct = (id: string | null) => database.find(p => p.id === id);

  return (
    <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden mt-4">
      <div className="p-4 border-b border-slate-100 bg-slate-50 flex justify-between items-center">
        <div className="flex items-center gap-2">
          <FileJson className="text-emerald-600" size={18} />
          <h3 className="font-semibold text-slate-700">Extraction Results: {invoice.fileName}</h3>
        </div>
        <span className="text-xs text-slate-400">{invoice.timestamp}</span>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-xs uppercase text-slate-500">
            <tr>
              <th className="px-4 py-3 text-left w-1/3">Raw Extraction (From Image)</th>
              <th className="px-4 py-3 text-center w-8"></th>
              <th className="px-4 py-3 text-left w-1/3">Mapped DB Product</th>
              <th className="px-4 py-3 text-right">Qty</th>
              <th className="px-4 py-3 text-right">Price</th>
              <th className="px-4 py-3 text-center">Conf.</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {invoice.items.map((item, idx) => {
              const matchedProduct = getProduct(item.matched_product_id);
              const confidenceColor = item.confidence_score > 0.8 ? 'text-emerald-600' : item.confidence_score > 0.5 ? 'text-amber-600' : 'text-red-600';
              
              return (
                <tr key={idx} className="hover:bg-slate-50 transition-colors">
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
                        </div>
                      </div>
                    ) : (
                      <div className="flex items-center gap-2 text-slate-400 italic">
                        <AlertCircle size={16} />
                        <span>No match found</span>
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-slate-600">{item.raw_quantity}</td>
                  <td className="px-4 py-3 text-right font-mono text-slate-600">¥{item.raw_price.toLocaleString()}</td>
                  <td className="px-4 py-3 text-center">
                    <span className={`text-xs font-bold ${confidenceColor}`}>
                      {(item.confidence_score * 100).toFixed(0)}%
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
};
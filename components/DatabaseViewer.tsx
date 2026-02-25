import React, { useState } from 'react';
import { Product } from '../types';
import { Database, Search } from 'lucide-react';

interface DatabaseViewerProps {
  data: Product[];
}

export const DatabaseViewer: React.FC<DatabaseViewerProps> = ({ data }) => {
  const [searchTerm, setSearchTerm] = useState('');

  const filteredData = data.filter(item => 
    item.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
    item.localName.includes(searchTerm) ||
    item.id.toLowerCase().includes(searchTerm.toLowerCase())
  );

  return (
    <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden flex flex-col h-full">
      <div className="p-4 border-b border-slate-100 bg-slate-50 flex justify-between items-center">
        <div className="flex items-center gap-2 text-slate-700 font-semibold">
          <Database size={18} />
          <span>Product Database</span>
          <span className="bg-indigo-100 text-indigo-700 text-xs px-2 py-0.5 rounded-full">
            {data.length} records
          </span>
        </div>
        <div className="relative">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
          <input 
            type="text" 
            placeholder="Search..." 
            className="pl-8 pr-3 py-1.5 text-sm border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 w-48"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
          />
        </div>
      </div>
      
      <div className="overflow-auto flex-1">
        {data.length === 0 ? (
          <div className="h-40 flex flex-col items-center justify-center text-slate-400 p-8 text-center">
            <p>No database loaded.</p>
            <p className="text-xs mt-1">Upload a CSV to get started.</p>
          </div>
        ) : (
          <table className="w-full text-sm text-left">
            <thead className="text-xs text-slate-500 uppercase bg-slate-50 sticky top-0">
              <tr>
                <th className="px-4 py-3">ID</th>
                <th className="px-4 py-3">Local Name</th>
                <th className="px-4 py-3">EN Name</th>
                <th className="px-4 py-3">Unit</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filteredData.slice(0, 100).map((product) => (
                <tr key={product.id} className="hover:bg-slate-50">
                  <td className="px-4 py-2 font-mono text-xs text-slate-500">{product.id}</td>
                  <td className="px-4 py-2 font-medium text-slate-800">{product.localName}</td>
                  <td className="px-4 py-2 text-slate-600">{product.name}</td>
                  <td className="px-4 py-2 text-slate-500">{product.unit}</td>
                </tr>
              ))}
              {filteredData.length > 100 && (
                <tr>
                  <td colSpan={4} className="px-4 py-3 text-center text-xs text-slate-400 italic">
                    Showing first 100 matches...
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
};
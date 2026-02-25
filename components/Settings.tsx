import React from 'react';
import { Settings as SettingsIcon, Key, Check } from 'lucide-react';
import { AIConfig, AIProvider } from '../types';

interface SettingsProps {
  config: AIConfig;
  onConfigChange: (config: AIConfig) => void;
  isOpen: boolean;
  onToggle: () => void;
}

export const Settings: React.FC<SettingsProps> = ({ config, onConfigChange, isOpen, onToggle }) => {
  const handleChange = (key: keyof AIConfig, value: any) => {
    onConfigChange({ ...config, [key]: value });
  };

  return (
    <div className="relative">
      <button 
        onClick={onToggle}
        className={`p-2 rounded-lg transition-colors ${isOpen ? 'bg-indigo-100 text-indigo-700' : 'text-slate-500 hover:bg-slate-100'}`}
        title="AI Settings"
      >
        <SettingsIcon size={20} />
      </button>

      {isOpen && (
        <div className="absolute right-0 top-12 w-80 bg-white rounded-xl shadow-xl border border-slate-200 p-4 z-50">
          <h3 className="text-sm font-semibold text-slate-800 mb-3 flex items-center gap-2">
            <SettingsIcon size={16} />
            AI Provider Configuration
          </h3>
          
          <div className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1">Model Provider</label>
              <div className="grid grid-cols-3 gap-2">
                {(['gemini', 'openai', 'anthropic'] as AIProvider[]).map((p) => (
                  <button
                    key={p}
                    onClick={() => handleChange('provider', p)}
                    className={`
                      px-3 py-2 text-xs font-medium rounded-lg capitalize border transition-all
                      ${config.provider === p 
                        ? 'bg-indigo-50 border-indigo-500 text-indigo-700' 
                        : 'bg-white border-slate-200 text-slate-600 hover:border-slate-300'
                      }
                    `}
                  >
                    {p}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1">
                API Key
                {config.provider === 'gemini' && <span className="text-indigo-500 ml-1">(Optional for Preview)</span>}
              </label>
              <div className="relative">
                <input
                  type="password"
                  value={config.apiKey}
                  onChange={(e) => handleChange('apiKey', e.target.value)}
                  placeholder={`Enter ${config.provider} API Key`}
                  className="w-full pl-9 pr-3 py-2 text-sm border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
                />
                <Key size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              </div>
              <p className="text-[10px] text-slate-400 mt-1">
                {config.provider === 'gemini' 
                  ? "Uses default preview key if left empty."
                  : "Your key is used locally and never stored."}
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
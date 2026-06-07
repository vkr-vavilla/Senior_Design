'use client';

import dynamic from 'next/dynamic';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';

// Monaco touches `window`, so it must only load in the browser (ssr: false).
const MonacoEditor = dynamic(() => import('@monaco-editor/react'), {
  ssr: false,
  loading: () => (
    <div className="h-full flex items-center justify-center bg-slate-900">
      <LoadingSpinner size="sm" />
    </div>
  ),
});

interface CodeEditorProps {
  value: string;
  onChange: (value: string) => void;
  /** Monaco language id, e.g. "python". */
  language?: string;
}

export function CodeEditor({ value, onChange, language = 'python' }: CodeEditorProps) {
  return (
    <MonacoEditor
      height="100%"
      language={language}
      theme="vs-dark"
      value={value}
      onChange={(v) => onChange(v ?? '')}
      options={{
        minimap: { enabled: false },
        fontSize: 14,
        lineNumbers: 'on',
        scrollBeyondLastLine: false,
        automaticLayout: true,
        tabSize: 4,
        padding: { top: 16, bottom: 16 },
      }}
    />
  );
}

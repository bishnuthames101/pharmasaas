'use client';

import { useEffect, useState } from 'react';

type PaperSize = 'thermal' | 'a4';

/**
 * Paper-size switch and print trigger.
 *
 * Auto-prints on first load so completing a sale and getting a receipt is one
 * action, which is what a queue needs. The controls are `print-hide`, so they
 * never reach paper.
 */
export function PrintControls() {
  const [size, setSize] = useState<PaperSize>('thermal');

  useEffect(() => {
    document.getElementById('receipt')?.setAttribute('data-print', size);
  }, [size]);

  useEffect(() => {
    const timer = setTimeout(() => window.print(), 400);
    return () => clearTimeout(timer);
  }, []);

  return (
    <div className="print-hide border-border mx-auto flex w-full max-w-2xl items-center justify-between gap-4 border-b px-4 py-3">
      <div className="flex items-center gap-2 text-sm">
        <span className="text-muted-foreground">Paper</span>
        {(['thermal', 'a4'] as const).map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => setSize(option)}
            className={
              option === size
                ? 'bg-primary text-primary-foreground rounded-md px-3 py-1'
                : 'border-border rounded-md border px-3 py-1'
            }
          >
            {option === 'thermal' ? '80mm roll' : 'A4'}
          </button>
        ))}
      </div>
      <button
        type="button"
        onClick={() => window.print()}
        className="border-border rounded-md border px-3 py-1 text-sm"
      >
        Print again
      </button>
    </div>
  );
}

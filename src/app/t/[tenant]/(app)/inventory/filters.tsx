'use client';

import { useRef } from 'react';

const FILTERS = [
  { value: 'all', label: 'All active' },
  { value: 'low', label: 'Low stock' },
  { value: 'out', label: 'Out of stock' },
  { value: 'controlled', label: 'Controlled' },
  { value: 'inactive', label: 'Inactive' },
];

/**
 * Search and filter bar.
 *
 * A plain GET form, so results live in the URL: staff can bookmark "low stock",
 * the back button behaves, and it still works before hydration. The filter
 * select auto-submits, which is what people expect from a dropdown.
 */
export function InventoryFilters({
  action,
  query,
  filter,
}: {
  action: string;
  query: string;
  filter: string;
}) {
  const formRef = useRef<HTMLFormElement>(null);

  return (
    <form
      ref={formRef}
      action={action}
      method="get"
      className="flex flex-wrap items-end gap-3"
    >
      <div className="flex min-w-64 flex-1 flex-col gap-1.5">
        <label htmlFor="q" className="text-sm font-medium">
          Search
        </label>
        <input
          id="q"
          name="q"
          type="search"
          defaultValue={query}
          placeholder="Brand, generic, composition or barcode"
          className="border-border bg-background focus:border-primary focus:ring-primary/30 rounded-md border px-3 py-2 text-sm focus:ring-2 focus:outline-none"
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="filter" className="text-sm font-medium">
          Show
        </label>
        <select
          id="filter"
          name="filter"
          defaultValue={filter}
          onChange={() => formRef.current?.requestSubmit()}
          className="border-border bg-background rounded-md border px-3 py-2 text-sm"
        >
          {FILTERS.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </select>
      </div>

      <button
        type="submit"
        className="border-border rounded-md border px-4 py-2 text-sm font-medium"
      >
        Search
      </button>
    </form>
  );
}

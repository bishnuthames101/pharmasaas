'use client';

import { useFormStatus } from 'react-dom';
import { cn } from '@/lib/utils';

/**
 * Minimal form primitives. Deliberately not a component library: these are the
 * few controls the auth screens need, styled once so the pharmacy modules in
 * later phases inherit a consistent look.
 */

export function Field({
  label,
  name,
  error,
  hint,
  className,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  name: string;
  error?: string;
  hint?: string;
}) {
  const describedBy = [
    error ? `${name}-error` : null,
    hint ? `${name}-hint` : null,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={name} className="text-sm font-medium">
        {label}
      </label>
      <input
        id={name}
        name={name}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy || undefined}
        className={cn(
          'border-border bg-background rounded-md border px-3 py-2 text-sm',
          'focus:border-primary focus:ring-primary/30 focus:ring-2 focus:outline-none',
          error && 'border-danger',
          className,
        )}
        {...props}
      />
      {hint && (
        <p id={`${name}-hint`} className="text-muted-foreground text-xs">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${name}-error`} className="text-danger text-xs">
          {error}
        </p>
      )}
    </div>
  );
}

export function SelectField({
  label,
  name,
  error,
  hint,
  children,
  ...props
}: React.SelectHTMLAttributes<HTMLSelectElement> & {
  label: string;
  name: string;
  error?: string;
  hint?: string;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={name} className="text-sm font-medium">
        {label}
      </label>
      <select
        id={name}
        name={name}
        aria-invalid={error ? true : undefined}
        className={cn(
          'border-border bg-background rounded-md border px-3 py-2 text-sm',
          'focus:border-primary focus:ring-primary/30 focus:ring-2 focus:outline-none',
          error && 'border-danger',
        )}
        {...props}
      >
        {children}
      </select>
      {hint && <p className="text-muted-foreground text-xs">{hint}</p>}
      {error && <p className="text-danger text-xs">{error}</p>}
    </div>
  );
}

/**
 * Submit button that disables itself while the enclosing form is pending.
 * Uses `useFormStatus`, so it must be rendered inside the `<form>` it submits.
 */
export function SubmitButton({
  children,
  pendingLabel,
  className,
}: {
  children: React.ReactNode;
  pendingLabel?: string;
  className?: string;
}) {
  const { pending } = useFormStatus();

  return (
    <button
      type="submit"
      disabled={pending}
      className={cn(
        'bg-primary text-primary-foreground rounded-md px-4 py-2 text-sm font-medium',
        'disabled:cursor-not-allowed disabled:opacity-60',
        className,
      )}
    >
      {pending ? (pendingLabel ?? 'Working…') : children}
    </button>
  );
}

export function FormError({ children }: { children?: React.ReactNode }) {
  if (!children) return null;
  return (
    <p
      role="alert"
      className="border-danger/30 bg-danger/10 text-danger rounded-md border px-3 py-2 text-sm"
    >
      {children}
    </p>
  );
}

export function FormSuccess({ children }: { children?: React.ReactNode }) {
  if (!children) return null;
  return (
    <p
      role="status"
      className="border-primary/30 bg-primary/10 rounded-md border px-3 py-2 text-sm"
    >
      {children}
    </p>
  );
}

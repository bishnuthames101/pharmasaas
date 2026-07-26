'use client';

import { useActionState } from 'react';
import { signInToTenant } from '@/lib/auth/actions';
import { Field, FormError, SubmitButton } from '@/components/ui/form';
import type { ActionResult } from '@/lib/auth/validation';

export function LoginForm({ slug }: { slug: string }) {
  const [state, formAction] = useActionState<ActionResult, FormData>(
    signInToTenant,
    {},
  );

  return (
    <form action={formAction} className="flex flex-col gap-4">
      {/* The tenant is fixed by the URL; the server re-resolves it and never
          trusts this value for authorization. */}
      <input type="hidden" name="slug" value={slug} />

      <FormError>{state.error}</FormError>

      <Field
        label="Email"
        name="email"
        type="email"
        required
        autoComplete="email"
        autoFocus
        error={state.fieldErrors?.email}
      />

      <Field
        label="Password"
        name="password"
        type="password"
        required
        autoComplete="current-password"
        error={state.fieldErrors?.password}
      />

      <SubmitButton pendingLabel="Signing in…">Sign in</SubmitButton>
    </form>
  );
}

'use client';

import { useActionState, useEffect, useState } from 'react';
import { signUpPharmacy } from '@/lib/auth/actions';
import { checkSlug } from './check-slug';
import { Field, FormError, SubmitButton } from '@/components/ui/form';
import type { ActionResult } from '@/lib/auth/validation';

/** Derive a plausible subdomain from the pharmacy name as it is typed. */
function slugify(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
}

type SlugState = 'idle' | 'checking' | 'available' | 'taken';

export function SignUpForm({ rootDomain }: { rootDomain: string }) {
  const [state, formAction] = useActionState<ActionResult, FormData>(
    signUpPharmacy,
    {},
  );

  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  // Once the owner edits the address themselves, stop overwriting it from the
  // name — otherwise their deliberate choice keeps getting clobbered.
  const [slugTouched, setSlugTouched] = useState(false);

  // Holds the slug a result belongs to, not just the result. Comparing it
  // against the current slug derives the status, which keeps the effect free of
  // synchronous setState and makes out-of-order responses harmless: a reply for
  // a slug the user has already moved on from simply stops matching.
  const [checked, setChecked] = useState<{
    slug: string;
    available: boolean;
  } | null>(null);

  const effectiveSlug = slugTouched ? slug : slugify(name);

  useEffect(() => {
    if (effectiveSlug.length < 2) return;

    // Debounced so a keystroke does not become a round trip.
    const timer = setTimeout(async () => {
      const available = await checkSlug(effectiveSlug);
      setChecked({ slug: effectiveSlug, available });
    }, 350);

    return () => clearTimeout(timer);
  }, [effectiveSlug]);

  const slugState: SlugState =
    effectiveSlug.length < 2
      ? 'idle'
      : checked?.slug === effectiveSlug
        ? checked.available
          ? 'available'
          : 'taken'
        : 'checking';

  const slugHint =
    slugState === 'checking'
      ? 'Checking availability…'
      : slugState === 'available'
        ? `${effectiveSlug}.${rootDomain} is available`
        : slugState === 'taken'
          ? 'That address is not available'
          : `Your workspace will live at ${effectiveSlug || 'your-pharmacy'}.${rootDomain}`;

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <FormError>{state.error}</FormError>

      <Field
        label="Pharmacy name"
        name="pharmacyName"
        required
        autoComplete="organization"
        placeholder="Sunrise Pharmacy"
        value={name}
        onChange={(e) => setName(e.target.value)}
        error={state.fieldErrors?.pharmacyName}
      />

      <Field
        label="Workspace address"
        name="slug"
        required
        placeholder="sunrise"
        value={effectiveSlug}
        onChange={(e) => {
          setSlugTouched(true);
          setSlug(slugify(e.target.value));
        }}
        hint={slugHint}
        error={
          state.fieldErrors?.slug ??
          (slugState === 'taken' ? 'That address is taken' : undefined)
        }
      />

      <Field
        label="Your email"
        name="email"
        type="email"
        required
        autoComplete="email"
        error={state.fieldErrors?.email}
      />

      <Field
        label="Password"
        name="password"
        type="password"
        required
        autoComplete="new-password"
        hint="At least 8 characters."
        error={state.fieldErrors?.password}
      />

      <Field
        label="Phone (optional)"
        name="phone"
        type="tel"
        autoComplete="tel"
        error={state.fieldErrors?.phone}
      />

      <Field
        label="Address (optional)"
        name="address"
        error={state.fieldErrors?.address}
      />

      <SubmitButton pendingLabel="Creating your pharmacy…">
        Create pharmacy
      </SubmitButton>
    </form>
  );
}

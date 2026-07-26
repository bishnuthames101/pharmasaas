import type { Metadata } from 'next';
import Link from 'next/link';
import { env } from '@/env';
import { SignUpForm } from './signup-form';

export const metadata: Metadata = {
  title: 'Create your pharmacy',
};

export default function SignUpPage() {
  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-6 px-6 py-12">
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold">Create your pharmacy</h1>
        <p className="text-muted-foreground text-sm">
          Your workspace is ready immediately — there is nothing to provision
          and no waiting.
        </p>
      </div>

      <SignUpForm rootDomain={env.NEXT_PUBLIC_ROOT_DOMAIN} />

      <p className="text-muted-foreground text-sm">
        Already have a pharmacy?{' '}
        <Link href="/login" className="text-primary underline">
          Sign in
        </Link>
      </p>
    </main>
  );
}

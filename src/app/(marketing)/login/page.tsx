import type { Metadata } from 'next';
import Link from 'next/link';
import { GlobalLoginForm } from './login-form';

export const metadata: Metadata = {
  title: 'Sign in',
};

export default function GlobalLoginPage() {
  return (
    <main className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-6 px-6 py-12">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">Sign in</h1>
        <p className="text-muted-foreground text-sm">
          We&apos;ll take you to your pharmacy. If you work at more than one,
          you can pick.
        </p>
      </div>

      <GlobalLoginForm />

      <p className="text-muted-foreground text-sm">
        Don&apos;t have a pharmacy yet?{' '}
        <Link href="/signup" className="text-primary underline">
          Create one
        </Link>
      </p>
    </main>
  );
}

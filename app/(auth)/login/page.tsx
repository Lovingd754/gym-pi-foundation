import { LoginForm } from '@/components/auth/login-form';
import { NotebookPen } from 'lucide-react';
import { getLocale } from 'next-intl/server';
import { brandName } from '@/lib/brand';

export default async function LoginPage() {
  const name = brandName(await getLocale());
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 p-4">
      <div className="flex items-center gap-2">
        <NotebookPen className="size-7" />
        <span className="text-xl font-semibold tracking-tight">{name}</span>
      </div>
      <LoginForm />
    </main>
  );
}

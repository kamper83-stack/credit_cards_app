import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { useAuth } from './AuthContext';
import { safeRedirectPath } from '../lib/safeRedirect';

export function FullPageSpinner() {
  return (
    <div className="min-h-screen flex items-center justify-center text-slate-400" role="status" aria-live="polite">
      <Loader2 className="animate-spin" size={28} aria-hidden="true" />
      <span className="sr-only">טוען...</span>
    </div>
  );
}

/** Renders children only for an authenticated user; anonymous visitors go to /login. */
export function ProtectedRoute({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  const location = useLocation();
  if (status === 'loading') return <FullPageSpinner />;
  if (status === 'anonymous') {
    const from = safeRedirectPath(location.pathname + location.search + location.hash);
    return <Navigate to="/login" replace state={{ from }} />;
  }
  return <>{children}</>;
}

/** Login / register pages: signed-in users are sent on to where they were headed (or "/"). */
export function GuestRoute({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  const location = useLocation();
  if (status === 'loading') return <FullPageSpinner />;
  if (status === 'authenticated') {
    return <Navigate to={safeRedirectPath((location.state as { from?: unknown } | null)?.from)} replace />;
  }
  return <>{children}</>;
}

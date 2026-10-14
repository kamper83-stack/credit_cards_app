import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown, KeyRound, LogOut, User } from 'lucide-react';
import { useAuth } from '../auth/AuthContext';

export function UserMenu() {
  const { user, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  if (!user) return null;
  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="תפריט משתמש"
        className="flex items-center gap-1.5 px-2 py-1.5 rounded-lg text-sm text-slate-300 hover:text-white hover:bg-slate-800"
      >
        <User size={15} aria-hidden="true" />
        <span dir="ltr" className="hidden md:inline max-w-[14rem] truncate">{user.email}</span>
        <ChevronDown size={13} aria-hidden="true" />
      </button>
      {open && (
        <div role="menu" className="absolute end-0 mt-1 w-56 bg-slate-800 border border-slate-700 rounded-xl shadow-lg p-1 z-50">
          <div dir="ltr" className="px-3 py-2 text-xs text-slate-400 truncate border-b border-slate-700">{user.email}</div>
          <Link to="/settings#password" role="menuitem" onClick={() => setOpen(false)}
            className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-slate-200 hover:bg-slate-700">
            <KeyRound size={14} aria-hidden="true" /> החלפת סיסמה
          </Link>
          <button type="button" role="menuitem" onClick={() => logout.mutate()} disabled={logout.isPending}
            className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-slate-200 hover:bg-slate-700 disabled:opacity-50">
            <LogOut size={14} aria-hidden="true" /> התנתק
          </button>
        </div>
      )}
    </div>
  );
}

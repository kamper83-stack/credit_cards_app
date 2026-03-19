import { Routes, Route, NavLink, Navigate } from 'react-router-dom';
import { LayoutDashboard, CreditCard, ArrowLeftRight, Trophy } from 'lucide-react';
import { Dashboard } from './pages/Dashboard';
import { Cards } from './pages/Cards';
import { Transactions } from './pages/Transactions';

const nav = [
  { to: '/', label: 'סקירה כללית', icon: LayoutDashboard, exact: true },
  { to: '/cards', label: 'כרטיסים', icon: CreditCard },
  { to: '/transactions', label: 'עסקאות', icon: ArrowLeftRight },
];

export default function App() {
  return (
    <div className="min-h-screen flex flex-col">
      {/* Header */}
      <header className="border-b border-slate-800 bg-slate-900/80 backdrop-blur-sm sticky top-0 z-40">
        <div className="max-w-7xl mx-auto px-4 h-14 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Trophy size={20} className="text-amber-400" />
            <span className="font-bold text-white">מעקב הטבות כרטיסי אשראי</span>
          </div>
          <nav className="flex items-center gap-1">
            {nav.map(({ to, label, icon: Icon, exact }) => (
              <NavLink
                key={to}
                to={to}
                end={exact}
                className={({ isActive }) =>
                  `flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm transition-colors ${
                    isActive ? 'bg-slate-700 text-white' : 'text-slate-400 hover:text-white hover:bg-slate-800'
                  }`
                }
              >
                <Icon size={15} />
                <span className="hidden sm:inline">{label}</span>
              </NavLink>
            ))}
          </nav>
        </div>
      </header>

      {/* Main */}
      <main className="flex-1 max-w-7xl mx-auto w-full px-4 py-6">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/cards" element={<Cards />} />
          <Route path="/transactions" element={<Transactions />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}

import {useState} from 'react';
import {Boxes, Brain, GraduationCap, Inbox, KeyRound, LayoutDashboard, LogOut, Menu, MessageCircle, MessageSquareText, Network, Search, X} from 'lucide-react';
import {useRoute} from '../application/use-route.js';
import {ChatsPage} from './pages/ChatsPage.jsx';
import {DashboardPage} from './pages/DashboardPage.jsx';
import {DraftsPage} from './pages/DraftsPage.jsx';
import {GraphPage} from './pages/GraphPage.jsx';
import {MemoriesPage} from './pages/MemoriesPage.jsx';
import {ModelsPage} from './pages/ModelsPage.jsx';
import {PreviewPage} from './pages/PreviewPage.jsx';
import {RagPage} from './pages/RagPage.jsx';
import {TrainingPage} from './pages/TrainingPage.jsx';
import {ErrorNotice, Spinner} from './components/primitives.jsx';

const NAV = [
  {path: '/panel', label: 'Panel', icon: LayoutDashboard, page: DashboardPage},
  {path: '/chats', label: 'Chats', icon: MessageCircle, page: ChatsPage},
  {path: '/preview', label: 'Preview', icon: MessageSquareText, page: PreviewPage},
  {path: '/entrenamiento', label: 'Entrenar identidad', icon: GraduationCap, page: TrainingPage},
  {path: '/modelos', label: 'Modelos', icon: Boxes, page: ModelsPage},
  {path: '/grafo', label: 'Grafo', icon: Network, page: GraphPage},
  {path: '/memorias', label: 'Memorias', icon: Brain, page: MemoriesPage},
  {path: '/borradores', label: 'Borradores', icon: Inbox, page: DraftsPage},
  {path: '/rag', label: 'Búsqueda', icon: Search, page: RagPage}
];

export function App({session}) {
  if (!session.token) return <Login session={session} />;
  return <Shell onLogout={session.logout} />;
}

function Shell({onLogout}) {
  const {path, params} = useRoute();
  const [open, setOpen] = useState(false);
  const current = NAV.find(n => n.path === path) ?? NAV[0];
  const Page = current.page;
  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[15rem_1fr]">
      <aside className={`fixed inset-y-0 left-0 z-40 w-60 border-r border-slate-200 bg-white transition-transform dark:border-slate-800 dark:bg-slate-900 lg:sticky lg:top-0 lg:h-screen lg:translate-x-0 ${open ? 'translate-x-0' : '-translate-x-full'}`}>
        <div className="flex h-14 items-center gap-2 border-b border-slate-100 px-4 dark:border-slate-800">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-brand-600 text-white"><MessageCircle className="h-4 w-4" /></span>
          <span className="text-sm font-semibold">Chat AI Memory</span>
          <button className="btn-ghost ml-auto p-1 lg:hidden" onClick={() => setOpen(false)} aria-label="Cerrar menú"><X className="h-4 w-4" /></button>
        </div>
        <nav className="space-y-0.5 p-2" aria-label="Secciones">
          {NAV.map(({path: p, label, icon: Icon}) => (
            <a key={p} href={`#${p}`} onClick={() => setOpen(false)} aria-current={p === current.path ? 'page' : undefined}
              className={`flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition ${p === current.path
                ? 'bg-brand-50 text-brand-700 dark:bg-brand-900/30 dark:text-brand-100' : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800'}`}>
              <Icon className="h-4 w-4" aria-hidden="true" />{label}
            </a>
          ))}
        </nav>
        <div className="absolute inset-x-0 bottom-0 border-t border-slate-100 p-2 dark:border-slate-800">
          <button className="btn-ghost w-full justify-start" onClick={onLogout}><LogOut className="h-4 w-4" />Cerrar sesión</button>
        </div>
      </aside>
      {open && <div className="fixed inset-0 z-30 bg-slate-950/40 lg:hidden" onClick={() => setOpen(false)} />}
      <div className="min-w-0">
        <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-slate-200 bg-white/80 px-4 backdrop-blur dark:border-slate-800 dark:bg-slate-900/80 lg:hidden">
          <button className="btn-ghost p-1.5" onClick={() => setOpen(true)} aria-label="Abrir menú"><Menu className="h-5 w-5" /></button>
          <span className="text-sm font-semibold">{current.label}</span>
        </header>
        <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8"><Page params={params} /></main>
      </div>
    </div>
  );
}

function Login({session}) {
  const [token, setToken] = useState('');
  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <form className="card w-full max-w-sm p-6" onSubmit={e => {e.preventDefault(); session.login(token.trim());}}>
        <div className="mb-5 flex items-center gap-2">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-brand-600 text-white"><MessageCircle className="h-5 w-5" /></span>
          <div><h1 className="text-base font-semibold">Chat AI Memory</h1><p className="text-xs text-slate-500">Administración local</p></div>
        </div>
        <label className="label" htmlFor="token">ADMIN_TOKEN</label>
        <div className="relative">
          <KeyRound className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-400" aria-hidden="true" />
          <input id="token" type="password" autoComplete="off" className="input pl-9" value={token} onChange={e => setToken(e.target.value)} autoFocus />
        </div>
        <p className="mt-2 text-xs text-slate-500">El valor de ADMIN_TOKEN en tu .env. Se guarda solo en esta pestaña.</p>
        <ErrorNotice error={session.error} className="mt-4" />
        <button className="btn-primary mt-5 w-full" disabled={token.trim().length < 32 || session.checking}>{session.checking && <Spinner />}Entrar</button>
      </form>
    </div>
  );
}

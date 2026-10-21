import { useEffect, useState } from 'react'
import SystemPage from './pages/SystemPage'
import RadarPage from './pages/RadarPage'
import ProjectsPage from './pages/ProjectsPage'
import ProjectDetailPage from './pages/ProjectDetailPage'
import LoginPage from './pages/LoginPage'
import { getToken, clearToken, AUTH_EVENT } from './lib/auth'
import { getJson } from './lib/fetcher'

type PageKey = 'radar' | 'projects' | 'tge' | 'workbench' | 'alerts' | 'system'

const NAV: { key: PageKey; label: string; milestone?: string }[] = [
  { key: 'radar', label: '项目雷达' },
  { key: 'projects', label: '项目池' },
  { key: 'tge', label: 'TGE / 解锁', milestone: 'M4' },
  { key: 'workbench', label: '研究工作台', milestone: 'M5' },
  { key: 'alerts', label: '告警中心', milestone: 'M6' },
  { key: 'system', label: '数据与点数' },
]

interface Route { page: PageKey; projectId?: number }

function readHash(): Route {
  const path = window.location.hash.replace(/^#\/?/, '')
  const m = /^projects\/(\d+)/.exec(path)
  if (m) return { page: 'projects', projectId: Number(m[1]) }
  const k = path.split('/')[0] as PageKey
  return { page: NAV.some((n) => n.key === k) ? k : 'radar' }
}

export default function App() {
  const [route, setRoute] = useState<Route>({ page: 'radar' })
  const [authed, setAuthed] = useState<'checking' | 'yes' | 'no'>('checking')
  const page = route.page

  // 登录状态：有令牌就向后端确认一次；任何接口返回 401 都回到登录页
  useEffect(() => {
    const check = () => {
      if (!getToken()) { setAuthed('no'); return }
      getJson('auth/me').then(() => setAuthed('yes')).catch(() => setAuthed('no'))
    }
    check()
    const onRequired = () => setAuthed('no')
    window.addEventListener(AUTH_EVENT, onRequired)
    return () => window.removeEventListener(AUTH_EVENT, onRequired)
  }, [])

  useEffect(() => {
    setRoute(readHash())
    const onHash = () => { setRoute(readHash()); window.scrollTo(0, 0) }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  const current = NAV.find((n) => n.key === page)!

  if (authed === 'checking') return <div className="min-h-screen bg-background" />
  if (authed === 'no') return <LoginPage onLogin={() => setAuthed('yes')} />

  return (
    <div className="min-h-screen bg-background text-foreground flex">
      <aside className="w-52 shrink-0 border-r border-border-base flex flex-col">
        <div className="px-5 py-5">
          <div className="text-[15px] font-bold tracking-tight">Web3 投研平台</div>
          <div className="text-xs text-fg-muted mt-1">发现 → 评分 → TGE → 复盘</div>
        </div>
        <nav className="flex flex-col gap-0.5 px-2">
          {NAV.map((n) => {
            const active = n.key === page
            return (
              <a
                key={n.key}
                href={`#/${n.key}`}
                className={`flex items-center justify-between rounded-md px-3 py-2 text-sm transition-colors ${
                  active ? 'bg-bg-subtle text-fg-base font-semibold' : 'text-fg-subtle hover:bg-bg-subtle-hover'
                }`}
              >
                <span>{n.label}</span>
                {n.milestone && <span className="text-[10px] text-fg-muted">{n.milestone}</span>}
              </a>
            )
          })}
        </nav>
        <div className="mt-auto px-5 py-4 text-[11px] text-fg-muted leading-5">
          链：ETH · BSC · Base · Arbitrum · SOL · Robinhood
          <button
            onClick={() => { clearToken(); setAuthed('no') }}
            className="block mt-2 text-fg-subtle hover:text-fg-base"
          >
            退出登录
          </button>
        </div>
      </aside>
      <main className="flex-1 min-w-0">
        {page === 'system' ? (
          <SystemPage />
        ) : page === 'radar' ? (
          <RadarPage />
        ) : page === 'projects' ? (
          route.projectId ? <ProjectDetailPage id={route.projectId} key={route.projectId} /> : <ProjectsPage />
        ) : (
          <div className="p-8">
            <h1 className="text-xl font-bold">{current.label}</h1>
            <p className="text-sm text-fg-subtle mt-2">这个模块排在 {current.milestone}，完成后会在这里显示。</p>
          </div>
        )}
      </main>
    </div>
  )
}

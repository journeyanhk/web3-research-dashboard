import { useEffect, useState } from 'react'
import SystemPage from './pages/SystemPage'

type PageKey = 'radar' | 'projects' | 'tge' | 'workbench' | 'alerts' | 'system'

const NAV: { key: PageKey; label: string; milestone?: string }[] = [
  { key: 'radar', label: '项目雷达', milestone: 'M1' },
  { key: 'projects', label: '项目池', milestone: 'M2' },
  { key: 'tge', label: 'TGE / 解锁', milestone: 'M4' },
  { key: 'workbench', label: '研究工作台', milestone: 'M5' },
  { key: 'alerts', label: '告警中心', milestone: 'M6' },
  { key: 'system', label: '数据与点数' },
]

function readHash(): PageKey {
  const k = window.location.hash.replace('#/', '') as PageKey
  return NAV.some((n) => n.key === k) ? k : 'system'
}

export default function App() {
  const [page, setPage] = useState<PageKey>('system')

  useEffect(() => {
    setPage(readHash())
    const onHash = () => setPage(readHash())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  const current = NAV.find((n) => n.key === page)!

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
        </div>
      </aside>
      <main className="flex-1 min-w-0">
        {page === 'system' ? (
          <SystemPage />
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

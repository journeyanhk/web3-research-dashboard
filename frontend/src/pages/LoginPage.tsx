import { useState } from 'react'
import { api } from '@/lib/api'
import { setToken } from '@/lib/auth'

export default function LoginPage({ onLogin }: { onLogin: () => void }) {
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const r = await fetch(api('auth/login'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password }),
      })
      const body = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(body?.error || `登录失败（${r.status}）`)
      setToken(body.token)
      onLogin()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="min-h-screen bg-background text-foreground flex items-center justify-center p-6">
      <form onSubmit={submit} className="w-full max-w-[340px] border border-border-base rounded-lg p-6 flex flex-col gap-4">
        <div>
          <div className="text-[17px] font-bold">Web3 投研平台</div>
          <div className="text-xs text-fg-muted mt-1">请输入访问密码</div>
        </div>
        <input
          type="password"
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="密码"
          className="rounded-md border border-border-base bg-transparent px-3 py-2 text-sm focus:outline-none focus:border-border-focus"
        />
        {error && <p className="text-xs text-destructive">{error}</p>}
        <button type="submit" disabled={busy || !password}
          className="rounded-md bg-fg-base text-background px-3.5 py-2 text-sm font-semibold disabled:opacity-50">
          {busy ? '登录中…' : '登录'}
        </button>
        <p className="text-[11px] text-fg-muted">登录状态保存在本浏览器，30 天有效。</p>
      </form>
    </div>
  )
}

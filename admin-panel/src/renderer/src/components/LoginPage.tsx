import { useState, useEffect } from 'react'
import { AlertCircle, RefreshCw, X, Mail, Lock } from 'lucide-react'
import ZyroMascot from './ZyroMascot'
import { supabase } from '../lib/supabase'

export default function LoginPage({
  onLogin
}: {
  onLogin: (password: string) => void
}): JSX.Element {
  const [email, setEmail] = useState('admin@zyro.ai')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    setLoading(true)
    setError('')

    try {
      // 1. Try real Supabase auth
      const { data, error: authErr } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password: password.trim()
      })

      if (authErr || !data.user) {
        setError(authErr?.message || 'Invalid admin credentials')
        setLoading(false)
        return
      }

      // 2. Verify is_admin field on profile
      const { data: profile, error: profileErr } = await supabase
        .from('profiles')
        .select('is_admin')
        .eq('id', data.user.id)
        .single()

      if (profileErr || !profile?.is_admin) {
        await supabase.auth.signOut()
        setError('This account does not have admin permissions.')
        setLoading(false)
        return
      }

      // 3. Establish the main-process session gate (audit H6): main re-verifies
      // the token and the is_admin flag server-side, then unlocks admin IPC.
      // Kept fresh via onAuthStateChange below — supabase-js rotates the JWT hourly.
      const sessionToken = data.session?.access_token
      if (sessionToken && window.api.setAdminSession) {
        await window.api.setAdminSession(sessionToken)
      }

      onLogin(password)
    } catch (err: any) {
      setError(err.message || 'Authentication error')
      setLoading(false)
    }
  }

  // Keep the main-process session in step with the renderer session: whenever
  // supabase-js refreshes the JWT (hourly), hand the new token to main.
  useEffect(() => {
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session?.access_token && window.api.setAdminSession) {
        window.api.setAdminSession(session.access_token).catch((err: unknown) => {
          console.warn('[AdminLogin] Session sync to main failed:', err)
        })
      }
    })
    return () => sub.subscription.unsubscribe()
  }, [])

  return (
    <div className="login-wrapper">
      <div className="login-card-simple">
        <header className="login-header-simple">
          <div className="login-icon-simple">
            <ZyroMascot size={64} strokeColor="#a78bfa" />
          </div>
          <h1>Zyro Admin Panel</h1>
          <p>Sign in to manage coupons and promotions</p>
        </header>

        <form onSubmit={handleSubmit} className="login-form-simple">
          <div className="login-field-simple">
            <label>Admin Email</label>
            <div className="login-input-box-simple">
              <Mail size={16} />
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="admin@zyro-ai.in"
                required
              />
            </div>
          </div>

          <div className="login-field-simple">
            <label>Master Password</label>
            <div className="login-input-box-simple">
              <Lock size={16} />
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                required
                autoFocus
              />
            </div>
          </div>

          {error && (
            <div className="login-error-simple">
              <AlertCircle size={14} />
              <span>{error}</span>
            </div>
          )}

          <button type="submit" disabled={loading} className="login-btn-simple">
            {loading ? <RefreshCw className="animate-spin" size={18} /> : 'Login to Dashboard'}
          </button>
        </form>

        <div className="login-window-controls">
          <button onClick={() => window.api.closeWindow()} title="Close App">
            <X size={16} />
          </button>
        </div>
      </div>
    </div>
  )
}

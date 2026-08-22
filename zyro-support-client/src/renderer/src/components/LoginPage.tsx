import { useState } from 'react'
import { AlertCircle, RefreshCw, X, Mail, Lock } from 'lucide-react'
import ZyroMascot from './ZyroMascot'

export default function LoginPage({
  onLogin
}: {
  onLogin: (password: string) => void
}): JSX.Element {
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const handleSubmit = (e: React.FormEvent): void => {
    e.preventDefault()
    setLoading(true)
    setError('')

    // Delay to show loading state
    setTimeout(() => {
      if (password === 'Peeyush0000..') {
        onLogin(password)
      } else {
        setError('Invalid admin credentials')
        setLoading(false)
      }
    }, 800)
  }

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
            <label>Master Email</label>
            <div className="login-input-box-simple">
              <Mail size={16} />
              <input type="email" value="admin@zyro.ai" disabled />
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

import React, { useState, useEffect } from 'react'
import { Mail, Lock, Eye, EyeOff, AlertCircle, ArrowRight } from 'lucide-react'
import '../assets/login.css'

import ZyroMascot from './ZyroMascot'

interface UserProfile {
  id: string
  email?: string
  sessions_balance?: number
  trial_seconds_used?: number
}

interface DesktopLoginPageProps {
  onLoginSuccess: (profile: UserProfile) => void
}

export function DesktopLoginPage({ onLoginSuccess }: DesktopLoginPageProps): React.ReactElement {
  const [loading, setLoading] = useState(false)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    // Listen for Google OAuth success from deep link
    const removeListener = window.api.onAuthCallbackSuccess(async ({ accessToken, refreshToken }) => {
      console.log('[DesktopLogin] Received OAuth success from callback!')
      setLoading(true)
      setError('')
      try {
        console.log('[DesktopLogin] Syncing session to main process...')

        // First attempt: main process may have already set userId during handleProtocolUrl
        let profile = await window.api.supabaseGetProfile()

        if (!profile) {
          // Main process may need a moment to resolve userId — do an explicit awaitable sync
          console.log('[DesktopLogin] Profile null, running manual sync...')
          await window.api.supabaseManualSync(accessToken, refreshToken)

          // Retry with backoff — give main process time to complete user fetch
          for (let attempt = 0; attempt < 3; attempt++) {
            await new Promise((r) => setTimeout(r, 600 + attempt * 400))
            profile = await window.api.supabaseGetProfile()
            if (profile) {
              console.log(`[DesktopLogin] Profile resolved on attempt ${attempt + 1}`)
              break
            }
            console.warn(`[DesktopLogin] Profile still null on attempt ${attempt + 1}`)
          }
        }

        if (profile) {
          console.log('[DesktopLogin] Finalizing login for profile:', profile.id)
          onLoginSuccess(profile)
        } else {
          setError('OAuth succeeded but profile sync failed. Please try again.')
        }
      } catch (err) {
        console.error('[DesktopLogin] OAuth sync error:', err)
        setError('Failed to sync session after Google login.')
      } finally {
        setLoading(false)
      }
    })

    return () => {
      removeListener()
    }
  }, [onLoginSuccess])

  const handleEmailLogin = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    if (loading) return
    setError('')

    if (!email.trim() || !password) {
      setError('Please enter your email and password.')
      return
    }

    setLoading(true)
    try {
      console.log('[DesktopLogin] Logging in with email:', email.trim())
      // Main process stores the session securely; renderer never receives raw tokens
      await window.api.supabaseLogin(email.trim(), password)
      console.log('[DesktopLogin] Login success! Fetching profile...')

      // Small delay to let main-process state settle before get-profile
      await new Promise((r) => setTimeout(r, 200))

      const profile = await window.api.supabaseGetProfile()
      if (profile) {
        onLoginSuccess(profile)
      } else {
        setError('Login succeeded, but could not load profile. Please try again.')
      }
    } catch (err: unknown) {
      console.error('[DesktopLogin] Email login error:', err)
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.toLowerCase().includes('email not confirmed') || msg.toLowerCase().includes('not verified')) {
        setError('Your email is not verified yet. Please check your inbox.')
      } else if (msg.toLowerCase().includes('invalid login credentials')) {
        setError('Invalid email or password.')
      } else if (msg.toLowerCase().includes('too many')) {
        setError('Too many login attempts. Please wait a moment and try again.')
      } else {
        setError(msg)
      }
    } finally {
      setLoading(false)
    }
  }

  const handleGoogleLogin = async (): Promise<void> => {
    setError('')
    setLoading(true)
    try {
      console.log('[DesktopLogin] Initiating Google login...')
      await window.api.supabaseLoginGoogle()
    } catch (err: unknown) {
      console.error('[DesktopLogin] Google login error:', err)
      setError(err instanceof Error ? err.message : 'Google login failed.')
      setLoading(false)
    }
    setTimeout(() => setLoading(false), 30000)
  }

  return (
    <div className="login-page-container">
      {/* Background Mesh */}
      <div className="mesh-bg">
        <div className="mesh-orb orb-1" />
        <div className="mesh-orb orb-2" />
        <div className="mesh-orb orb-3" />
        <div className="noise-overlay" />
      </div>

      <div className="login-card">
        {/* Close Button */}
        <div className="close-btn-container">
          <button
            type="button"
            className="login-close-btn"
            onClick={() => window.api.quitApp()}
            aria-label="Close"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="20"
              height="20"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>

        {/* Left Panel: Branding & Status (Draggable) */}
        <div className="login-left-panel">
          <div className="drag-handle drag-handle-left" />
          <div className="grid-overlay" />

          <div className="system-active-badge">Secure Entry Protocol</div>

          <div className="logo-section">
            <div className="pulse-glow-bg" />
            <div className="logo-box-animated">
              <ZyroMascot size={110} strokeColor="#a78bfa" />
            </div>
            <h1 className="logo-text-main">
              Zyro <span>AI</span>
            </h1>
            <p className="logo-description">
              Advanced Interview Intelligence for modern professionals.
            </p>
          </div>

          <div className="status-indicator-container">
            <div className="status-indicator">
              <div className="status-dot" />
              <span className="status-text">SYSTEM ACTIVE</span>
            </div>
          </div>
        </div>

        {/* Right Panel: Login Form (Non-draggable) */}
        <div className="login-right-panel">
          <div className="drag-handle drag-handle-right" />
          <div className="welcome-section">
            <h2 className="welcome-title">Welcome Back</h2>
            <p className="welcome-desc">
              Sign in with your email and password
            </p>
          </div>

          <form className="login-form-content" onSubmit={handleEmailLogin}>
            {/* Email Address */}
            <div className="input-group-enhanced">
              <div className="input-relative">
                <Mail className="input-icon-left" size={20} />
                <input
                  id="email"
                  type="email"
                  className={`input-entry ${error ? 'input-entry-error' : ''}`}
                  placeholder=" "
                  value={email}
                  onChange={(e) => {
                    setEmail(e.target.value)
                    if (error) setError('')
                  }}
                  required
                  autoComplete="email"
                />
                <label htmlFor="email" className="input-entry-label">
                  Email Address
                </label>
                {error && (
                  <div className="field-error-badge" title={error}>
                    <AlertCircle size={12} style={{ flexShrink: 0 }} />
                    <span>{error}</span>
                  </div>
                )}
              </div>
            </div>

            {/* Password */}
            <div className="input-group-enhanced">
              <div className="input-relative">
                <Lock className="input-icon-left" size={20} />
                <input
                  id="password"
                  type={showPassword ? 'text' : 'password'}
                  className={`input-entry ${error ? 'input-entry-error' : ''}`}
                  placeholder=" "
                  value={password}
                  onChange={(e) => {
                    setPassword(e.target.value)
                    if (error) setError('')
                  }}
                  required
                  autoComplete="current-password"
                  style={{ paddingRight: '48px' }}
                />
                <label htmlFor="password" className="input-entry-label">
                  Password
                </label>
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  style={{
                    position: 'absolute',
                    right: '14px',
                    top: '50%',
                    transform: 'translateY(-50%)',
                    background: 'none',
                    border: 'none',
                    color: 'rgba(255,255,255,0.4)',
                    cursor: 'pointer'
                  }}
                >
                  {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
              </div>
            </div>

            <button
              type="submit"
              className={`signin-button-shimmer${loading ? ' is-loading' : ''}`}
              disabled={loading || !email.trim() || !password}
              id="signin-btn"
            >
              {loading ? (
                <>
                  <span className="btn-spinner" />
                  <span>Authenticating...</span>
                </>
              ) : (
                <>
                  <span>Sign In</span>
                  <ArrowRight size={18} />
                </>
              )}
            </button>
          </form>

          <div className="auth-divider">
            <span>Or continue with</span>
          </div>

          <button
            type="button"
            className="google-signin-button"
            onClick={handleGoogleLogin}
            disabled={loading}
          >
            <svg viewBox="0 0 24 24" className="google-icon-svg" xmlns="http://www.w3.org/2000/svg">
              <path
                d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                fill="#4285F4"
              />
              <path
                d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                fill="#34A853"
              />
              <path
                d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z"
                fill="#FBBC05"
              />
              <path
                d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                fill="#EA4335"
              />
            </svg>
            <span>Sign in with Google</span>
          </button>

          <div className="social-footer">
            <p className="footer-prompt">
              Don&rsquo;t have an account?{' '}
              <button
                type="button"
                className="support-button"
                onClick={() =>
                  window.api.openExternal('https://zyro-ai.in/login')
                }
              >
                Sign Up on Web
              </button>
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}

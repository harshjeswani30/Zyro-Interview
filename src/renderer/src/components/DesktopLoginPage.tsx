import React, { useState, useEffect } from 'react'
import { Mail, Lock, Loader2, AlertCircle, ArrowRight } from 'lucide-react'
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
  const [error, setError] = useState('')

  useEffect(() => {
    // Listen for Google OAuth success from deep link
    const removeListener = window.api.onAuthCallbackSuccess(async ({ accessToken }) => {
      console.log('[DesktopLogin] Received OAuth success from callback!')
      setLoading(true)
      setError('')
      try {
        // Sync the session to main process and store it
        console.log('[DesktopLogin] Syncing session to main process...')
        // Get profile first to get the userId
        const profile = await window.api.supabaseGetProfile() // This should work if main process updated its internal token

        // If profile get fails, we might need a dedicated sync call
        // but our main/index.ts updates internal token on SUCCESS

        if (profile) {
          console.log('[DesktopLogin] Finalizing login for profile:', profile.id)
          onLoginSuccess(profile)
        } else {
          // Fallback sync if needed
          await window.api.supabaseManualSync(accessToken)
          const refreshedProfile = await window.api.supabaseGetProfile()
          if (refreshedProfile) {
            onLoginSuccess(refreshedProfile)
          } else {
            setError('OAuth succeeded but profile sync failed.')
          }
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

  const handleLogin = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      console.log('[DesktopLogin] Calling supabaseLogin IPC...')
      await window.api.supabaseLogin(email, password)
      console.log('[DesktopLogin] Login success, fetching profile...')
      const profile = await window.api.supabaseGetProfile()
      console.log('[DesktopLogin] Profile fetched:', profile)
      if (profile) {
        onLoginSuccess(profile)
      } else {
        setError('Connected, but could not load profile.')
      }
    } catch (err: unknown) {
      console.error('[DesktopLogin] Error:', err)
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('Invalid login credentials')) {
        setError('Invalid email or password.')
      } else {
        setError(msg || 'An error occurred during login.')
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
      // Browser has opened — actual completion arrives via deep link (onAuthCallbackSuccess).
      // Keep the spinner going to signal "waiting for OAuth", but reset after a timeout
      // so the button isn't frozen if the user closes the browser or cancels.
    } catch (err: unknown) {
      console.error('[DesktopLogin] Google login error:', err)
      setError(err instanceof Error ? err.message : 'Google login failed.')
      setLoading(false)
    }
    // Reset loading after a reasonable wait window. onAuthCallbackSuccess will take over
    // the UI if OAuth succeeds before this fires.
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
          </div>

          {error && (
            <div className="error-alert-modern">
              <AlertCircle className="error-icon" size={18} />
              <span className="error-message-text">{error}</span>
            </div>
          )}

          <form className="login-form-content" onSubmit={handleLogin}>
            <div className="input-group-enhanced">
              <div className="input-relative">
                <Mail className="input-icon-left" size={20} />
                <input
                  id="email"
                  type="email"
                  className="input-entry"
                  placeholder=" "
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
                <label htmlFor="email" className="input-entry-label">
                  Email Address
                </label>
              </div>
            </div>

            <div className="input-group-enhanced">
              <div className="input-relative">
                <Lock className="input-icon-left" size={20} />
                <input
                  id="password"
                  type="password"
                  className="input-entry with-forgot"
                  placeholder=" "
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
                <label htmlFor="password" className="input-entry-label">
                  Password
                </label>
                <button
                  type="button"
                  className="forgot-password-link"
                  onClick={() =>
                    window.api.openExternal(
                      'https://zyro-interview-website.vercel.app/#forgot-password'
                    )
                  }
                >
                  Forgot?
                </button>
              </div>
            </div>

            <button
              type="submit"
              className="signin-button-shimmer"
              disabled={loading}
              id="signin-btn"
            >
              {loading ? (
                <>
                  <Loader2 className="animate-spin" size={20} />
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
                  window.api.openExternal('https://zyro-interview-website.vercel.app/#pricing')
                }
              >
                Get Started
              </button>
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}

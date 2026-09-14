import React, { useState } from 'react'
import {
  ShieldCheck,
  RefreshCw,
  Mail,
  Lock,
  LogIn,
  CheckCircle2,
} from 'lucide-react'
import { supabase, loadStaffSession } from '../lib/supabase'

export default function StaffLoginPage(): React.JSX.Element {
  // SECURITY (audit C10): the Sign Up tab is gone. Staff accounts are
  // provisioned by an admin in the Admin Control Panel — this page only
  // signs existing staff in (via the main-process staff:login handler).
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')

  const [loading, setLoading] = useState(false)
  const [errorMsg, setErrorMsg] = useState('')
  const [successMsg, setSuccessMsg] = useState('')

  // 1. Google OAuth Browser Login (Exact Zyro AI Website Mechanism)
  const handleGoogleLogin = async () => {
    setLoading(true)
    setErrorMsg('')
    try {
      const { data, error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: {
          redirectTo: 'https://zyro-ai.in/auth/callback',
          skipBrowserRedirect: true
        }
      })
      if (error) throw error

      if (data?.url) {
        if (window.api && window.api.openExternal) {
          window.api.openExternal(data.url)
        } else {
          window.open(data.url, '_blank')
        }
      }
    } catch (err: any) {
      console.error('Google Auth Error:', err)
      setErrorMsg(err.message || 'Google login failed')
    } finally {
      setLoading(false)
    }
  }

  // 2. Email + password sign-in (runs in the main process — audit C3)
  const handleEmailAuth = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!email.trim() || !password.trim()) return

    setLoading(true)
    setErrorMsg('')
    setSuccessMsg('')

    try {
      const { user, session } = await window.staffApi.login({
        email: email.trim(),
        password: password.trim()
      })

      if (user && session) {
        await loadStaffSession(session)
        setSuccessMsg('Signed in. Opening your support desk…')
      }
    } catch (err: any) {
      console.error('Email Auth Error:', err)
      setErrorMsg(err.message || 'Authentication failed. Please check your inputs.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center relative overflow-hidden bg-[#0f0518] font-sans drag-region">
      {/* Background Ambient Glow Layers matching Zyro AI Website */}
      <div className="absolute inset-0 z-0 pointer-events-none overflow-hidden">
        <div className="absolute top-[-10%] left-[-10%] w-[50%] h-[50%] rounded-full bg-gradient-to-br from-purple-600/20 to-indigo-600/10 blur-[130px]" />
        <div className="absolute bottom-[-10%] right-[-10%] w-[50%] h-[50%] rounded-full bg-gradient-to-br from-indigo-600/20 to-purple-600/10 blur-[130px]" />
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] rounded-full bg-purple-500/10 blur-[150px]" />
      </div>

      {/* Main Glassmorphic Login Card */}
      <div className="relative z-10 w-full max-w-[360px] mx-4 p-6 sm:p-7 rounded-[24px] bg-purple-950/20 border border-purple-500/20 backdrop-blur-2xl shadow-[0_20px_60px_rgba(0,0,0,0.7)] flex flex-col items-center scale-95 sm:scale-100 no-drag">

        {/* Zyro AI Header Branding */}
        <div className="flex items-center gap-2.5 mb-4">
          <div className="w-8 h-8 rounded-xl bg-purple-600/20 border border-purple-500/30 flex items-center justify-center text-purple-400 shadow-[0_0_15px_rgba(168,85,247,0.3)]">
            <ShieldCheck className="w-5 h-5" />
          </div>
          <div>
            <h1 className="text-base font-black text-white tracking-wider">Zyro AI</h1>
            <p className="text-[9px] text-purple-400 font-mono">Staff Desk Portal</p>
          </div>
        </div>

        {/* Title */}
        <div className="text-center mb-4">
          <h2 className="text-xl font-bold tracking-tight text-white">Welcome Back</h2>
          <p className="text-xs font-medium text-white/60 mt-1">
            Sign in to access your assigned support desk
          </p>
        </div>

        {/* Google OAuth Button */}
        <button
          type="button"
          onClick={handleGoogleLogin}
          disabled={loading}
          className="w-full py-3.5 px-4 rounded-2xl font-semibold bg-white/10 hover:bg-white/15 border border-white/10 text-white transition-all flex items-center justify-center gap-3 shadow-lg disabled:opacity-50 cursor-pointer text-xs mb-4"
        >
          <svg className="w-5 h-5 shrink-0" viewBox="0 0 24 24">
            <path
              fill="#4285F4"
              d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
            />
            <path
              fill="#34A853"
              d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
            />
            <path
              fill="#FBBC05"
              d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"
            />
            <path
              fill="#EA4335"
              d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"
            />
          </svg>
          <span className="font-semibold text-white">Continue with Google</span>
        </button>

        <div className="flex items-center w-full gap-3 py-2 mb-2">
          <div className="flex-1 h-[1px] bg-white/10" />
          <span className="text-[11px] font-semibold text-white/40 uppercase">OR EMAIL</span>
          <div className="flex-1 h-[1px] bg-white/10" />
        </div>

        {/* Error / Success Banners */}
        {errorMsg && (
          <div className="w-full p-3 mb-4 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-xs text-left">
            {errorMsg}
          </div>
        )}
        {successMsg && (
          <div className="w-full p-3 mb-4 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-300 text-xs text-left flex items-start gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
            <span>{successMsg}</span>
          </div>
        )}

        {/* Sign-in Form */}
        <form onSubmit={handleEmailAuth} className="w-full space-y-4">
          <div className="space-y-1 text-left">
            <label className="block text-xs font-semibold text-white/70 pl-1">
              Email Address
            </label>
            <div className="relative">
              <Mail className="w-4 h-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-white/40" />
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="staff@zyro-ai.in"
                className="w-full pl-10 pr-4 py-3 rounded-2xl bg-white/5 border border-white/10 text-white placeholder-white/30 text-xs focus:outline-none focus:border-purple-500 focus:bg-white/10 transition-all"
              />
            </div>
          </div>

          <div className="space-y-1 text-left">
            <label className="block text-xs font-semibold text-white/70 pl-1">
              Password
            </label>
            <div className="relative">
              <Lock className="w-4 h-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-white/40" />
              <input
                type="password"
                required
                minLength={6}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                className="w-full pl-10 pr-4 py-3 rounded-2xl bg-white/5 border border-white/10 text-white placeholder-white/30 text-xs focus:outline-none focus:border-purple-500 focus:bg-white/10 transition-all"
              />
            </div>
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full py-3.5 mt-2 rounded-2xl font-bold bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 text-white text-xs transition-all shadow-[0_0_20px_rgba(168,85,247,0.35)] disabled:opacity-50 flex items-center justify-center gap-2 cursor-pointer active:scale-[0.98]"
          >
            {loading ? (
              <RefreshCw className="w-4 h-4 animate-spin" />
            ) : (
              <>
                <LogIn className="w-4 h-4" />
                <span>Sign In to Staff Desk</span>
              </>
            )}
          </button>

          <p className="text-center text-[10px] text-white/40">
            Staff accounts are provisioned by an administrator.
          </p>
        </form>
      </div>
    </div>
  )
}

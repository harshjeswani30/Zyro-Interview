import React, { useCallback, useEffect, useRef, useState } from 'react'
import SetupPage from './components/SetupPage'
import OverlayPage from './components/OverlayPage'
import MicSpeakerTest from './components/MicSpeakerTest'
import { DesktopLoginPage } from './components/DesktopLoginPage'
import PegtopLoader from './components/PegtopLoader'
import { supabase } from './lib/supabase'
import './assets/main.css'

interface UserProfile {
  id: string
  email?: string
  sessions_balance?: number
  trial_seconds_used?: number
  [key: string]: unknown
}

type Page = 'login' | 'setup' | 'mic-test' | 'overlay' | 'loading'

function App(): React.ReactElement {
  const [page, setPage] = useState<Page>('loading')
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null)
  // Holds the sessionData that SetupPage built, passed through mic-test to startInterview
  const pendingSessionDataRef = useRef<any>(null)

  useEffect(() => {
    const hash = window.location.hash
    if (hash === '#overlay') {
      const timer = setTimeout(() => setPage('overlay'), 0)
      return (): void => clearTimeout(timer)
    } else {
      const checkLogin = async (): Promise<void> => {
        try {
          const profile = await window.api.supabaseGetProfile()
          if (profile) {
            setUserProfile(profile as UserProfile)
            setPage('setup')
          } else {
            setPage('login')
          }
        } catch {
          setPage('login')
        }
      }
      checkLogin()
      return undefined
    }
  }, [])

  // Listen for session expiry from main process (stale/reused refresh token)
  useEffect(() => {
    const cleanup = window.api.onSessionExpired(() => {
      console.log('[App] Session expired — returning to login')
      setUserProfile(null)
      setPage('login')
    })
    return cleanup
  }, [])

  // ── Real-time subscription ──────────────────────────────────
  useEffect(() => {
    if (!userProfile?.id) return

    const channel = supabase
      .channel('profile-sync')
      .on(
        'postgres_changes',
        {
          event: '*', // Listen to all changes just to be safe, but filter by ID
          schema: 'public',
          table: 'profiles',
          filter: `id=eq.${userProfile.id}`
        },
        (payload) => {
          console.log('[Supabase] Profile changed:', payload.new)
          setUserProfile((prev) => ({ ...prev, ...payload.new }) as UserProfile)
        }
      )
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [userProfile?.id])

  // Real-time automatic profile & session balance sync
  useEffect(() => {
    if (!userProfile?.id) return

    const syncProfile = (): void => {
      window.api.supabaseGetProfile()
        .then((profile) => {
          if (profile) {
            setUserProfile((prev) => ({ ...prev, ...profile }) as UserProfile)
          } else {
            // null means session is dead (401 + token refresh failed) — stop polling and go to login
            console.warn('[App] Profile sync returned null — session may have expired')
          }
        })
        .catch(() => {
          /* silent — network errors are transient */
        })
    }

    // Auto-sync in background every 6 seconds
    const interval = setInterval(syncProfile, 6000)

    // Immediate sync on window focus (e.g. user returns from browser purchase)
    const handleFocus = (): void => syncProfile()
    const handleVisibility = (): void => {
      if (document.visibilityState === 'visible') syncProfile()
    }

    window.addEventListener('focus', handleFocus)
    document.addEventListener('visibilitychange', handleVisibility)

    // Also listen for manual refresh events from child components
    const handleForceRefresh = (e: CustomEvent): void => {
      if (e.detail) {
        setUserProfile((prev) => ({ ...prev, ...e.detail }) as UserProfile)
      }
    }
    window.addEventListener('force-profile-refresh', handleForceRefresh as EventListener)

    return () => {
      clearInterval(interval)
      window.removeEventListener('focus', handleFocus)
      document.removeEventListener('visibilitychange', handleVisibility)
      window.removeEventListener('force-profile-refresh', handleForceRefresh as EventListener)
    }
  }, [userProfile?.id])

  const handleLoginSuccess = (profile: unknown): void => {
    setUserProfile(profile as UserProfile)
    setPage('setup')
  }

  const handleLogout = (): void => {
    setUserProfile(null)
    setPage('login')
  }

  /**
   * Called by SetupPage when the user clicks "Start Interview".
   * Saves the session data, pre-warms the gateway token in background,
   * then routes to the mic/speaker test screen while the token fetches.
   */
  const handleGoToMicTest = useCallback((sessionData: unknown): void => {
    pendingSessionDataRef.current = sessionData
    setPage('mic-test')
  }, [])

  /**
   * Called by MicSpeakerTest when the user clicks "Start Interview" / auto-proceeds.
   * By now the gateway token is pre-warmed and cached — startInterview will not pay
   * the token-fetch latency, so the first LLM answer arrives at full raw speed.
   */
  const handleProceedFromMicTest = useCallback((): void => {
    const sessionData = pendingSessionDataRef.current
    if (!sessionData) return
    window.api.startInterview(sessionData).then((res: { allowed: boolean } | null) => {
      if (res && !res.allowed) {
        // Balance check failed (e.g. trial ended between form fill and mic test)
        // Go back to setup so the paywall can show.
        setPage('setup')
      }
      // On success: the main process opens the overlay BrowserWindow automatically.
      // This main window just stays in the background — no page change needed.
    }).catch(() => setPage('setup'))
  }, [])

  if (page === 'loading') {
    return (
      <div
        style={{
          width: '100vw',
          height: '100vh',
          background: '#0a0a14',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          overflow: 'hidden'
        }}
      >
        <PegtopLoader />
      </div>
    )
  }
  if (page === 'overlay') return <OverlayPage />
  if (page === 'login') return (
    <DesktopLoginPage onLoginSuccess={handleLoginSuccess} />
  )
  if (page === 'mic-test') return (
    <MicSpeakerTest
      onProceed={handleProceedFromMicTest}
      onBack={() => setPage('setup')}
    />
  )
  return (
    <>
      <SetupPage userProfile={userProfile} onLogout={handleLogout} onGoToMicTest={handleGoToMicTest} />
    </>
  )
}

export default App

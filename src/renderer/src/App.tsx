import React, { useEffect, useState } from 'react'
import SetupPage from './components/SetupPage'
import OverlayPage from './components/OverlayPage'
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

type Page = 'login' | 'setup' | 'overlay' | 'loading'

function App(): React.ReactElement {
  const [page, setPage] = useState<Page>('loading')
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null)

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
  return (
    <>
      <SetupPage userProfile={userProfile} onLogout={handleLogout} />
    </>
  )
}

export default App

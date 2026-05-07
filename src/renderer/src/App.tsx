import React, { useEffect, useState } from 'react'
import SetupPage from './components/SetupPage'
import OverlayPage from './components/OverlayPage'
import { DesktopLoginPage } from './components/DesktopLoginPage'
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

  // Background profile refresh every 30 seconds (catches purchases made on website)
  useEffect(() => {
    if (!userProfile?.id) return
    const interval = setInterval(() => {
      window.api.supabaseGetProfile()
        .then((profile) => {
          if (profile) setUserProfile((prev) => ({ ...prev, ...profile }) as UserProfile)
        })
        .catch(() => {
          /* silent */
        })
    }, 30000)

    // Also listen for manual refresh events from child components
    const handleForceRefresh = (e: CustomEvent): void => {
      if (e.detail) {
        setUserProfile((prev) => ({ ...prev, ...e.detail }) as UserProfile)
      }
    }
    window.addEventListener('force-profile-refresh', handleForceRefresh as EventListener)

    return () => {
      clearInterval(interval)
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

  if (page === 'loading') return (
    <div style={{
      width: '100vw',
      height: '100vh',
      background: '#0a0a1a',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center'
    }}>
      <div style={{
        width: 32,
        height: 32,
        border: '3px solid rgba(59,130,246,0.2)',
        borderTop: '3px solid #3b82f6',
        borderRadius: '50%',
        animation: 'spin 0.8s linear infinite'
      }} />
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  )
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

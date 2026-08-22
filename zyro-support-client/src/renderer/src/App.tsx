import { useState, useEffect } from 'react'
import StaffLoginPage from './components/StaffLoginPage'
import { SupportClientMain } from './components/SupportClientMain'
import { supabase } from './lib/supabase'
import { RefreshCw } from 'lucide-react'

export default function App() {
  const [session, setSession] = useState<any>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    // 1. Get initial session
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session)
      setLoading(false)
    })

    // 2. Listen to auth state changes (e.g. Google OAuth redirect)
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session)
      setLoading(false)
    })

    return () => subscription.unsubscribe()
  }, [])

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-950 flex flex-col items-center justify-center text-slate-300 font-sans">
        <RefreshCw className="w-8 h-8 text-purple-500 animate-spin mb-3" />
        <p className="text-sm font-medium">Verifying Staff Authentication...</p>
      </div>
    )
  }

  if (!session) {
    return <StaffLoginPage />
  }

  return <SupportClientMain />
}

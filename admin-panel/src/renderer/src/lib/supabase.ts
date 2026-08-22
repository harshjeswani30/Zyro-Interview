import { createClient } from '@supabase/supabase-js'

export const supabase = createClient(
  import.meta.env.MAIN_VITE_SUPABASE_URL || window.adminEnv?.supabaseUrl || 'https://weqwxoihdfsvjwwcgtat.supabase.co',
  import.meta.env.MAIN_VITE_SUPABASE_ANON_KEY || '***REMOVED***',
  {
    auth: { persistSession: true },
    realtime: { params: { eventsPerSecond: 10 } }
  }
)

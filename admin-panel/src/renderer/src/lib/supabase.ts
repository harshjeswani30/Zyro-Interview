import { createClient } from '@supabase/supabase-js'

export const supabase = createClient(
  import.meta.env.MAIN_VITE_SUPABASE_URL || window.adminEnv?.supabaseUrl,
  import.meta.env.MAIN_VITE_SUPABASE_SERVICE_ROLE_KEY || window.adminEnv?.supabaseServiceKey,
  {
    auth: { persistSession: false },
    realtime: { params: { eventsPerSecond: 10 } }
  }
)

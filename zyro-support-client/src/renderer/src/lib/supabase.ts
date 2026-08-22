import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = import.meta.env.MAIN_VITE_SUPABASE_URL || window.adminEnv?.supabaseUrl
const SUPABASE_ANON_KEY = import.meta.env.MAIN_VITE_SUPABASE_ANON_KEY
const SUPABASE_SERVICE_KEY = import.meta.env.MAIN_VITE_SUPABASE_SERVICE_ROLE_KEY || window.adminEnv?.supabaseServiceKey

// Auth client: uses anon key so sessions, OTP, and user identity work correctly
export const supabase = createClient(
  SUPABASE_URL,
  SUPABASE_ANON_KEY || SUPABASE_SERVICE_KEY,
  {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true
    },
    realtime: { params: { eventsPerSecond: 10 } }
  }
)

// Admin client: uses service role key to bypass RLS for admin-level DB reads/writes
export const supabaseAdmin = createClient(
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY,
  {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  }
)

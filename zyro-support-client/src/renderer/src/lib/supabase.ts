import { createClient } from '@supabase/supabase-js'

// SECURITY (audit C3): the service-role key no longer exists in the renderer.
// This client is authenticated-only: the staff member's own session (obtained
// via the main-process `staff:login` IPC) is loaded into it. Privileged
// reads/writes go through window.staffApi — fixed-shape IPC handlers in main.
const SUPABASE_URL = import.meta.env.MAIN_VITE_SUPABASE_URL || window.adminEnv?.supabaseUrl
const SUPABASE_ANON_KEY =
  import.meta.env.MAIN_VITE_SUPABASE_ANON_KEY || window.adminEnv?.supabaseAnonKey

// Auth client: anon key + the staff user's session (persisted locally).
export const supabase = createClient(
  SUPABASE_URL,
  SUPABASE_ANON_KEY || '',
  {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true
    },
    realtime: { params: { eventsPerSecond: 10 } }
  }
)

/** Load the session returned by the main-process `staff:login` handler. */
export async function loadStaffSession(session: {
  access_token: string
  refresh_token: string
  expires_at?: number
  expires_in?: number
  token_type?: string
  user: unknown
}): Promise<void> {
  await supabase.auth.setSession({
    access_token: session.access_token,
    refresh_token: session.refresh_token
  })
}

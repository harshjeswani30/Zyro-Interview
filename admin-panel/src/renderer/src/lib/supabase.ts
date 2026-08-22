import { createClient } from '@supabase/supabase-js'

export const supabase = createClient(
  import.meta.env.MAIN_VITE_SUPABASE_URL || window.adminEnv?.supabaseUrl || 'https://weqwxoihdfsvjwwcgtat.supabase.co',
  import.meta.env.MAIN_VITE_SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndlcXd4b2loZGZzdmp3d2NndGF0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI5NzI5NDksImV4cCI6MjA4ODU0ODk0OX0.93-tT4Uqo2E2EniSa33ZGtNwGzitkIn3P7nfg3sz14c',
  {
    auth: { persistSession: true },
    realtime: { params: { eventsPerSecond: 10 } }
  }
)

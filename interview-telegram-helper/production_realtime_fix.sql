-- 1. Enable replication for the required tables (if not already enabled)
ALTER TABLE premium_sessions REPLICA IDENTITY FULL;
-- ALTER TABLE premium_messages REPLICA IDENTITY FULL; -- Uncomment if you want realtime messages too

-- 2. Create the publication if it doesn't exist
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
        CREATE PUBLICATION supabase_realtime;
    END IF;
END $$;

-- 3. Add the tables to the publication
-- First remove them if they exist to ensure a clean state, then add back
ALTER PUBLICATION supabase_realtime DROP TABLE IF EXISTS premium_sessions;
-- ALTER PUBLICATION supabase_realtime DROP TABLE IF EXISTS premium_messages;

ALTER PUBLICATION supabase_realtime ADD TABLE premium_sessions;
-- ALTER PUBLICATION supabase_realtime ADD TABLE premium_messages;

-- 4. Verify (Optional: Check results in the output)
-- SELECT * FROM pg_publication_tables WHERE pubname = 'supabase_realtime';

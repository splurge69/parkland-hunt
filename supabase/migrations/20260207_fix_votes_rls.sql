-- Fix RLS policies for votes table
-- This migration addresses the error: "new row violates row-level security policy for tables 'votes'"
--
-- IMPORTANT: Run this migration in your Supabase SQL Editor (Dashboard > SQL Editor)
-- Or apply via Supabase CLI: supabase db push

-- First, ensure RLS is enabled on the votes table
ALTER TABLE votes ENABLE ROW LEVEL SECURITY;

-- Drop existing policies if they exist (to avoid conflicts)
DROP POLICY IF EXISTS "Allow vote inserts" ON votes;
DROP POLICY IF EXISTS "Allow vote reads" ON votes;

-- Allow any user to insert votes
-- The app uses the anon key, so this covers all players
CREATE POLICY "Allow vote inserts" ON votes
  FOR INSERT
  WITH CHECK (true);

-- Allow reading votes for result tallying
CREATE POLICY "Allow vote reads" ON votes
  FOR SELECT
  USING (true);

-- Optional: More restrictive policy that only allows voting on submissions from hunts the player is in
-- Uncomment the following if you want stricter security:
--
-- DROP POLICY IF EXISTS "Allow vote inserts" ON votes;
-- CREATE POLICY "Allow vote inserts for hunt members" ON votes
--   FOR INSERT
--   WITH CHECK (
--     EXISTS (
--       SELECT 1 FROM submissions s
--       JOIN hunt_players hp ON hp.hunt_id = s.hunt_id
--       WHERE s.id = votes.submission_id
--         AND hp.player_id = votes.player_id
--     )
--   );

-- Also ensure Realtime is enabled for hunt_players table
-- This is required for the player list to update in real-time
-- Run this in Supabase Dashboard > Database > Replication, or:
--
-- ALTER PUBLICATION supabase_realtime ADD TABLE hunt_players;

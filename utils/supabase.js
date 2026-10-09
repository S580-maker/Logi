const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false } }
);

/**
 * Backup a row snapshot to Supabase.
 * Table `backups` should exist in your Supabase project:
 *   create table backups (id uuid default gen_random_uuid() primary key,
 *                         payload jsonb, created_at timestamptz default now());
 */
async function backupToSupabase(payload) {
  const { data, error } = await supabase
    .from('backups')
    .insert([{ payload }])
    .select();
  if (error) throw error;
  return data;
}

module.exports = { backupToSupabase };
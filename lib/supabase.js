/**
 * lib/supabase.js — Singleton Supabase client (service-role key).
 * Usage: const { getSupabase } = require('../lib/supabase');
 *        const supabase = getSupabase();
 *
 * Singleton pattern: one client instance per Vercel function cold start.
 * Re-uses the existing connection on warm invocations.
 */

const { createClient } = require('@supabase/supabase-js');

let _client = null;

function getSupabase() {
    if (!_client) {
        _client = createClient(
            process.env.SUPABASE_URL,
            process.env.SUPABASE_KEY
        );
    }
    return _client;
}

module.exports = { getSupabase };

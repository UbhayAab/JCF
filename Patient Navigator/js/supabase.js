// ============================================================
// Patient Navigator: Supabase Client
// ============================================================

import { CONFIG } from './config.js';

let supabase = null;

export function getSupabase() {
  if (supabase) return supabase;

  if (typeof window.supabase === 'undefined' || !window.supabase.createClient) {
    // Don't return null silently: surface the failure so the boot watchdog
    // and any caller can render a useful error instead of hanging.
    const err = new Error(
      'Supabase JS library failed to load (CDN blocked or network unreachable). ' +
      'Check that cdn.jsdelivr.net is reachable from this device.'
    );
    console.error(err);
    throw err;
  }

  supabase = window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);
  return supabase;
}

// An UPDATE that Row Level Security filters out is not an error: PostgREST
// answers 204 No Content and the client hands back { error: null }. So a save
// the database refused looks exactly like a save that worked, and the UI says
// "Saved" over a write that never happened, which gets reported as "the Save
// button does nothing". Wrap an update in this: it asks for the changed rows
// back and treats "nothing came back" as the failure it is.
//
//   await mustWrite(sb.from('patients').update(patch).eq('id', id), 'patient');
//
// Safe on every table we use: wherever a policy allows UPDATE it also allows
// SELECT of that row, so an empty result really does mean nothing changed.
export async function mustWrite(query, what = 'change') {
  const { data, error } = await query.select('id');
  if (error) throw error;
  if (!data || !data.length) {
    throw new Error(`the ${what} was not saved. You may not have permission to change it, or it no longer exists`);
  }
  return data;
}

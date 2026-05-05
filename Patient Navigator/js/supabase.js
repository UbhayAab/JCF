// ============================================================
// Patient Navigator — Supabase Client
// ============================================================

import { CONFIG } from './config.js';

let supabase = null;

export function getSupabase() {
  if (!supabase) {
    if (typeof window.supabase === 'undefined' || !window.supabase.createClient) {
      console.error('Supabase JS library not loaded. Make sure the CDN script is included.');
      return null;
    }
    supabase = window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);
  }
  return supabase;
}

// ============================================================
// Patient Navigator — Configuration
// Replace these values with your Supabase project credentials
// ============================================================

export const CONFIG = {
  // Get these from: Supabase Dashboard → Settings → API
  SUPABASE_URL: 'https://bcgsejdwqefcdaqxykde.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJjZ3NlamR3cWVmY2RhcXh5a2RlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc5MDczNzUsImV4cCI6MjA5MzQ4MzM3NX0.JtTeQdOmKTxwPNb-Cm_uPUbruvQdBpWGahuMIx4g9iU',

  // App settings
  APP_NAME: 'Patient Navigator',
  ORG_NAME: 'Carcinome',
  VERSION: '1.0.0',

  // Pagination
  DEFAULT_PAGE_SIZE: 25,

  // Session
  SESSION_CHECK_INTERVAL: 60000, // Check session every 60s
};

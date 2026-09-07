// ==========================================================
// Configuración de conexión a Supabase.
// La "anon key" es segura de tener aquí, en el navegador —
// está diseñada para eso. La seguridad real la dan las
// políticas RLS que corriste en schema.sql, no este archivo.
// ==========================================================

const SUPABASE_URL = 'https://mlfyuisegkqxqjseylhp.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_iym5wbdi4h5KraMAdYCD-A_L_3fNw6C';

const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

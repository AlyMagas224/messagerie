/**
 * supabase.js — Client de données unique, partagé par tous les modules.
 *
 *  - Si js/config.js est rempli : vrai client Supabase (chargé depuis un CDN,
 *    aucune installation nécessaire) → messagerie entre tous les appareils.
 *  - Sinon : MODE DÉMO local (js/services/local-backend.js) → le site fonctionne
 *    tout de suite, les données restent dans ce navigateur.
 */
import { SUPABASE_URL, SUPABASE_ANON_KEY } from '../config.js';

/** Vrai si config.js contient de vraies valeurs (et non celles d'exemple). */
export const isConfigured =
  /^https:\/\/.+\.supabase\.co\/?$/.test(SUPABASE_URL)
  && !SUPABASE_URL.includes('VOTRE-PROJET')
  && SUPABASE_ANON_KEY.length > 20
  && !SUPABASE_ANON_KEY.includes('VOTRE-CLE');

/** 'supabase' ou 'local' (mode démo). */
export const backendMode = isConfigured ? 'supabase' : 'local';

async function createDataClient() {
  if (isConfigured) {
    const { createClient } = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm');
    return createClient(SUPABASE_URL.replace(/\/$/, ''), SUPABASE_ANON_KEY, {
      auth: { persistSession: true, autoRefreshToken: true },
      realtime: { params: { eventsPerSecond: 10 } },
    });
  }
  const { createLocalClient } = await import('./local-backend.js');
  return createLocalClient();
}

export const supabase = await createDataClient();

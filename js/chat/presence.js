/**
 * presence.js — Indicateur « en ligne / hors ligne ».
 *
 * Utilise Supabase Realtime Presence : chaque client connecté s'annonce
 * sur un canal commun ; la liste des présents est synchronisée
 * automatiquement (déconnexion détectée à la fermeture de l'onglet).
 * En complément, profiles.last_seen est mis à jour régulièrement pour
 * afficher « vu à 14:05 » lorsque la personne est hors ligne.
 */
import { supabase } from '../services/supabase.js';
import { state, emit } from './state.js';

const HEARTBEAT_MS = 60_000;

export function initPresence() {
  const channel = supabase.channel('presence:global', {
    config: { presence: { key: state.user.id } },
  });

  // À chaque synchronisation, on reconstruit l'ensemble des utilisateurs en ligne
  channel.on('presence', { event: 'sync' }, () => {
    state.online = new Set(Object.keys(channel.presenceState()));
    emit('presence:changed');
  });

  channel.subscribe(async (status) => {
    if (status === 'SUBSCRIBED') {
      await channel.track({ online_at: new Date().toISOString() });
    }
  });

  // Date de dernière activité : maintenant, puis toutes les minutes
  const beat = () => supabase.rpc('heartbeat');
  beat();
  setInterval(beat, HEARTBEAT_MS);
  window.addEventListener('pagehide', beat);
}

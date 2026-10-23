/**
 * state.js — État partagé de l'application et bus d'événements.
 *
 * Les modules (salons, contacts, messages…) ne s'importent pas entre eux
 * pour éviter les dépendances circulaires : ils communiquent en émettant
 * et en écoutant des événements sur ce bus.
 *
 * Événements utilisés :
 *   'room:open'        (roomId)      ouvrir un salon
 *   'room:closed'      ()            revenir à la liste (mobile) / salon quitté
 *   'rooms:reload'     ()            recharger la liste des salons
 *   'rooms:changed'    ()            la liste des salons a été rechargée
 *   'presence:changed' ()            un utilisateur s'est connecté / déconnecté
 *   'contacts:changed' ()            la liste de contacts a changé
 *   'message:new'      (message)     un message a été reçu (temps réel)
 */
import { supabase } from '../services/supabase.js';

export const state = {
  /** Utilisateur connecté (objet auth de Supabase). */
  user: null,
  /** Profil de l'utilisateur connecté { id, username, avatar_color }. */
  me: null,
  /** Cache des profils connus : id → profil. */
  profiles: new Map(),
  /** Identifiants des contacts de l'utilisateur. */
  contactIds: [],
  /** Salons retournés par get_my_rooms(). */
  rooms: [],
  /** Salon actuellement ouvert. */
  currentRoomId: null,
  /** Membres du salon ouvert : [{ user_id, last_read_at, last_delivered_at }]. */
  members: [],
  /** Messages chargés du salon ouvert (ordre chronologique). */
  messages: [],
  /** Réactions du salon ouvert : id → réaction. */
  reactions: new Map(),
  /** Identifiants des utilisateurs en ligne (Realtime Presence). */
  online: new Set(),
};

/* ------------------------------------------------------------------ */
/* Bus d'événements                                                    */
/* ------------------------------------------------------------------ */

const bus = new EventTarget();

/** Abonne une fonction à un événement. */
export function on(type, handler) {
  bus.addEventListener(type, (event) => handler(event.detail));
}

/** Émet un événement avec une donnée optionnelle. */
export function emit(type, detail) {
  bus.dispatchEvent(new CustomEvent(type, { detail }));
}

/* ------------------------------------------------------------------ */
/* Cache des profils                                                   */
/* ------------------------------------------------------------------ */

/** Charge dans le cache les profils absents (une seule requête). */
export async function ensureProfiles(ids) {
  const missing = [...new Set(ids)].filter((id) => id && !state.profiles.has(id));
  if (missing.length === 0) return;
  const { data, error } = await supabase
    .from('profiles')
    .select('id, username, avatar_color, last_seen')
    .in('id', missing);
  if (error) {
    console.error('Chargement des profils :', error);
    return;
  }
  for (const profile of data) state.profiles.set(profile.id, profile);
}

/** Retourne un profil du cache (ou un profil générique). */
export function getProfile(id) {
  return state.profiles.get(id) ?? { id, username: 'Inconnu', avatar_color: '#8a8f98' };
}

/** Vrai si l'utilisateur est actuellement en ligne. */
export function isOnline(id) {
  return state.online.has(id);
}

/** Salon actuellement ouvert (objet de state.rooms). */
export function currentRoom() {
  return state.rooms.find((room) => room.id === state.currentRoomId) ?? null;
}

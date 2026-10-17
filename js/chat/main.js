/**
 * main.js — Point d'entrée de chat.html.
 * Vérifie la session, charge le profil, puis initialise chaque module.
 */
import { supabase, backendMode } from '../services/supabase.js';
import { $, avatar, toast } from '../utils/dom.js';
import { state, on } from './state.js';
import { initPresence } from './presence.js';
import { initNotifications } from './notifications.js';
import { initContacts } from './contacts.js';
import { initRooms, loadRooms } from './rooms.js';
import { initMembers } from './members.js';
import { initMessages, openRoom } from './messages.js';

/* ------------------------------------------------------------------ */
/* 1. Protection de la page : il faut être connecté                    */
/* ------------------------------------------------------------------ */

const { data: { session } } = await supabase.auth.getSession();
if (!session) {
  window.location.replace('connexion.html');
  await new Promise(() => {}); // stoppe le script pendant la redirection
}
state.user = session.user;

// Déconnexion depuis un autre onglet ou expiration de la session
supabase.auth.onAuthStateChange((event) => {
  if (event === 'SIGNED_OUT') window.location.replace('connexion.html');
});

/* ------------------------------------------------------------------ */
/* 2. Profil de l'utilisateur connecté                                 */
/* ------------------------------------------------------------------ */

const { data: profile, error } = await supabase
  .from('profiles')
  .select('id, username, avatar_color, last_seen')
  .eq('id', state.user.id)
  .single();

if (error || !profile) {
  console.error('Profil introuvable :', error);
  // Mode démo : les données du navigateur ont été effacées → on repart de la connexion
  if (backendMode === 'local') {
    await supabase.auth.signOut();
    window.location.replace('connexion.html');
  }
  $('#loader p').textContent = 'Profil introuvable. Vérifiez que supabase/schema.sql a bien été exécuté.';
  throw error ?? new Error('Profil introuvable');
}

state.me = profile;
state.profiles.set(profile.id, profile);
$('#me-avatar').replaceChildren(avatar(profile));
$('#me-name').textContent = profile.username;

/* ------------------------------------------------------------------ */
/* 3. Onglets Salons / Contacts et déconnexion                         */
/* ------------------------------------------------------------------ */

/** Affiche l'onglet 'rooms' ou 'contacts' de la barre latérale. */
function showTab(name) {
  document.querySelectorAll('.sidebar .tab').forEach((tab) => {
    const active = tab.dataset.tab === name;
    tab.classList.toggle('is-active', active);
    tab.setAttribute('aria-selected', String(active));
  });
  $('#panel-rooms').hidden = name !== 'rooms';
  $('#panel-contacts').hidden = name !== 'contacts';
}

document.querySelectorAll('.sidebar .tab').forEach((tab) => {
  tab.addEventListener('click', () => showTab(tab.dataset.tab));
});

$('#btn-logout').addEventListener('click', async () => {
  await supabase.auth.signOut();
  window.location.replace('index.html');
});

/* ------------------------------------------------------------------ */
/* 4. Initialisation des modules                                       */
/* ------------------------------------------------------------------ */

initNotifications();
initPresence();
initMembers();
initMessages();
await Promise.all([initContacts(), initRooms()]);

// Ouverture d'un salon demandée par n'importe quel module
on('room:open', async (roomId) => {
  if (!state.rooms.some((room) => room.id === roomId)) await loadRooms();
  if (!state.rooms.some((room) => room.id === roomId)) {
    toast('Ce salon est introuvable ou vous n\'en êtes plus membre.', 'error');
    return;
  }
  showTab('rooms');
  openRoom(roomId);
});

// Application prête
$('#loader').hidden = true;
$('#app').hidden = false;

// Rechargement de la page : on rouvre le salon indiqué dans l'URL (#id)
const roomFromUrl = window.location.hash.slice(1);
if (roomFromUrl && state.rooms.some((room) => room.id === roomFromUrl)) {
  openRoom(roomFromUrl);
}

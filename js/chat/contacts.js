/**
 * contacts.js — Liste de contacts : affichage, ajout par pseudo, suppression,
 * et ouverture d'une conversation privée avec un contact.
 */
import { supabase } from '../services/supabase.js';
import { $, el, avatar, formatLastSeen, escapeLike, toast } from '../utils/dom.js';
import { backendMode } from '../services/supabase.js';
import { state, on, emit, getProfile, isOnline } from './state.js';

const list = $('#contact-list');
const emptyMessage = $('#contacts-empty');
const form = $('#add-contact-form');

export async function initContacts() {
  form.addEventListener('submit', onAddContact);
  $('#start-chat-form').addEventListener('submit', onStartChat);
  on('presence:changed', renderContacts);
  await loadContacts();
}

/** Charge les contacts et leur profil (jointure via la clé étrangère). */
export async function loadContacts() {
  const { data, error } = await supabase
    .from('contacts')
    .select('contact_id, contact:profiles!contacts_contact_id_fkey (id, username, avatar_color, last_seen)')
    .order('created_at', { ascending: true });

  if (error) {
    console.error('Chargement des contacts :', error);
    toast('Impossible de charger les contacts.', 'error');
    return;
  }

  state.contactIds = [];
  for (const row of data) {
    if (!row.contact) continue;
    state.profiles.set(row.contact.id, row.contact);
    state.contactIds.push(row.contact.id);
  }
  renderContacts();
  emit('contacts:changed');
}

/** Affiche la liste : les contacts en ligne d'abord, puis par ordre alphabétique. */
function renderContacts() {
  const contacts = state.contactIds
    .map(getProfile)
    .sort((a, b) =>
      Number(isOnline(b.id)) - Number(isOnline(a.id)) || a.username.localeCompare(b.username, 'fr'));

  list.replaceChildren(...contacts.map((profile) => {
    const online = isOnline(profile.id);
    return el('li', { className: 'list-item' }, [
      el('button', {
        className: 'list-item-main',
        attrs: { type: 'button', title: `Écrire à ${profile.username}` },
        on: { click: () => openDirect(profile.id) },
      }, [
        avatar(profile, true, online),
        el('span', { className: 'list-item-text' }, [
          el('strong', { text: profile.username }),
          el('small', {
            className: online ? 'text-online' : 'muted',
            text: online ? 'en ligne' : formatLastSeen(profile.last_seen),
          }),
        ]),
      ]),
      el('button', {
        className: 'icon-btn icon-btn-small',
        text: '✕',
        attrs: { type: 'button', title: `Retirer ${profile.username} des contacts` },
        on: { click: () => removeContact(profile) },
      }),
    ]);
  }));
  emptyMessage.hidden = contacts.length > 0;
}

/**
 * Recherche un utilisateur par pseudo exact (insensible à la casse).
 * Affiche un message et retourne null s'il est introuvable ou s'il s'agit de soi-même.
 */
async function findUser(username) {
  const { data: profile, error } = await supabase
    .from('profiles')
    .select('id, username, avatar_color, last_seen')
    .ilike('username', escapeLike(username))
    .maybeSingle();

  if (error) {
    toast('Erreur lors de la recherche.', 'error');
    return null;
  }
  if (!profile) {
    toast(backendMode === 'local'
      ? `Aucun utilisateur « ${username} » dans ce navigateur. En mode démo, les comptes créés sur un autre navigateur ou appareil sont invisibles : configurez Supabase (voir Aide).`
      : `Aucun utilisateur « ${username} ». Vérifiez l'orthographe du pseudo.`, 'error');
    return null;
  }
  if (profile.id === state.me.id) {
    toast('Vous ne pouvez pas vous écrire à vous-même.', 'error');
    return null;
  }
  return profile;
}

/** Ajoute un profil aux contacts (sans erreur s'il y est déjà). */
async function addToContacts(profile) {
  if (state.contactIds.includes(profile.id)) return true;
  const { error } = await supabase.from('contacts').insert({ user_id: state.me.id, contact_id: profile.id });
  if (error && error.code !== '23505') {
    toast("Impossible d'ajouter ce contact.", 'error');
    return false;
  }
  await loadContacts();
  return true;
}

/** Onglet Contacts : ajout d'un contact par pseudo. */
async function onAddContact(event) {
  event.preventDefault();
  const input = form.elements.username;
  const username = input.value.trim();
  if (!username) return;

  const profile = await findUser(username);
  if (!profile) return;
  if (state.contactIds.includes(profile.id)) return toast(`${profile.username} est déjà dans vos contacts.`);
  if (!(await addToContacts(profile))) return;

  input.value = '';
  toast(`${profile.username} a été ajouté à vos contacts.`, 'success');
}

/** Onglet Salons : « Écrire à… » ouvre directement la conversation privée. */
async function onStartChat(event) {
  event.preventDefault();
  const input = event.currentTarget.elements.username;
  const username = input.value.trim();
  if (!username) return;

  const profile = await findUser(username);
  if (!profile || !(await addToContacts(profile))) return;

  input.value = '';
  await openDirect(profile.id);
}

async function removeContact(profile) {
  if (!confirm(`Retirer ${profile.username} de vos contacts ?`)) return;
  const { error } = await supabase
    .from('contacts')
    .delete()
    .match({ user_id: state.me.id, contact_id: profile.id });
  if (error) return toast('Suppression impossible.', 'error');
  await loadContacts();
}

/** Ouvre (ou crée) la conversation privée avec un contact. */
export async function openDirect(userId) {
  const { data: roomId, error } = await supabase.rpc('get_or_create_direct_room', { p_other: userId });
  if (error) {
    console.error(error);
    return toast("Impossible d'ouvrir la conversation.", 'error');
  }
  // main.js recharge la liste des salons si ce salon n'y figure pas encore
  emit('room:open', roomId);
}

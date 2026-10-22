/**
 * rooms.js — Liste des salons de conversation et création d'un salon de groupe.
 */
import { supabase } from '../services/supabase.js';
import { $, el, avatar, formatShort, toast } from '../utils/dom.js';
import { state, on, emit, getProfile, isOnline, ensureProfiles } from './state.js';
import { updateUnreadCounter } from './notifications.js';

const list = $('#room-list');
const emptyMessage = $('#rooms-empty');
const dialog = $('#dialog-new-room');
const form = $('#new-room-form');

let reloadTimer = null;

export async function initRooms() {
  $('#btn-new-room').addEventListener('click', openNewRoomDialog);
  form.addEventListener('submit', onCreateRoom);
  dialog.querySelector('[data-close]').addEventListener('click', () => dialog.close());

  on('presence:changed', renderRooms);
  // Rechargement « groupé » : plusieurs demandes rapprochées = une seule requête
  on('rooms:reload', () => {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(loadRooms, 300);
  });

  await loadRooms();
}

/** Récupère les salons (RPC get_my_rooms : aperçu + non-lus en une requête). */
export async function loadRooms() {
  const { data, error } = await supabase.rpc('get_my_rooms');
  if (error) {
    console.error('Chargement des salons :', error);
    toast('Impossible de charger les salons.', 'error');
    return;
  }
  state.rooms = data;
  await ensureProfiles(data.map((room) => room.other_user_id));
  renderRooms();
  emit('rooms:changed');
}

/** Affiche la liste des salons. */
export function renderRooms() {
  list.replaceChildren(...state.rooms.map((room) => {
    const unread = Number(room.unread_count || 0);
    const isActive = room.id === state.currentRoomId;

    // Avatar : celui de l'autre personne (privé) ou l'initiale du salon (groupe)
    const roomAvatar = room.is_direct
      ? avatar(getProfile(room.other_user_id), true, isOnline(room.other_user_id))
      : avatar({ username: room.name, avatar_color: '#6e7781' });

    return el('li', { className: `list-item ${isActive ? 'is-active' : ''} ${unread ? 'has-unread' : ''}` }, [
      el('button', {
        className: 'list-item-main',
        attrs: { type: 'button', 'aria-current': isActive ? 'true' : 'false' },
        on: { click: () => emit('room:open', room.id) },
      }, [
        roomAvatar,
        el('span', { className: 'list-item-text' }, [
          el('span', { className: 'list-item-row' }, [
            el('strong', { text: room.is_direct ? room.name : `# ${room.name}` }),
            el('small', { className: 'muted', text: formatShort(room.last_message_at) }),
          ]),
          el('span', { className: 'list-item-row' }, [
            el('small', { className: 'preview muted', text: room.last_message ?? 'Aucun message' }),
            unread ? el('span', { className: 'badge', text: unread > 99 ? '99+' : String(unread) }) : null,
          ]),
        ]),
      ]),
    ]);
  }));

  emptyMessage.hidden = state.rooms.length > 0;
  updateUnreadCounter();
}

/** Met à zéro le compteur de non-lus d'un salon (localement). */
export function clearUnread(roomId) {
  const room = state.rooms.find((r) => r.id === roomId);
  if (room && Number(room.unread_count) !== 0) {
    room.unread_count = 0;
    renderRooms();
  }
}

/** Met à jour l'aperçu d'un salon quand un message arrive (sans requête réseau). */
export function applyIncomingMessage(message) {
  const room = state.rooms.find((r) => r.id === message.room_id);
  if (!room) {
    emit('rooms:reload'); // nouveau salon : on recharge la liste
    return;
  }
  room.last_message = message.content ?? '📷 Image';
  room.last_message_at = message.created_at;
  const isMine = message.user_id === state.me.id;
  const isVisible = message.room_id === state.currentRoomId && document.visibilityState === 'visible';
  if (!isMine && !isVisible) room.unread_count = Number(room.unread_count || 0) + 1;

  // Le salon remonte en tête de liste
  state.rooms.sort((a, b) => new Date(b.last_message_at) - new Date(a.last_message_at));
  renderRooms();
}

/* ------------------------------------------------------------------ */
/* Création d'un salon de groupe                                       */
/* ------------------------------------------------------------------ */

function openNewRoomDialog() {
  const membersList = $('#new-room-members');
  const contacts = state.contactIds.map(getProfile);

  membersList.replaceChildren(...(contacts.length
    ? contacts.map((profile) => el('li', {}, [
        el('label', { className: 'check-item' }, [
          el('input', { attrs: { type: 'checkbox', name: 'members', value: profile.id } }),
          avatar(profile),
          el('span', { text: profile.username }),
        ]),
      ]))
    : [el('li', { className: 'muted', text: "Vous n'avez aucun contact. Ajoutez d'abord des contacts (onglet Contacts) pour créer un groupe." })]));
  form.querySelector('button[type="submit"]').disabled = contacts.length === 0;

  form.reset();
  dialog.showModal();
  form.elements.name.focus();
}

async function onCreateRoom(event) {
  event.preventDefault();
  const name = form.elements.name.value.trim();
  if (!name) return form.elements.name.focus();

  const memberIds = [...form.querySelectorAll('input[name="members"]:checked')].map((input) => input.value);
  if (memberIds.length === 0) {
    return toast('Cochez au moins un membre : un salon avec vous seul ne permet pas de discuter.', 'error');
  }

  const { data: roomId, error } = await supabase.rpc('create_room', {
    p_name: name,
    p_member_ids: memberIds,
  });
  if (error) {
    console.error(error);
    return toast('Création du salon impossible.', 'error');
  }

  dialog.close();
  toast(`Salon « ${name} » créé.`, 'success');
  await loadRooms();
  emit('room:open', roomId);
}

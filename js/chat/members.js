/**
 * members.js — Membres du salon ouvert : chargement, affichage dans une boîte
 * de dialogue, ajout d'un contact au salon et départ du salon.
 */
import { supabase } from '../services/supabase.js';
import { $, el, avatar, formatLastSeen, toast } from '../utils/dom.js';
import { state, on, emit, ensureProfiles, getProfile, isOnline, currentRoom } from './state.js';

const dialog = $('#dialog-members');
const list = $('#member-list');
const addZone = $('#add-member-zone');
const select = $('#add-member-select');

export function initMembers() {
  $('#btn-members').addEventListener('click', openDialog);
  $('#btn-add-member').addEventListener('click', addMember);
  $('#btn-leave-room').addEventListener('click', leaveRoom);
  dialog.querySelector('[data-close]').addEventListener('click', () => dialog.close());
  on('presence:changed', () => { if (dialog.open) renderMembers(); });
}

/** Charge les membres d'un salon (avec leurs accusés de réception / lecture). */
export async function loadMembers(roomId) {
  const { data, error } = await supabase
    .from('room_members')
    .select('user_id, last_read_at, last_delivered_at')
    .eq('room_id', roomId);
  if (error) {
    console.error('Chargement des membres :', error);
    return [];
  }
  await ensureProfiles(data.map((m) => m.user_id));
  return data;
}

/** Recharge les membres du salon courant et prévient les autres modules. */
export async function refreshMembers() {
  const roomId = state.currentRoomId;
  if (!roomId) return;
  const members = await loadMembers(roomId);
  if (roomId !== state.currentRoomId) return; // l'utilisateur a changé de salon entre-temps
  state.members = members;
  emit('members:changed');
  if (dialog.open) renderMembers();
}

function openDialog() {
  renderMembers();
  dialog.showModal();
}

function renderMembers() {
  const room = currentRoom();
  const members = state.members
    .map((m) => getProfile(m.user_id))
    .sort((a, b) => Number(isOnline(b.id)) - Number(isOnline(a.id)) || a.username.localeCompare(b.username, 'fr'));

  list.replaceChildren(...members.map((profile) => {
    const online = isOnline(profile.id);
    return el('li', { className: 'list-item' }, [
      el('span', { className: 'list-item-main' }, [
        avatar(profile, true, online),
        el('span', { className: 'list-item-text' }, [
          el('strong', { text: profile.id === state.me.id ? `${profile.username} (vous)` : profile.username }),
          el('small', {
            className: online ? 'text-online' : 'muted',
            text: online ? 'en ligne' : formatLastSeen(profile.last_seen),
          }),
        ]),
      ]),
    ]);
  }));

  // Ajout de membres et départ : seulement pour les salons de groupe
  const isGroup = room && !room.is_direct;
  const candidates = state.contactIds.filter((id) => !state.members.some((m) => m.user_id === id));
  addZone.hidden = !isGroup || candidates.length === 0;
  $('#btn-leave-room').hidden = !isGroup;
  select.replaceChildren(...candidates.map((id) =>
    el('option', { text: getProfile(id).username, attrs: { value: id } })));
}

async function addMember() {
  const userId = select.value;
  if (!userId) return;
  const { error } = await supabase.rpc('add_room_member', { p_room: state.currentRoomId, p_user: userId });
  if (error) return toast("Impossible d'ajouter ce membre.", 'error');
  toast(`${getProfile(userId).username} a rejoint le salon.`, 'success');
  await refreshMembers();
}

async function leaveRoom() {
  const room = currentRoom();
  if (!room || !confirm(`Quitter le salon « ${room.name} » ?`)) return;
  const { error } = await supabase
    .from('room_members')
    .delete()
    .match({ room_id: room.id, user_id: state.me.id });
  if (error) return toast('Impossible de quitter le salon.', 'error');
  dialog.close();
  toast(`Vous avez quitté « ${room.name} ».`);
  emit('room:closed');
  emit('rooms:reload');
}

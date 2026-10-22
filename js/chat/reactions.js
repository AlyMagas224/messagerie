/**
 * reactions.js — FONCTIONNALITÉ SUPPLÉMENTAIRE : réactions emoji sur les messages.
 *
 * Chaque utilisateur peut réagir à un message avec un ou plusieurs emojis
 * (👍 ❤️ 😂 😮 😢 🎉). Les réactions sont enregistrées dans la table
 * « reactions » et synchronisées en temps réel entre tous les membres.
 * Un clic sur une réaction existante l'ajoute ou la retire (bascule).
 */
import { supabase } from '../services/supabase.js';
import { REACTION_EMOJIS } from '../config.js';
import { el, toast } from '../utils/dom.js';
import { state, getProfile } from './state.js';

/** Fonction appelée quand les réactions d'un message changent (fournie par messages.js). */
let onChange = () => {};

export function initReactions(options) {
  onChange = options.onChange;

  // Ferme les sélecteurs d'emojis ouverts lors d'un clic ailleurs
  document.addEventListener('click', (event) => {
    if (!event.target.closest('.reaction-add, .reaction-picker')) closePickers();
  });
}

function closePickers() {
  document.querySelectorAll('.reaction-picker:not([hidden])').forEach((p) => { p.hidden = true; });
}

/** Charge les réactions d'une liste de messages dans state.reactions. */
export async function loadReactions(messageIds) {
  if (messageIds.length === 0) return;
  const { data, error } = await supabase
    .from('reactions')
    .select('id, message_id, room_id, user_id, emoji')
    .in('message_id', messageIds);
  if (error) {
    console.error('Chargement des réactions :', error);
    return;
  }
  for (const reaction of data) state.reactions.set(reaction.id, reaction);
}

/** Regroupe les réactions d'un message par emoji. */
function groupReactions(messageId) {
  const groups = new Map();
  for (const reaction of state.reactions.values()) {
    if (reaction.message_id !== messageId) continue;
    const group = groups.get(reaction.emoji) ?? { emoji: reaction.emoji, users: [], mine: null };
    group.users.push(reaction.user_id);
    if (reaction.user_id === state.me.id) group.mine = reaction;
    groups.set(reaction.emoji, group);
  }
  // Ordre stable : celui de la liste REACTION_EMOJIS
  return [...groups.values()].sort((a, b) => REACTION_EMOJIS.indexOf(a.emoji) - REACTION_EMOJIS.indexOf(b.emoji));
}

/** Construit la barre de réactions d'un message (pastilles + bouton d'ajout). */
export function renderReactions(message) {
  const chips = groupReactions(message.id).map((group) => el('button', {
    className: `reaction-chip ${group.mine ? 'is-mine' : ''}`,
    attrs: { type: 'button', 'aria-pressed': String(Boolean(group.mine)) },
    title: group.users.map((id) => getProfile(id).username).join(', '),
    on: { click: () => toggleReaction(message.id, group.emoji) },
  }, [group.emoji, el('span', { text: String(group.users.length) })]));

  const picker = el('div', { className: 'reaction-picker', attrs: { hidden: '', role: 'menu' } },
    REACTION_EMOJIS.map((emoji) => el('button', {
      text: emoji,
      attrs: { type: 'button', role: 'menuitem', 'aria-label': `Réagir avec ${emoji}` },
      on: { click: () => { picker.hidden = true; toggleReaction(message.id, emoji); } },
    })));

  const addButton = el('button', {
    className: 'reaction-add',
    text: '☺',
    attrs: { type: 'button', 'aria-label': 'Ajouter une réaction', 'aria-haspopup': 'menu' },
    on: {
      click: () => {
        const wasHidden = picker.hidden;
        closePickers();
        picker.hidden = !wasHidden;
      },
    },
  });

  return el('div', { className: `reactions ${chips.length ? 'has-reactions' : ''}` }, [...chips, addButton, picker]);
}

/** Ajoute la réaction si elle est absente, la retire sinon. */
export async function toggleReaction(messageId, emoji) {
  const existing = [...state.reactions.values()].find(
    (r) => r.message_id === messageId && r.user_id === state.me.id && r.emoji === emoji);

  if (existing) {
    const { error } = await supabase.from('reactions').delete().eq('id', existing.id);
    if (error) return toast('Impossible de retirer la réaction.', 'error');
    state.reactions.delete(existing.id);
  } else {
    const { data, error } = await supabase
      .from('reactions')
      .insert({ message_id: messageId, emoji })
      .select('id, message_id, room_id, user_id, emoji')
      .single();
    if (error) return toast("Impossible d'ajouter la réaction.", 'error');
    state.reactions.set(data.id, data);
  }
  onChange(messageId);
}

/**
 * Traite un changement temps réel de la table reactions.
 * Remarque : pour un DELETE, Supabase ne transmet que la clé primaire (id),
 * d'où la recherche de la réaction dans le cache local.
 */
export function handleReactionChange(payload) {
  if (payload.eventType === 'DELETE') {
    const old = state.reactions.get(payload.old.id);
    if (!old) return;
    state.reactions.delete(old.id);
    onChange(old.message_id);
    return;
  }
  const reaction = payload.new;
  if (reaction.room_id !== state.currentRoomId) return;
  if (!state.messages.some((m) => m.id === reaction.message_id)) return;
  state.reactions.set(reaction.id, reaction);
  onChange(reaction.message_id);
}

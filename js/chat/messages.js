/**
 * messages.js — Cœur de la messagerie :
 *   - ouverture d'un salon et chargement paginé des messages
 *   - affichage horodaté (séparateurs de jour, heure de chaque message)
 *   - envoi de messages texte et d'images
 *   - réception en temps réel (Supabase Realtime / postgres_changes)
 *   - indicateurs « envoyé / reçu / lu » et « en train d'écrire… »
 */
import { supabase } from '../services/supabase.js';
import { PAGE_SIZE } from '../config.js';
import { $, el, avatar, formatTime, formatFull, formatDay, formatLastSeen, toast } from '../utils/dom.js';
import { state, on, emit, ensureProfiles, getProfile, isOnline, currentRoom } from './state.js';
import { renderRooms, clearUnread, applyIncomingMessage } from './rooms.js';
import { loadMembers, refreshMembers } from './members.js';
import { notifyMessage } from './notifications.js';
import { initReactions, loadReactions, renderReactions, handleReactionChange } from './reactions.js';
import { validateImage, uploadImage, isAllowedImageUrl } from './images.js';

/* Éléments du DOM */
const app = $('#app');
const placeholder = $('#chat-placeholder');
const view = $('#chat-view');
const scroller = $('#messages');
const list = $('#message-list');
const loadMoreButton = $('#btn-load-more');
const scrollDownButton = $('#btn-scroll-down');
const typingLine = $('#typing');
const composer = $('#composer');
const input = $('#message-input');
const imageInput = $('#image-input');

/** Colonnes lues pour un message. */
const MESSAGE_COLUMNS = 'id, room_id, user_id, content, image_url, created_at';
/** Deux messages d'un même auteur à moins de 5 min sont regroupés visuellement. */
const GROUP_DELAY_MS = 5 * 60 * 1000;
/** Délais de l'indicateur « en train d'écrire ». */
const TYPING_SEND_EVERY_MS = 2000;
const TYPING_TIMEOUT_MS = 3500;

let roomChannel = null;          // canal Realtime du salon ouvert (broadcast « typing »)
let hasMore = false;             // reste-t-il des messages plus anciens ?
let stickToBottom = true;        // l'utilisateur est-il en bas de la conversation ?
let lastTypingSent = 0;
let deliveredTimer = null;
const typingUsers = new Map();   // user_id → { username, timer }

/* ================================================================== */
/* Initialisation                                                      */
/* ================================================================== */

export function initMessages() {
  composer.addEventListener('submit', (event) => { event.preventDefault(); sendText(); });

  // Entrée = envoyer ; Maj + Entrée = retour à la ligne
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      sendText();
    }
  });
  input.addEventListener('input', () => { autoResize(); sendTyping(); });

  // Images : bouton trombone, coller (Ctrl+V) et glisser-déposer
  imageInput.addEventListener('change', () => {
    if (imageInput.files[0]) sendImage(imageInput.files[0]);
    imageInput.value = '';
  });
  input.addEventListener('paste', (event) => {
    const file = [...event.clipboardData.files].find((f) => f.type.startsWith('image/'));
    if (file) { event.preventDefault(); sendImage(file); }
  });
  scroller.addEventListener('dragover', (event) => { event.preventDefault(); scroller.classList.add('is-dragover'); });
  scroller.addEventListener('dragleave', () => scroller.classList.remove('is-dragover'));
  scroller.addEventListener('drop', (event) => {
    event.preventDefault();
    scroller.classList.remove('is-dragover');
    const file = event.dataTransfer.files[0];
    if (file) sendImage(file);
  });

  // Défilement
  loadMoreButton.addEventListener('click', loadOlder);
  scroller.addEventListener('scroll', () => {
    stickToBottom = isNearBottom();
    scrollDownButton.hidden = stickToBottom;
  }, { passive: true });
  scrollDownButton.addEventListener('click', () => scrollToBottom(true));

  // Écran tactile : toucher une bulle la « sélectionne » et affiche le bouton de réaction
  list.addEventListener('click', (event) => {
    const bubble = event.target.closest('.bubble');
    if (!bubble || event.target.closest('a')) return;
    const message = bubble.closest('.message');
    list.querySelectorAll('.message.is-selected').forEach((m) => { if (m !== message) m.classList.remove('is-selected'); });
    message.classList.toggle('is-selected');
  });

  // Retour à la liste (mobile)
  $('#btn-back').addEventListener('click', closeRoom);

  // Retour sur l'onglet : les messages affichés deviennent « lus »
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.currentRoomId) markRead(state.currentRoomId);
  });

  initReactions({ onChange: updateMessageNode });

  on('presence:changed', renderHeader);
  on('members:changed', () => { renderHeader(); refreshTicks(); });
  on('room:closed', closeRoom);

  subscribeDatabase();
}

/* ================================================================== */
/* Temps réel : changements de la base de données                     */
/* ================================================================== */

/**
 * Un seul canal pour toute l'application. Les politiques RLS garantissent
 * que l'on ne reçoit que les lignes des salons dont on est membre.
 */
function subscribeDatabase() {
  let firstConnection = true;

  supabase
    .channel('db-changes')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' },
      (payload) => onMessageInsert(payload.new))
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'room_members' },
      (payload) => onMemberInsert(payload.new))
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'room_members' },
      (payload) => onMemberUpdate(payload.new))
    .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'room_members' },
      (payload) => onMemberDelete(payload.old))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'reactions' },
      handleReactionChange)
    .subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        stopPolling();
        markDelivered();
        // Après une coupure réseau : on récupère ce qui a été manqué
        if (!firstConnection) resync();
        firstConnection = false;
      } else if (['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'].includes(status)) {
        // Temps réel indisponible : on interroge le serveur toutes les 3 s (« ou presque »)
        console.warn('Temps réel indisponible, bascule en interrogation périodique :', status);
        startPolling();
      }
    });

  // Au retour sur l'onglet (téléphone mis en veille, etc.) : rattrapage immédiat
  window.addEventListener('focus', resync);
  window.addEventListener('online', resync);
}

/* Interrogation périodique de secours */
let pollTimer = null;
function startPolling() {
  if (!pollTimer) pollTimer = setInterval(resync, 3000);
}
function stopPolling() {
  clearInterval(pollTimer);
  pollTimer = null;
}

/** Resynchronise la liste des salons et le salon ouvert après une reconnexion. */
async function resync() {
  emit('rooms:reload');
  const roomId = state.currentRoomId;
  const last = state.messages.at(-1);
  if (!roomId) return;
  let query = supabase
    .from('messages')
    .select(MESSAGE_COLUMNS)
    .eq('room_id', roomId)
    .order('created_at', { ascending: true })
    .limit(PAGE_SIZE);
  if (last) query = query.gt('created_at', last.created_at); // seulement les nouveaux
  const { data, error } = await query;
  if (!error) data.forEach(onMessageInsert);
  refreshMembers();
}

/** Nouveau message (reçu en temps réel ou retourné après notre propre envoi). */
async function onMessageInsert(message) {
  // Doublon possible : notre envoi arrive à la fois par la réponse HTTP et par Realtime
  if (state.messages.some((m) => m.id === message.id)) return;

  const isMine = message.user_id === state.me.id;
  const inCurrentRoom = message.room_id === state.currentRoomId;
  await ensureProfiles([message.user_id]);

  if (inCurrentRoom) {
    if (state.messages.some((m) => m.id === message.id)) return; // re-vérification après l'await
    state.messages.push(message);
    appendMessageNode(message);
    if (isMine || stickToBottom) scrollToBottom();
    if (!isMine && document.visibilityState === 'visible') markRead(message.room_id);
  }

  applyIncomingMessage(message);

  if (!isMine) {
    markDelivered();
    stopTyping(message.user_id);
    const room = state.rooms.find((r) => r.id === message.room_id);
    notifyMessage(message, getProfile(message.user_id).username, room?.name ?? 'Nouveau salon', inCurrentRoom);
  }
}

function onMemberInsert(row) {
  if (row.user_id === state.me.id) emit('rooms:reload');         // on nous a ajouté à un salon
  if (row.room_id === state.currentRoomId) refreshMembers();      // nouveau membre dans le salon ouvert
}

/** Mise à jour d'un accusé de réception / lecture. */
function onMemberUpdate(row) {
  if (row.room_id !== state.currentRoomId) return;
  const member = state.members.find((m) => m.user_id === row.user_id);
  if (!member) return;
  member.last_read_at = row.last_read_at;
  member.last_delivered_at = row.last_delivered_at;
  refreshTicks();
}

/** Départ d'un membre (Supabase ne transmet que la clé primaire). */
function onMemberDelete(old) {
  if (old.user_id === state.me.id) emit('rooms:reload');
  if (old.room_id === state.currentRoomId) refreshMembers();
}

/* ================================================================== */
/* Ouverture / fermeture d'un salon                                    */
/* ================================================================== */

export async function openRoom(roomId) {
  app.classList.add('show-chat'); // mobile : affiche la conversation
  if (state.currentRoomId === roomId) return;

  // Réinitialisation de l'état du salon
  state.currentRoomId = roomId;
  state.messages = [];
  state.members = [];
  state.reactions.clear();
  typingUsers.forEach(({ timer }) => clearTimeout(timer));
  typingUsers.clear();
  renderTyping();
  history.replaceState(null, '', `#${roomId}`);

  placeholder.hidden = true;
  view.hidden = false;
  loadMoreButton.hidden = true;
  list.replaceChildren(el('li', { className: 'empty muted', text: 'Chargement des messages…' }));
  renderRooms();
  renderHeader();
  subscribeRoomChannel(roomId);

  // Chargement parallèle des membres et des messages
  const [members, messages] = await Promise.all([loadMembers(roomId), fetchMessages(roomId)]);
  if (state.currentRoomId !== roomId) return; // l'utilisateur a changé de salon entre-temps

  state.members = members;
  // Des messages ont pu arriver en temps réel pendant le chargement : fusion sans doublon
  const known = new Set(messages.map((m) => m.id));
  state.messages = [...messages, ...state.messages.filter((m) => !known.has(m.id))];
  await loadReactions(state.messages.map((m) => m.id));
  if (state.currentRoomId !== roomId) return;

  renderHeader();
  renderAllMessages();
  scrollToBottom();
  markRead(roomId);
  if (window.matchMedia('(min-width: 768px)').matches) input.focus();
}

/** Ferme le salon (retour à la liste sur mobile). */
export function closeRoom() {
  app.classList.remove('show-chat');
  if (roomChannel) supabase.removeChannel(roomChannel);
  roomChannel = null;
  state.currentRoomId = null;
  state.messages = [];
  state.members = [];
  view.hidden = true;
  placeholder.hidden = false;
  history.replaceState(null, '', window.location.pathname);
  renderRooms();
}

/**
 * Récupère une page de messages (les plus récents d'abord côté SQL,
 * puis remis dans l'ordre chronologique).
 * @param {string} roomId
 * @param {string|null} before  date ISO : messages antérieurs à celle-ci
 */
async function fetchMessages(roomId, before = null) {
  let query = supabase
    .from('messages')
    .select(MESSAGE_COLUMNS)
    .eq('room_id', roomId)
    .order('created_at', { ascending: false })
    .limit(PAGE_SIZE);
  if (before) query = query.lt('created_at', before);

  const { data, error } = await query;
  if (error) {
    console.error('Chargement des messages :', error);
    toast('Impossible de charger les messages.', 'error');
    return [];
  }
  hasMore = data.length === PAGE_SIZE;
  await ensureProfiles(data.map((m) => m.user_id));
  return data.reverse();
}

/** « Charger les messages précédents » : conserve la position de lecture. */
async function loadOlder() {
  const roomId = state.currentRoomId;
  const first = state.messages[0];
  if (!roomId || !first) return;

  loadMoreButton.disabled = true;
  const older = await fetchMessages(roomId, first.created_at);
  await loadReactions(older.map((m) => m.id));
  loadMoreButton.disabled = false;
  if (roomId !== state.currentRoomId) return;

  const previousHeight = scroller.scrollHeight;
  state.messages = [...older, ...state.messages];
  renderAllMessages();
  scroller.scrollTop = scroller.scrollHeight - previousHeight;
}

/* ================================================================== */
/* Affichage                                                           */
/* ================================================================== */

/** En-tête : nom du salon et statut (en ligne / vu à… / nombre de membres). */
function renderHeader() {
  const room = currentRoom();
  if (!room) return;
  const nameNode = $('#room-name');
  const statusNode = $('#room-status');
  const avatarSlot = $('#room-avatar');

  if (room.is_direct) {
    const other = getProfile(room.other_user_id);
    const online = isOnline(other.id);
    nameNode.textContent = room.name;
    statusNode.textContent = online ? 'en ligne' : formatLastSeen(other.last_seen);
    statusNode.className = online ? 'text-online' : 'muted';
    avatarSlot.replaceChildren(avatar(other, true, online));
  } else {
    const onlineCount = state.members.filter((m) => isOnline(m.user_id)).length;
    nameNode.textContent = `# ${room.name}`;
    statusNode.textContent = state.members.length
      ? `${state.members.length} membre${state.members.length > 1 ? 's' : ''} · ${onlineCount} en ligne`
      : '';
    statusNode.className = 'muted';
    avatarSlot.replaceChildren(avatar({ username: room.name, avatar_color: '#6e7781' }));
  }
}

/** Réaffiche toute la conversation (ouverture du salon, messages plus anciens). */
function renderAllMessages() {
  const nodes = [];
  state.messages.forEach((message, index) => {
    const previous = state.messages[index - 1];
    if (!previous || !sameDay(previous.created_at, message.created_at)) {
      nodes.push(daySeparator(message.created_at));
    }
    nodes.push(buildMessageNode(message, previous));
  });
  if (nodes.length === 0) {
    nodes.push(el('li', { className: 'empty muted', text: 'Aucun message. Dites bonjour ! 👋' }));
  }
  list.replaceChildren(...nodes);
  loadMoreButton.hidden = !hasMore;
}

/** Ajoute un seul message à la fin (évite de tout redessiner). */
function appendMessageNode(message) {
  list.querySelector('.empty')?.remove();
  const previous = state.messages[state.messages.length - 2];
  if (!previous || !sameDay(previous.created_at, message.created_at)) {
    list.append(daySeparator(message.created_at));
  }
  list.append(buildMessageNode(message, previous));
}

/** Redessine un message (ex. après un changement de réactions). */
function updateMessageNode(messageId) {
  const index = state.messages.findIndex((m) => m.id === messageId);
  const node = list.querySelector(`[data-id="${messageId}"]`);
  if (index === -1 || !node) return;
  node.replaceWith(buildMessageNode(state.messages[index], state.messages[index - 1]));
}

function daySeparator(date) {
  return el('li', { className: 'day-separator', attrs: { role: 'separator' } }, [
    el('span', { text: formatDay(date) }),
  ]);
}

function sameDay(a, b) {
  return new Date(a).toDateString() === new Date(b).toDateString();
}

/** Construit l'élément <li> d'un message. */
function buildMessageNode(message, previous) {
  const isMine = message.user_id === state.me.id;
  const author = getProfile(message.user_id);
  const isGroupRoom = !currentRoom()?.is_direct;

  // Regroupement : même auteur, même jour, moins de 5 minutes d'écart
  const grouped = previous
    && previous.user_id === message.user_id
    && sameDay(previous.created_at, message.created_at)
    && new Date(message.created_at) - new Date(previous.created_at) < GROUP_DELAY_MS;

  const showAuthor = !isMine && isGroupRoom && !grouped;

  // Contenu de la bulle : image éventuelle puis texte
  const bubbleChildren = [];
  if (message.image_url && isAllowedImageUrl(message.image_url)) {
    const img = el('img', { attrs: { src: message.image_url, alt: 'Image partagée', loading: 'lazy' } });
    img.addEventListener('load', () => { if (stickToBottom) scrollToBottom(); });
    bubbleChildren.push(el('a', {
      className: 'bubble-image',
      attrs: { href: message.image_url, target: '_blank', rel: 'noopener noreferrer' },
    }, [img]));
  }
  if (message.content) {
    bubbleChildren.push(el('p', { className: 'bubble-text', text: message.content }));
  }
  bubbleChildren.push(el('span', { className: 'meta' }, [
    el('time', {
      text: formatTime(message.created_at),
      title: formatFull(message.created_at),
      attrs: { datetime: message.created_at },
    }),
    isMine ? buildTicks(message) : null,
  ]));

  return el('li', {
    className: `message ${isMine ? 'is-mine' : 'is-theirs'} ${grouped ? 'is-grouped' : ''}`,
    dataset: { id: message.id },
  }, [
    !isMine && isGroupRoom ? (showAuthor ? avatar(author) : el('span', { className: 'avatar-spacer' })) : null,
    el('div', { className: 'message-body' }, [
      showAuthor ? el('span', { className: 'author', text: author.username }) : null,
      el('div', { className: 'bubble' }, bubbleChildren),
      renderReactions(message),
    ]),
  ]);
}

/* ================================================================== */
/* Indicateur « envoyé / reçu / lu »                                   */
/* ================================================================== */

/**
 * Statut d'un de nos messages, d'après les accusés des AUTRES membres :
 *  - 'read'      : tous l'ont lu            (✓✓ en couleur)
 *  - 'delivered' : tous l'ont reçu          (✓✓)
 *  - 'sent'      : enregistré sur le serveur (✓)
 */
function messageStatus(message) {
  const others = state.members.filter((m) => m.user_id !== state.me.id);
  if (others.length === 0) return 'sent';
  const sentAt = new Date(message.created_at);
  if (others.every((m) => new Date(m.last_read_at) >= sentAt)) return 'read';
  if (others.every((m) => new Date(m.last_delivered_at) >= sentAt)) return 'delivered';
  return 'sent';
}

const STATUS_LABELS = { sent: 'Envoyé', delivered: 'Reçu', read: 'Lu' };

function buildTicks(message) {
  const status = messageStatus(message);
  return el('span', {
    className: `ticks is-${status}`,
    text: status === 'sent' ? '✓' : '✓✓',
    title: STATUS_LABELS[status],
    attrs: { 'aria-label': STATUS_LABELS[status] },
  });
}

/** Met à jour les coches de tous nos messages affichés. */
function refreshTicks() {
  for (const message of state.messages) {
    if (message.user_id !== state.me.id) continue;
    const ticks = list.querySelector(`[data-id="${message.id}"] .ticks`);
    if (ticks) ticks.replaceWith(buildTicks(message));
  }
}

/** Accusé de lecture pour le salon ouvert. */
async function markRead(roomId) {
  clearUnread(roomId);
  const { error } = await supabase.rpc('mark_room_read', { p_room: roomId });
  if (error) console.error('Accusé de lecture :', error);
}

/** Accusé de réception global (regroupé pour limiter les requêtes). */
function markDelivered() {
  clearTimeout(deliveredTimer);
  deliveredTimer = setTimeout(() => supabase.rpc('mark_all_delivered'), 500);
}

/* ================================================================== */
/* Indicateur « en train d'écrire… » (Realtime Broadcast)              */
/* ================================================================== */

function subscribeRoomChannel(roomId) {
  if (roomChannel) supabase.removeChannel(roomChannel);
  roomChannel = supabase.channel(`room:${roomId}`, { config: { broadcast: { self: false } } });
  roomChannel.on('broadcast', { event: 'typing' }, ({ payload }) => {
    if (payload.room_id === state.currentRoomId) startTyping(payload.user_id, payload.username);
  });
  roomChannel.subscribe();
}

/** Signale aux autres que l'on écrit (au plus toutes les 2 secondes). */
function sendTyping() {
  const now = Date.now();
  if (!roomChannel || !input.value.trim() || now - lastTypingSent < TYPING_SEND_EVERY_MS) return;
  lastTypingSent = now;
  roomChannel.send({
    type: 'broadcast',
    event: 'typing',
    payload: { room_id: state.currentRoomId, user_id: state.me.id, username: state.me.username },
  });
}

function startTyping(userId, username) {
  clearTimeout(typingUsers.get(userId)?.timer);
  const timer = setTimeout(() => stopTyping(userId), TYPING_TIMEOUT_MS);
  typingUsers.set(userId, { username, timer });
  renderTyping();
}

function stopTyping(userId) {
  const entry = typingUsers.get(userId);
  if (!entry) return;
  clearTimeout(entry.timer);
  typingUsers.delete(userId);
  renderTyping();
}

function renderTyping() {
  const names = [...typingUsers.values()].map((u) => u.username);
  if (names.length === 0) typingLine.textContent = '';
  else if (names.length === 1) typingLine.textContent = `${names[0]} est en train d'écrire…`;
  else if (names.length === 2) typingLine.textContent = `${names[0]} et ${names[1]} écrivent…`;
  else typingLine.textContent = 'Plusieurs personnes écrivent…';
}

/* ================================================================== */
/* Envoi                                                               */
/* ================================================================== */

/** Insère un message et l'affiche dès la réponse du serveur. */
async function insertMessage(fields) {
  const { data, error } = await supabase
    .from('messages')
    .insert({ room_id: state.currentRoomId, ...fields })
    .select(MESSAGE_COLUMNS)
    .single();
  if (error) throw error;
  await onMessageInsert(data);
}

async function sendText() {
  const content = input.value.trim();
  if (!content || !state.currentRoomId) return;

  input.value = '';
  autoResize();
  lastTypingSent = 0;
  try {
    await insertMessage({ content });
  } catch (error) {
    console.error('Envoi :', error);
    input.value = content; // on rend le texte à l'utilisateur pour qu'il réessaie
    autoResize();
    toast("Le message n'a pas pu être envoyé.", 'error');
  }
}

/** Envoie une image (avec le texte saisi comme légende, s'il y en a un). */
async function sendImage(file) {
  const roomId = state.currentRoomId;
  if (!roomId) return;
  const problem = validateImage(file);
  if (problem) return toast(problem, 'error');

  const caption = input.value.trim() || null;
  composer.classList.add('is-uploading');
  try {
    const imageUrl = await uploadImage(file, roomId);
    if (roomId !== state.currentRoomId) return;
    await insertMessage({ image_url: imageUrl, content: caption });
    if (caption) { input.value = ''; autoResize(); }
  } catch (error) {
    console.error("Envoi d'image :", error);
    toast("L'image n'a pas pu être envoyée.", 'error');
  } finally {
    composer.classList.remove('is-uploading');
  }
}

/* ================================================================== */
/* Utilitaires d'interface                                             */
/* ================================================================== */

/** La zone de saisie s'agrandit avec le texte (jusqu'à 6 lignes environ). */
function autoResize() {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 150)}px`;
}

function isNearBottom() {
  return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 120;
}

function scrollToBottom(smooth = false) {
  scroller.scrollTo({ top: scroller.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  stickToBottom = true;
  scrollDownButton.hidden = true;
}

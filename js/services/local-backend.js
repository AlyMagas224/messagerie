/**
 * local-backend.js — MODE DÉMO : faux serveur exécuté dans le navigateur.
 *
 * Utilisé automatiquement quand js/config.js n'est pas rempli, pour que le site
 * fonctionne immédiatement (inscription, connexion, salons, messages, images…).
 *
 * Il reproduit la partie de l'API supabase-js utilisée par l'application :
 *   - auth       : signUp, signInWithPassword, signOut, getSession, getUser, updateUser
 *   - from()     : select / insert / delete avec filtres (eq, in, lt, gt, ilike, match…)
 *   - rpc()      : mêmes fonctions que celles de supabase/schema.sql
 *   - channel()  : temps réel (postgres_changes, presence, broadcast)
 *   - storage    : envoi d'images (converties en data URL compressées)
 *
 * Stockage : localStorage (données partagées par les onglets du navigateur).
 * Session  : sessionStorage (un utilisateur différent par onglet → on peut
 *            tester une conversation à deux dans deux onglets).
 * Temps réel entre onglets : BroadcastChannel.
 *
 * LIMITE : les données restent dans CE navigateur. Pour discuter entre
 * plusieurs ordinateurs / téléphones, il faut configurer Supabase.
 */

const DB_KEY = 'babil:db';
const SESSION_KEY = 'babil:session';
const PRESENCE_TIMEOUT_MS = 12000;
const PRESENCE_BEAT_MS = 4000;
const ALLOWED_EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '🎉'];

/* ================================================================== */
/* Utilitaires                                                         */
/* ================================================================== */

/** Identifiant unique (crypto.randomUUID n'existe qu'en contexte sécurisé). */
function uuid() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

const TAB_ID = uuid();
const nowIso = () => new Date().toISOString();
const fail = (message, code = 'LOCAL') => ({ data: null, error: { message, code } });

/** Empreinte du mot de passe (SHA-256 si disponible). Mode démo : sécurité minimale. */
async function hashPassword(email, password) {
  const text = `${email.toLowerCase()}:${password}`;
  if (globalThis.crypto?.subtle) {
    const buffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  let h = 5381;
  for (const ch of text) h = ((h << 5) + h + ch.charCodeAt(0)) | 0;
  return `djb2-${h >>> 0}`;
}

/* ================================================================== */
/* « Base de données » dans le localStorage                            */
/* ================================================================== */

function emptyDb() {
  return { seq: 1, users: [], profiles: [], contacts: [], rooms: [], room_members: [], messages: [], reactions: [] };
}

function loadDb() {
  try {
    return { ...emptyDb(), ...JSON.parse(localStorage.getItem(DB_KEY) || '{}') };
  } catch {
    return emptyDb();
  }
}

/** Enregistre ; retourne un objet erreur si le stockage est plein. */
function saveDb(db) {
  try {
    localStorage.setItem(DB_KEY, JSON.stringify(db));
    return null;
  } catch {
    return { message: 'Espace de stockage du navigateur plein : supprimez des images ou videz les données du site.' };
  }
}

function getSession() {
  try { return JSON.parse(sessionStorage.getItem(SESSION_KEY)); } catch { return null; }
}

function setSession(session) {
  try {
    if (session) sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
    else sessionStorage.removeItem(SESSION_KEY);
  } catch { /* stockage indisponible */ }
}

const currentUserId = () => getSession()?.user?.id ?? null;

function isMember(db, roomId, userId = currentUserId()) {
  return db.room_members.some((m) => m.room_id === roomId && m.user_id === userId);
}

/* ================================================================== */
/* Temps réel entre onglets                                            */
/* ================================================================== */

const bus = 'BroadcastChannel' in globalThis ? new BroadcastChannel('babil-realtime') : null;
const channels = new Set();

/** Diffuse un événement dans cet onglet ET dans les autres. */
function publish(event) {
  deliver(event);
  bus?.postMessage(event);
}

function deliver(event) {
  for (const channel of channels) channel.receive(event);
}

if (bus) bus.onmessage = (message) => deliver(message.data);

/** Émet un changement de table (équivalent de postgres_changes). */
function publishChange(table, eventType, row, old = null) {
  publish({ kind: 'pg', table, eventType, new: eventType === 'DELETE' ? {} : row, old: old ?? {} });
}

/** Émulation de RLS : l'onglet ne reçoit que les lignes qu'il a le droit de voir. */
function canSee(event) {
  if (event.eventType === 'DELETE') return true; // comme Supabase : seule la clé primaire est transmise
  const db = loadDb();
  const row = event.new;
  if (['messages', 'reactions', 'room_members'].includes(event.table)) return isMember(db, row.room_id);
  return false;
}

class LocalChannel {
  constructor(name, options = {}) {
    this.name = name;
    this.options = options;
    this.handlers = [];
    this.peers = new Map();      // tabId → { key, ts }
    this.lastPresence = '';
    this.timers = [];
  }

  on(type, filter, callback) {
    this.handlers.push({ type, filter, callback });
    return this;
  }

  subscribe(callback) {
    channels.add(this);
    setTimeout(() => callback?.('SUBSCRIBED'), 0);
    return this;
  }

  /** Presence : annonce régulière de l'onglet. */
  async track() {
    const key = this.options?.config?.presence?.key;
    const beat = () => publish({ kind: 'presence', channel: this.name, key, tab: TAB_ID, ts: Date.now() });
    beat();
    this.timers.push(setInterval(beat, PRESENCE_BEAT_MS));
    this.timers.push(setInterval(() => this.syncPresence(), PRESENCE_BEAT_MS));
    globalThis.addEventListener?.('pagehide', () => publish({ kind: 'presence-leave', channel: this.name, tab: TAB_ID }));
    return 'ok';
  }

  presenceState() {
    const limit = Date.now() - PRESENCE_TIMEOUT_MS;
    const state = {};
    for (const [tab, peer] of this.peers) {
      if (peer.ts < limit) { this.peers.delete(tab); continue; }
      (state[peer.key] ??= []).push({ tab });
    }
    return state;
  }

  /** Déclenche 'sync' seulement si la liste des présents a changé. */
  syncPresence() {
    const signature = Object.keys(this.presenceState()).sort().join(',');
    if (signature === this.lastPresence) return;
    this.lastPresence = signature;
    this.handlers
      .filter((h) => h.type === 'presence' && h.filter?.event === 'sync')
      .forEach((h) => h.callback());
  }

  send({ event, payload }) {
    publish({ kind: 'broadcast', channel: this.name, event, payload, tab: TAB_ID });
    return Promise.resolve('ok');
  }

  unsubscribe() {
    channels.delete(this);
    this.timers.forEach(clearInterval);
  }

  receive(event) {
    if (event.kind === 'pg') {
      if (!canSee(event)) return;
      for (const h of this.handlers) {
        if (h.type !== 'postgres_changes' || h.filter.table !== event.table) continue;
        if (h.filter.event !== '*' && h.filter.event !== event.eventType) continue;
        h.callback({ eventType: event.eventType, table: event.table, new: event.new, old: event.old });
      }
      return;
    }
    if (event.channel !== this.name) return;

    if (event.kind === 'presence') {
      this.peers.set(event.tab, { key: event.key, ts: event.ts });
      this.syncPresence();
    } else if (event.kind === 'presence-leave') {
      this.peers.delete(event.tab);
      this.syncPresence();
    } else if (event.kind === 'broadcast') {
      const self = this.options?.config?.broadcast?.self;
      if (event.tab === TAB_ID && !self) return;
      this.handlers
        .filter((h) => h.type === 'broadcast' && h.filter.event === event.event)
        .forEach((h) => h.callback({ event: event.event, payload: event.payload }));
    }
  }
}

/* ================================================================== */
/* Requêtes sur les tables : from('table')                             */
/* ================================================================== */

/** Convertit un motif ILIKE (% _ et échappement \) en expression régulière. */
function likeToRegex(pattern) {
  let source = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i];
    if (c === '\\' && i + 1 < pattern.length) source += pattern[++i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    else if (c === '%') source += '.*';
    else if (c === '_') source += '.';
    else source += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`, 'i');
}

/** Lignes qu'un utilisateur a le droit de lire (équivalent des politiques SELECT). */
function visibleRows(db, table, me) {
  switch (table) {
    case 'profiles': return db.profiles;
    case 'contacts':
      return db.contacts
        .filter((c) => c.user_id === me)
        .map((c) => ({ ...c, contact: db.profiles.find((p) => p.id === c.contact_id) ?? null }));
    case 'rooms': return db.rooms.filter((r) => isMember(db, r.id, me));
    case 'room_members':
    case 'messages':
    case 'reactions':
      return db[table].filter((row) => isMember(db, row.room_id, me));
    default: return [];
  }
}

class LocalQuery {
  constructor(table) {
    this.table = table;
    this.operation = 'select';
    this.filters = [];
    this.payload = null;
    this.sort = null;
    this.max = null;
    this.mode = 'many'; // 'many' | 'single' | 'maybe'
  }

  select() { return this; }
  eq(key, value) { this.filters.push((r) => r[key] === value); return this; }
  in(key, values) { this.filters.push((r) => values.includes(r[key])); return this; }
  lt(key, value) { this.filters.push((r) => r[key] < value); return this; }
  gt(key, value) { this.filters.push((r) => r[key] > value); return this; }
  ilike(key, pattern) { const re = likeToRegex(pattern); this.filters.push((r) => re.test(r[key] ?? '')); return this; }
  match(object) { Object.entries(object).forEach(([k, v]) => this.eq(k, v)); return this; }
  order(key, { ascending = true } = {}) { this.sort = { key, ascending }; return this; }
  limit(n) { this.max = n; return this; }
  single() { this.mode = 'single'; return this; }
  maybeSingle() { this.mode = 'maybe'; return this; }
  insert(payload) { this.operation = 'insert'; this.payload = payload; return this; }
  delete() { this.operation = 'delete'; return this; }

  /** Permet d'utiliser « await » sur la requête, comme avec supabase-js. */
  then(resolve, reject) {
    return Promise.resolve().then(() => this.run()).then(resolve, reject);
  }

  run() {
    const me = currentUserId();
    if (!me) return fail('Non authentifié', '401');
    const db = loadDb();
    if (this.operation === 'insert') return this.runInsert(db, me);
    if (this.operation === 'delete') return this.runDelete(db, me);
    return this.shape(this.applyFilters(visibleRows(db, this.table, me)));
  }

  applyFilters(rows) {
    let result = rows.filter((row) => this.filters.every((f) => f(row)));
    if (this.sort) {
      const { key, ascending } = this.sort;
      result = [...result].sort((a, b) => (a[key] > b[key] ? 1 : a[key] < b[key] ? -1 : 0) * (ascending ? 1 : -1));
    }
    if (this.max !== null) result = result.slice(0, this.max);
    return result;
  }

  /** Mise en forme du résultat selon single() / maybeSingle(). */
  shape(rows) {
    const copy = structuredClone(rows);
    if (this.mode === 'many') return { data: copy, error: null };
    if (copy.length > 1) return fail('Plusieurs lignes retournées', 'PGRST116');
    if (this.mode === 'single' && copy.length === 0) return fail('Aucune ligne retournée', 'PGRST116');
    return { data: copy[0] ?? null, error: null };
  }

  runInsert(db, me) {
    const inserted = [];
    for (const input of [].concat(this.payload)) {
      const result = buildRow(db, this.table, input, me);
      if (result.error) return { data: null, error: result.error };
      db[this.table].push(result.row);
      inserted.push(result.row);
    }
    const storageError = saveDb(db);
    if (storageError) return { data: null, error: storageError };
    if (['messages', 'reactions'].includes(this.table)) {
      inserted.forEach((row) => publishChange(this.table, 'INSERT', row));
    }
    return this.shape(inserted);
  }

  runDelete(db, me) {
    const deletable = { contacts: 'user_id', reactions: 'user_id', room_members: 'user_id' }[this.table];
    if (!deletable) return fail('Permission refusée', '42501');
    const targets = this.applyFilters(visibleRows(db, this.table, me)).filter((r) => r[deletable] === me);
    const isTarget = (row) => targets.some((t) =>
      this.table === 'contacts' ? t.user_id === row.user_id && t.contact_id === row.contact_id
        : this.table === 'room_members' ? t.room_id === row.room_id && t.user_id === row.user_id
          : t.id === row.id);
    db[this.table] = db[this.table].filter((row) => !isTarget(row));
    const storageError = saveDb(db);
    if (storageError) return { data: null, error: storageError };
    for (const t of targets) {
      if (this.table === 'reactions') publishChange('reactions', 'DELETE', null, { id: t.id });
      if (this.table === 'room_members') publishChange('room_members', 'DELETE', null, { room_id: t.room_id, user_id: t.user_id });
    }
    return { data: null, error: null };
  }
}

/** Valide et complète une ligne à insérer (équivalent des contraintes et politiques INSERT). */
function buildRow(db, table, input, me) {
  const rls = { error: { message: 'new row violates row-level security policy', code: '42501' } };

  if (table === 'contacts') {
    if (input.user_id !== me) return rls;
    if (!db.profiles.some((p) => p.id === input.contact_id) || input.contact_id === me) {
      return { error: { message: 'Contact invalide', code: '23503' } };
    }
    if (db.contacts.some((c) => c.user_id === me && c.contact_id === input.contact_id)) {
      return { error: { message: 'Contact déjà ajouté', code: '23505' } };
    }
    return { row: { user_id: me, contact_id: input.contact_id, created_at: nowIso() } };
  }

  if (table === 'messages') {
    if (!isMember(db, input.room_id, me)) return rls;
    const content = input.content ?? null;
    const imageUrl = input.image_url ?? null;
    if (content !== null && (content.length < 1 || content.length > 2000)) {
      return { error: { message: 'Message trop long (2000 caractères maximum)', code: '23514' } };
    }
    if (content === null && imageUrl === null) return { error: { message: 'Message vide', code: '23514' } };
    const row = { id: db.seq++, room_id: input.room_id, user_id: me, content, image_url: imageUrl, created_at: nowIso() };
    const room = db.rooms.find((r) => r.id === input.room_id);
    if (room) room.last_message_at = row.created_at;
    return { row };
  }

  if (table === 'reactions') {
    const message = db.messages.find((m) => m.id === input.message_id);
    if (!message || !isMember(db, message.room_id, me)) return rls;
    if (!ALLOWED_EMOJIS.includes(input.emoji)) return { error: { message: 'Emoji non autorisé', code: '23514' } };
    if (db.reactions.some((r) => r.message_id === message.id && r.user_id === me && r.emoji === input.emoji)) {
      return { error: { message: 'Réaction déjà présente', code: '23505' } };
    }
    return { row: { id: db.seq++, message_id: message.id, room_id: message.room_id, user_id: me, emoji: input.emoji, created_at: nowIso() } };
  }

  return { error: { message: 'Permission refusée', code: '42501' } };
}

/* ================================================================== */
/* Fonctions RPC (mêmes noms que dans supabase/schema.sql)            */
/* ================================================================== */

const USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/;
const COLOR_RE = /^#[0-9A-Fa-f]{6}$/;

function addMembers(db, roomId, userIds) {
  const added = [];
  for (const userId of userIds) {
    if (!db.profiles.some((p) => p.id === userId)) continue;
    if (db.room_members.some((m) => m.room_id === roomId && m.user_id === userId)) continue;
    const now = nowIso();
    const row = { room_id: roomId, user_id: userId, joined_at: now, last_delivered_at: now, last_read_at: now };
    db.room_members.push(row);
    added.push(row);
  }
  return added;
}

/** Enregistre puis diffuse les nouveaux membres (et les mises à jour d'accusés). */
function commit(db, { inserted = [], updated = [] } = {}) {
  const storageError = saveDb(db);
  if (storageError) return storageError;
  inserted.forEach((row) => publishChange('room_members', 'INSERT', row));
  updated.forEach((row) => publishChange('room_members', 'UPDATE', row));
  return null;
}

const rpcFunctions = {
  username_available(db, _me, { p_username }) {
    const name = String(p_username ?? '').toLowerCase();
    return { data: !db.profiles.some((p) => p.username.toLowerCase() === name) };
  },

  create_room(db, me, { p_name, p_member_ids }) {
    const name = String(p_name ?? '').trim();
    if (name.length < 1 || name.length > 50) return fail('Nom de salon invalide');
    const now = nowIso();
    const room = { id: uuid(), name, is_direct: false, direct_key: null, created_by: me, created_at: now, last_message_at: now };
    db.rooms.push(room);
    const inserted = addMembers(db, room.id, [me, ...(p_member_ids ?? [])]);
    const error = commit(db, { inserted });
    return error ? { data: null, error } : { data: room.id };
  },

  get_or_create_direct_room(db, me, { p_other }) {
    if (!p_other || p_other === me) return fail('Destinataire invalide');
    if (!db.profiles.some((p) => p.id === p_other)) return fail('Utilisateur introuvable');
    const key = [me, p_other].sort().join(':');
    let room = db.rooms.find((r) => r.direct_key === key);
    if (!room) {
      const now = nowIso();
      room = { id: uuid(), name: null, is_direct: true, direct_key: key, created_by: me, created_at: now, last_message_at: now };
      db.rooms.push(room);
    }
    const inserted = addMembers(db, room.id, [me, p_other]);
    const error = commit(db, { inserted });
    return error ? { data: null, error } : { data: room.id };
  },

  add_room_member(db, me, { p_room, p_user }) {
    if (!isMember(db, p_room, me)) return fail('Accès refusé');
    if (db.rooms.find((r) => r.id === p_room)?.is_direct) {
      return fail("Impossible d'ajouter un membre à une conversation privée");
    }
    const inserted = addMembers(db, p_room, [p_user]);
    const error = commit(db, { inserted });
    return error ? { data: null, error } : { data: null };
  },

  get_my_rooms(db, me) {
    const rooms = db.room_members
      .filter((m) => m.user_id === me)
      .map((mine) => {
        const room = db.rooms.find((r) => r.id === mine.room_id);
        if (!room) return null;
        const other = room.is_direct
          ? db.room_members.find((m) => m.room_id === room.id && m.user_id !== me)
          : null;
        const otherProfile = other ? db.profiles.find((p) => p.id === other.user_id) : null;
        const messages = db.messages.filter((m) => m.room_id === room.id);
        const last = messages.reduce((a, b) => (!a || b.created_at > a.created_at ? b : a), null);
        return {
          id: room.id,
          name: room.is_direct ? (otherProfile?.username ?? 'Utilisateur supprimé') : room.name,
          is_direct: room.is_direct,
          other_user_id: otherProfile?.id ?? null,
          last_message_at: room.last_message_at,
          last_message: last ? (last.content ?? '📷 Image') : null,
          unread_count: messages.filter((m) => m.user_id !== me && m.created_at > mine.last_read_at).length,
        };
      })
      .filter(Boolean)
      .sort((a, b) => (a.last_message_at < b.last_message_at ? 1 : -1));
    return { data: rooms };
  },

  mark_room_read(db, me, { p_room }) {
    const row = db.room_members.find((m) => m.room_id === p_room && m.user_id === me);
    if (!row) return { data: null };
    row.last_read_at = nowIso();
    row.last_delivered_at = row.last_read_at;
    commit(db, { updated: [row] });
    return { data: null };
  },

  mark_all_delivered(db, me) {
    const rows = db.room_members.filter((m) => m.user_id === me);
    const now = nowIso();
    rows.forEach((row) => { row.last_delivered_at = now; });
    commit(db, { updated: rows });
    return { data: null };
  },

  heartbeat(db, me) {
    const profile = db.profiles.find((p) => p.id === me);
    if (profile) { profile.last_seen = nowIso(); saveDb(db); }
    return { data: null };
  },

  update_profile(db, me, { p_username, p_avatar_color }) {
    const profile = db.profiles.find((p) => p.id === me);
    if (!profile) return fail('Profil introuvable');
    const username = String(p_username ?? '').trim();
    if (!USERNAME_RE.test(username)) return fail('Pseudo invalide');
    if (!COLOR_RE.test(p_avatar_color ?? '')) return fail('Couleur invalide');
    if (db.profiles.some((p) => p.id !== me && p.username.toLowerCase() === username.toLowerCase())) {
      return fail('Ce pseudo est déjà utilisé', '23505');
    }
    profile.username = username;
    profile.avatar_color = p_avatar_color;
    const error = saveDb(db);
    return error ? { data: null, error } : { data: structuredClone(profile) };
  },
};

async function rpc(name, args = {}) {
  const fn = rpcFunctions[name];
  if (!fn) return fail(`Fonction inconnue : ${name}`);
  const me = currentUserId();
  if (!me && name !== 'username_available') return fail('Non authentifié', '401');
  const result = fn(loadDb(), me, args);
  return { data: result.data ?? null, error: result.error ?? null };
}

/* ================================================================== */
/* Authentification                                                    */
/* ================================================================== */

const authListeners = new Set();
const notifyAuth = (event, session) => authListeners.forEach((cb) => cb(event, session));
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const auth = {
  async getSession() {
    return { data: { session: getSession() }, error: null };
  },

  async getUser() {
    return { data: { user: getSession()?.user ?? null }, error: null };
  },

  onAuthStateChange(callback) {
    authListeners.add(callback);
    return { data: { subscription: { unsubscribe: () => authListeners.delete(callback) } } };
  },

  async signUp({ email, password, options = {} }) {
    email = String(email ?? '').trim().toLowerCase();
    if (!EMAIL_RE.test(email)) return fail('Unable to validate email address: invalid format');
    if (String(password ?? '').length < 6) return fail('Password should be at least 6 characters');

    const db = loadDb();
    if (db.users.some((u) => u.email === email)) return fail('User already registered');

    const username = String(options.data?.username ?? '').trim();
    const color = COLOR_RE.test(options.data?.avatar_color ?? '') ? options.data.avatar_color : '#4f7cff';
    if (!USERNAME_RE.test(username)) return fail('Pseudo invalide');
    if (db.profiles.some((p) => p.username.toLowerCase() === username.toLowerCase())) {
      return fail('Ce pseudo est déjà utilisé.');
    }

    const now = nowIso();
    const user = { id: uuid(), email, created_at: now };
    db.users.push({ ...user, password_hash: await hashPassword(email, password) });
    db.profiles.push({ id: user.id, username, avatar_color: color, last_seen: now, created_at: now });
    const storageError = saveDb(db);
    if (storageError) return { data: null, error: storageError };

    const session = { user, access_token: 'local' };
    setSession(session);
    notifyAuth('SIGNED_IN', session);
    return { data: { user, session }, error: null };
  },

  async signInWithPassword({ email, password }) {
    email = String(email ?? '').trim().toLowerCase();
    const db = loadDb();
    const record = db.users.find((u) => u.email === email);
    if (!record || record.password_hash !== await hashPassword(email, password)) {
      return fail('Invalid login credentials');
    }
    const user = { id: record.id, email: record.email, created_at: record.created_at };
    const session = { user, access_token: 'local' };
    setSession(session);
    notifyAuth('SIGNED_IN', session);
    return { data: { user, session }, error: null };
  },

  async updateUser({ password }) {
    const session = getSession();
    if (!session) return fail('Non authentifié', '401');
    if (String(password ?? '').length < 6) return fail('Password should be at least 6 characters');
    const db = loadDb();
    const record = db.users.find((u) => u.id === session.user.id);
    record.password_hash = await hashPassword(record.email, password);
    const error = saveDb(db);
    return error ? { data: null, error } : { data: { user: session.user }, error: null };
  },

  async signOut() {
    setSession(null);
    notifyAuth('SIGNED_OUT', null);
    return { error: null };
  },
};

/* ================================================================== */
/* Stockage des images                                                 */
/* ================================================================== */

const fileUrls = new Map();

/** Lit un fichier en data URL. */
function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Lecture du fichier impossible'));
    reader.readAsDataURL(file);
  });
}

/** Réduit l'image (1024 px max, JPEG) pour ménager le localStorage (~5 Mo). */
async function compressImage(file) {
  const original = await readAsDataUrl(file);
  if (file.type === 'image/gif' && file.size < 600000) return original; // conserve l'animation
  const img = new Image();
  img.src = original;
  await img.decode();
  const scale = Math.min(1, 1024 / Math.max(img.width, img.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.width * scale);
  canvas.height = Math.round(img.height * scale);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff'; // fond blanc pour les PNG transparents
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.75);
}

const storage = {
  from() {
    return {
      async upload(path, file) {
        try {
          fileUrls.set(path, await compressImage(file));
          return { data: { path }, error: null };
        } catch (error) {
          return { data: null, error: { message: error.message } };
        }
      },
      getPublicUrl(path) {
        return { data: { publicUrl: fileUrls.get(path) ?? '' } };
      },
    };
  },
};

/* ================================================================== */
/* Client exporté (même forme que celui de supabase-js)                */
/* ================================================================== */

export function createLocalClient() {
  return {
    auth,
    from: (table) => new LocalQuery(table),
    rpc,
    channel: (name, options) => new LocalChannel(name, options),
    removeChannel: (channel) => channel?.unsubscribe(),
    storage,
  };
}

/** Efface toutes les données du mode démo (utilisé par la page Profil). */
export function resetLocalData() {
  try {
    localStorage.removeItem(DB_KEY);
    sessionStorage.removeItem(SESSION_KEY);
  } catch { /* ignoré */ }
}

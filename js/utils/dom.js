/**
 * dom.js — Petites fonctions utilitaires pour le DOM et le formatage.
 * Toutes les données utilisateur sont insérées avec textContent (jamais innerHTML)
 * afin d'empêcher les attaques XSS.
 */

/** Raccourci pour document.querySelector. */
export const $ = (selector, root = document) => root.querySelector(selector);

/**
 * Crée un élément HTML.
 * @param {string} tag      Nom de la balise
 * @param {object} props    Propriétés : className, text, attrs, dataset, on (événements)
 * @param {Array}  children Enfants (éléments ou chaînes)
 */
export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  if (props.className) node.className = props.className;
  if (props.text !== undefined) node.textContent = props.text;
  if (props.title) node.title = props.title;
  if (props.attrs) {
    for (const [key, value] of Object.entries(props.attrs)) node.setAttribute(key, value);
  }
  if (props.dataset) Object.assign(node.dataset, props.dataset);
  if (props.on) {
    for (const [event, handler] of Object.entries(props.on)) node.addEventListener(event, handler);
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child);
  }
  return node;
}

/** Crée un avatar rond avec l'initiale du pseudo et sa couleur. */
export function avatar(profile, withStatus = false, online = false) {
  const name = profile?.username ?? '?';
  const node = el('span', { className: 'avatar', text: name.charAt(0).toUpperCase() });
  node.style.backgroundColor = profile?.avatar_color ?? '#8a8f98';
  if (withStatus) {
    node.append(el('span', {
      className: `status-dot ${online ? 'is-online' : ''}`,
      attrs: { 'aria-label': online ? 'en ligne' : 'hors ligne' },
    }));
  }
  return node;
}

/** Heure au format 14:05. */
export function formatTime(date) {
  return new Date(date).toLocaleTimeString('fr-CA', { hour: '2-digit', minute: '2-digit' });
}

/** Date et heure complètes (infobulle d'un message). */
export function formatFull(date) {
  return new Date(date).toLocaleString('fr-CA', { dateStyle: 'full', timeStyle: 'short' });
}

/** Libellé de jour pour les séparateurs : « Aujourd'hui », « Hier » ou la date. */
export function formatDay(date) {
  const d = new Date(date);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Aujourd'hui";
  if (d.toDateString() === yesterday.toDateString()) return 'Hier';
  return d.toLocaleDateString('fr-CA', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

/** Heure si aujourd'hui, sinon date courte (liste des salons). */
export function formatShort(date) {
  const d = new Date(date);
  if (d.toDateString() === new Date().toDateString()) return formatTime(d);
  return d.toLocaleDateString('fr-CA', { day: 'numeric', month: 'short' });
}

/** « vu à 14:05 », « vu hier », etc. */
export function formatLastSeen(date) {
  if (!date) return 'hors ligne';
  const d = new Date(date);
  const diffMin = Math.round((Date.now() - d.getTime()) / 60000);
  if (diffMin < 1) return "vu à l'instant";
  if (diffMin < 60) return `vu il y a ${diffMin} min`;
  if (d.toDateString() === new Date().toDateString()) return `vu à ${formatTime(d)}`;
  return `vu le ${d.toLocaleDateString('fr-CA', { day: 'numeric', month: 'short' })}`;
}

/** Échappe les caractères spéciaux d'un motif ILIKE (% _ \). */
export function escapeLike(text) {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** Affiche un message éphémère (toast) en bas de l'écran. */
export function toast(message, type = 'info', onClick = null) {
  const container = $('#toasts') ?? document.body.appendChild(el('div', { attrs: { id: 'toasts' } }));
  const node = el('div', { className: `toast toast-${type}`, text: message, attrs: { role: 'status' } });
  if (onClick) {
    node.classList.add('is-clickable');
    node.addEventListener('click', () => { onClick(); node.remove(); });
  }
  container.append(node);
  setTimeout(() => node.remove(), 4500);
}

/** Lecture / écriture sécurisées du localStorage (peut être indisponible). */
export const storage = {
  get(key, fallback = null) {
    try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, value); } catch { /* stockage indisponible : ignoré */ }
  },
};

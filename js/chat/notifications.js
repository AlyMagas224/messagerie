/**
 * notifications.js — Notifications visuelles et sonores à la réception d'un message.
 *
 *  - Son court généré avec la Web Audio API (aucun fichier audio requis)
 *  - Notification système du navigateur si l'onglet est en arrière-plan
 *  - Compteur de messages non lus dans le titre de l'onglet : « (3) Babil »
 *  - Toast cliquable si le message arrive dans un autre salon
 */
import { $, storage, toast } from '../utils/dom.js';
import { state, emit } from './state.js';

const BASE_TITLE = 'Babil';
let audioContext = null;
let soundEnabled = storage.get('babil:sound', 'on') === 'on';

export function initNotifications() {
  const button = $('#btn-sound');
  updateSoundButton(button);

  button.addEventListener('click', () => {
    soundEnabled = !soundEnabled;
    storage.set('babil:sound', soundEnabled ? 'on' : 'off');
    updateSoundButton(button);
    if (soundEnabled) playSound();
  });

  // Le navigateur exige une interaction de l'utilisateur avant de jouer un son
  // ou de demander l'autorisation d'afficher des notifications.
  document.addEventListener('click', () => {
    audioContext ??= new (window.AudioContext || window.webkitAudioContext)();
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission();
    }
  }, { once: true });
}

function updateSoundButton(button) {
  button.textContent = soundEnabled ? '🔔' : '🔕';
  button.setAttribute('aria-pressed', String(soundEnabled));
  button.title = soundEnabled ? 'Couper le son des notifications' : 'Activer le son des notifications';
}

/** Joue un « ding » à deux notes. */
export function playSound() {
  if (!soundEnabled || !audioContext) return;
  const now = audioContext.currentTime;
  [880, 1320].forEach((frequency, i) => {
    const osc = audioContext.createOscillator();
    const gain = audioContext.createGain();
    osc.type = 'sine';
    osc.frequency.value = frequency;
    gain.gain.setValueAtTime(0.0001, now + i * 0.12);
    gain.gain.exponentialRampToValueAtTime(0.2, now + i * 0.12 + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.12 + 0.25);
    osc.connect(gain).connect(audioContext.destination);
    osc.start(now + i * 0.12);
    osc.stop(now + i * 0.12 + 0.3);
  });
}

/**
 * Notifie l'utilisateur d'un nouveau message.
 * @param {object} message   Le message reçu
 * @param {string} author    Pseudo de l'auteur
 * @param {string} roomName  Nom du salon
 * @param {boolean} inCurrentRoom  Le salon est-il ouvert ?
 */
export function notifyMessage(message, author, roomName, inCurrentRoom) {
  const visible = document.visibilityState === 'visible';
  const preview = message.content ?? '📷 Image';

  // Salon ouvert et page visible : l'utilisateur voit déjà le message
  if (inCurrentRoom && visible) return;

  playSound();

  if (!visible && 'Notification' in window && Notification.permission === 'granted') {
    const notification = new Notification(`${author} — ${roomName}`, {
      body: preview.slice(0, 120),
      icon: 'assets/favicon.svg',
      tag: message.room_id, // regroupe les notifications d'un même salon
    });
    notification.onclick = () => {
      window.focus();
      emit('room:open', message.room_id);
      notification.close();
    };
  } else if (!inCurrentRoom) {
    toast(`💬 ${author} (${roomName}) : ${preview.slice(0, 60)}`, 'info',
      () => emit('room:open', message.room_id));
  }
}

/** Met à jour le compteur global de non-lus (titre de l'onglet et badge). */
export function updateUnreadCounter() {
  const total = state.rooms.reduce((sum, room) => sum + Number(room.unread_count || 0), 0);
  document.title = total > 0 ? `(${total}) ${BASE_TITLE}` : BASE_TITLE;
  const badge = $('#total-unread');
  badge.hidden = total === 0;
  badge.textContent = total > 99 ? '99+' : String(total);
}

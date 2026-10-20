/**
 * site.js — Comportements communs à toutes les pages publiques :
 *   - menu de navigation sur téléphone (bouton ☰)
 *   - boutons de l'accueil affichés selon la connexion (data-auth="guest" | "user")
 *
 * Exporte la session courante pour les scripts propres à chaque page.
 */
import { supabase, backendMode } from '../services/supabase.js';

/* Menu mobile */
const toggle = document.querySelector('.nav-toggle');
const nav = document.querySelector('.site-nav');
toggle?.addEventListener('click', () => {
  const open = nav.classList.toggle('is-open');
  toggle.setAttribute('aria-expanded', String(open));
  toggle.textContent = open ? '✕' : '☰';
});

/* Liens selon la connexion */
const { data: { session: currentSession } } = await supabase.auth.getSession();
document.querySelectorAll('[data-auth]').forEach((node) => {
  node.hidden = node.dataset.auth === 'user' ? !currentSession : Boolean(currentSession);
});

/* Année du pied de page */
document.querySelectorAll('[data-year]').forEach((node) => { node.textContent = new Date().getFullYear(); });

export const session = currentSession;
export { supabase, backendMode };

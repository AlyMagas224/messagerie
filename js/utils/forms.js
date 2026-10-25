/**
 * forms.js — Fonctions communes aux formulaires (connexion, inscription, profil).
 */

/** Affiche un message (erreur ou succès) dans l'élément .form-message du formulaire. */
export function setMessage(form, text, type = 'error') {
  const node = form.querySelector('.form-message');
  node.textContent = text;
  node.className = `form-message ${text ? `is-${type}` : ''}`;
}

/** Désactive le bouton d'envoi pendant une requête (évite les doubles envois). */
export function setLoading(form, loading) {
  const button = form.querySelector('button[type="submit"]');
  button.disabled = loading;
  button.classList.toggle('is-loading', loading);
}

/** Traduit en français les erreurs courantes de Supabase. */
export function translateError(error) {
  const msg = (error?.message ?? '').toLowerCase();
  if (msg.includes('invalid login credentials')) return 'Courriel ou mot de passe incorrect.';
  if (msg.includes('email not confirmed')) return 'Veuillez confirmer votre adresse courriel (voir votre boîte de réception).';
  if (msg.includes('already registered')) return 'Un compte existe déjà avec cette adresse courriel.';
  if (msg.includes('invalid format') || msg.includes('invalid email')) return 'Adresse courriel invalide.';
  if (msg.includes('password')) return 'Le mot de passe doit contenir au moins 6 caractères.';
  if (msg.includes('rate limit')) return 'Trop de tentatives. Réessayez dans quelques minutes.';
  if (msg.includes('database error saving new user')) return 'Ce pseudo est peut-être déjà pris. Essayez-en un autre.';
  if (msg.includes('failed to fetch') || msg.includes('network')) return 'Impossible de joindre le serveur. Vérifiez votre connexion et js/config.js.';
  return error?.message || 'Une erreur est survenue.';
}

/** Ajoute un bouton 👁 pour afficher / masquer les mots de passe. */
export function enablePasswordToggles(root = document) {
  root.querySelectorAll('.password-field').forEach((wrapper) => {
    const input = wrapper.querySelector('input');
    const button = wrapper.querySelector('.password-toggle');
    button.addEventListener('click', () => {
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      button.textContent = show ? '🙈' : '👁';
      button.setAttribute('aria-label', show ? 'Masquer le mot de passe' : 'Afficher le mot de passe');
    });
  });
}

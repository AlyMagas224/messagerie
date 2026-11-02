/**
 * connexion.js — Page connexion.html :
 *   1. connexion par courriel et mot de passe ;
 *   2. « Mot de passe oublié » : Supabase envoie un lien de réinitialisation par courriel ;
 *   3. retour depuis ce lien : choix d'un nouveau mot de passe, puis accès à la messagerie.
 */
import { supabase, session, backendMode } from './site.js';
import { setMessage, setLoading, translateError, enablePasswordToggles } from '../utils/forms.js';

const title = document.querySelector('#auth-title');
const subtitle = document.querySelector('#auth-subtitle');
const loginForm = document.querySelector('#login-form');
const forgotForm = document.querySelector('#forgot-form');
const resetForm = document.querySelector('#reset-form');

/** Les trois « vues » de la page : un seul formulaire visible à la fois. */
const VIEWS = {
  login: { form: loginForm, title: 'Connexion', subtitle: 'Heureux de vous revoir !' },
  forgot: {
    form: forgotForm,
    title: 'Mot de passe oublié',
    subtitle: 'Saisissez votre adresse courriel : nous vous enverrons un lien pour choisir un nouveau mot de passe.',
  },
  reset: { form: resetForm, title: 'Nouveau mot de passe', subtitle: 'Choisissez un nouveau mot de passe.' },
};

/** Affiche une vue et cache les autres. */
function showView(name) {
  Object.entries(VIEWS).forEach(([key, view]) => { view.form.hidden = key !== name; });
  title.textContent = VIEWS[name].title;
  subtitle.textContent = VIEWS[name].subtitle;
  VIEWS[name].form.querySelector('input')?.focus();
}

enablePasswordToggles(loginForm);
enablePasswordToggles(resetForm);

// Liens « Mot de passe oublié ? » et « Retour à la connexion »
document.querySelectorAll('[data-view]').forEach((link) => {
  link.addEventListener('click', (event) => {
    event.preventDefault();
    // Reprend l'adresse déjà saisie d'un formulaire à l'autre
    const email = VIEWS[link.dataset.view === 'forgot' ? 'login' : 'forgot'].form.elements.email.value;
    VIEWS[link.dataset.view].form.elements.email.value = email;
    showView(link.dataset.view);
  });
});

/* ------------------------------------------------------------------ */
/* Arrivée sur la page : connexion normale ou retour du lien courriel  */
/* ------------------------------------------------------------------ */

// Paramètres du lien reçu par courriel (mémorisés dans connexion.html)
const params = new URLSearchParams(window.AUTH_REDIRECT_PARAMS ?? '');
const isRecoveryLink = params.get('type') === 'recovery';
const linkError = params.get('error_code') || params.get('error');

if (linkError) {
  // Lien expiré ou déjà utilisé : on propose d'en demander un nouveau
  showView('forgot');
  setMessage(forgotForm, linkError === 'otp_expired'
    ? 'Ce lien a expiré ou a déjà été utilisé. Demandez un nouveau lien.'
    : "Ce lien de réinitialisation n'est pas valide. Demandez un nouveau lien.");
} else if (isRecoveryLink && session) {
  // Lien valide : Supabase a ouvert une session temporaire de récupération
  showView('reset');
  subtitle.textContent = `Choisissez un nouveau mot de passe pour ${session.user.email}.`;
} else if (session) {
  // Déjà connecté : direction la messagerie
  window.location.replace('chat.html');
}

/* ------------------------------------------------------------------ */
/* 1. Connexion                                                        */
/* ------------------------------------------------------------------ */
loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!loginForm.checkValidity()) {
    setMessage(loginForm, 'Veuillez saisir une adresse courriel valide et votre mot de passe.');
    return;
  }
  const { email, password } = Object.fromEntries(new FormData(loginForm));

  setLoading(loginForm, true);
  setMessage(loginForm, '');
  const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
  setLoading(loginForm, false);

  if (error) return setMessage(loginForm, translateError(error));
  window.location.replace('chat.html');
});

/* ------------------------------------------------------------------ */
/* 2. Mot de passe oublié : envoi du lien par courriel                 */
/* ------------------------------------------------------------------ */
forgotForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!forgotForm.checkValidity()) {
    setMessage(forgotForm, 'Veuillez saisir une adresse courriel valide.');
    return;
  }
  if (backendMode !== 'supabase') {
    setMessage(forgotForm, "La réinitialisation par courriel n'est pas disponible en mode démo.");
    return;
  }
  const { email } = Object.fromEntries(new FormData(forgotForm));

  // Le lien du courriel ramènera sur cette page (en local comme sur GitHub Pages)
  const redirectTo = new URL('connexion.html', window.location.href).href;

  setLoading(forgotForm, true);
  setMessage(forgotForm, '');
  const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), { redirectTo });
  setLoading(forgotForm, false);

  if (error) return setMessage(forgotForm, translateResetError(error));

  // Même message que le compte existe ou non : on ne révèle pas quelles adresses sont inscrites
  setMessage(forgotForm,
    'Si un compte existe avec cette adresse, un courriel contenant un lien de réinitialisation '
    + 'vient de vous être envoyé. Pensez à vérifier vos courriels indésirables.', 'success');
});

/* ------------------------------------------------------------------ */
/* 3. Nouveau mot de passe                                             */
/* ------------------------------------------------------------------ */
resetForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const { password, confirm } = Object.fromEntries(new FormData(resetForm));
  if (password.length < 6) return setMessage(resetForm, 'Le mot de passe doit contenir au moins 6 caractères.');
  if (password !== confirm) return setMessage(resetForm, 'Les deux mots de passe ne correspondent pas.');

  setLoading(resetForm, true);
  setMessage(resetForm, '');
  const { error } = await supabase.auth.updateUser({ password });
  setLoading(resetForm, false);

  if (error) return setMessage(resetForm, translateResetError(error));

  setMessage(resetForm, 'Mot de passe modifié ! Redirection vers la messagerie…', 'success');
  resetForm.querySelector('button[type="submit"]').disabled = true;
  setTimeout(() => window.location.replace('chat.html'), 2000);
});

/** Traduit en français les erreurs propres à la réinitialisation du mot de passe. */
function translateResetError(error) {
  const msg = (error?.message ?? '').toLowerCase();
  const code = error?.code ?? '';
  if (code === 'over_email_send_rate_limit' || msg.includes('email rate limit')) {
    return 'Trop de courriels envoyés. Réessayez dans une heure.';
  }
  if (code === 'email_address_not_authorized' || msg.includes('not authorized')) {
    return "Le serveur de courriel n'est pas encore configuré pour cette adresse. Contactez l'administrateur du site.";
  }
  if (msg.includes('for security purposes')) return 'Veuillez patienter une minute avant de demander un nouveau lien.';
  if (code === 'same_password' || msg.includes('different from the old password')) {
    return "Le nouveau mot de passe doit être différent de l'ancien.";
  }
  if (msg.includes('session missing')) return 'Le lien a expiré. Demandez un nouveau lien de réinitialisation.';
  return translateError(error);
}

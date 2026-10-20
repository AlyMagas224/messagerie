/**
 * inscription.js — Page inscription.html : création d'un compte.
 * Le profil (pseudo, couleur) est créé côté serveur par le trigger SQL
 * handle_new_user à partir des données transmises dans options.data.
 */
import { supabase, session } from './site.js';
import { setMessage, setLoading, translateError, enablePasswordToggles } from '../utils/forms.js';

if (session) window.location.replace('chat.html');

const form = document.querySelector('#signup-form');
enablePasswordToggles(form);

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(form));
  const username = data.username.trim();

  // Validations côté client (répétées côté serveur)
  if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) {
    return setMessage(form, 'Pseudo : 3 à 20 caractères (lettres sans accent, chiffres ou _).');
  }
  if (!form.elements.email.checkValidity()) return setMessage(form, 'Adresse courriel invalide.');
  if (data.password.length < 6) return setMessage(form, 'Le mot de passe doit contenir au moins 6 caractères.');
  if (data.password !== data.confirm) return setMessage(form, 'Les deux mots de passe ne correspondent pas.');

  setLoading(form, true);
  setMessage(form, '');

  // 1. Le pseudo est-il libre ?
  const { data: available, error: rpcError } = await supabase.rpc('username_available', { p_username: username });
  if (rpcError || !available) {
    setLoading(form, false);
    return setMessage(form, rpcError ? translateError(rpcError) : 'Ce pseudo est déjà utilisé.');
  }

  // 2. Création du compte
  const { data: result, error } = await supabase.auth.signUp({
    email: data.email.trim(),
    password: data.password,
    options: {
      data: { username, avatar_color: data.color },
      emailRedirectTo: new URL('chat.html', window.location.href).href,
    },
  });
  setLoading(form, false);

  if (error) return setMessage(form, translateError(error));

  if (result.session) {
    // Connexion immédiate (mode démo, ou confirmation par courriel désactivée)
    window.location.replace('chat.html');
  } else {
    // Supabase avec confirmation par courriel activée
    setMessage(form, 'Compte créé ! Confirmez votre adresse via le courriel reçu, puis connectez-vous.', 'success');
    form.reset();
  }
});

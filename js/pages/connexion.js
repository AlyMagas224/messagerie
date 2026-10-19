/**
 * connexion.js — Page connexion.html : connexion par courriel et mot de passe.
 */
import { supabase, session } from './site.js';
import { setMessage, setLoading, translateError, enablePasswordToggles } from '../utils/forms.js';

// Déjà connecté : direction la messagerie
if (session) window.location.replace('chat.html');

const form = document.querySelector('#login-form');
enablePasswordToggles(form);

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!form.checkValidity()) {
    setMessage(form, 'Veuillez saisir une adresse courriel valide et votre mot de passe.');
    return;
  }
  const { email, password } = Object.fromEntries(new FormData(form));

  setLoading(form, true);
  setMessage(form, '');
  const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
  setLoading(form, false);

  if (error) return setMessage(form, translateError(error));
  window.location.replace('chat.html');
});

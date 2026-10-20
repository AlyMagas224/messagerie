/**
 * profil.js — Page profil.html : modification du pseudo, de la couleur
 * de l'avatar et du mot de passe ; déconnexion.
 */
import { supabase, session, backendMode } from './site.js';
import { avatar, $ } from '../utils/dom.js';
import { setMessage, setLoading, translateError, enablePasswordToggles } from '../utils/forms.js';

if (!session) {
  window.location.replace('connexion.html');
  await new Promise(() => {}); // stoppe le script pendant la redirection
}

const profileForm = $('#profile-form');
const passwordForm = $('#password-form');
enablePasswordToggles(passwordForm);

/* ------------------------------------------------------------------ */
/* Chargement du profil et des statistiques                            */
/* ------------------------------------------------------------------ */

const [{ data: profile, error }, { data: rooms }, { data: contacts }] = await Promise.all([
  supabase.from('profiles').select('id, username, avatar_color, created_at').eq('id', session.user.id).single(),
  supabase.rpc('get_my_rooms'),
  supabase.from('contacts').select('contact_id'),
]);

if (error || !profile) {
  $('#profile-name').textContent = 'Profil introuvable';
  throw error ?? new Error('Profil introuvable');
}

/** Affiche le résumé (avatar, pseudo, courriel, statistiques). */
function renderSummary(p) {
  $('#profile-avatar').replaceChildren(avatar(p));
  $('#profile-name').textContent = p.username;
}

renderSummary(profile);
$('#profile-email').textContent = session.user.email ?? '';
$('#stat-rooms').textContent = rooms?.length ?? 0;
$('#stat-contacts').textContent = contacts?.length ?? 0;

profileForm.elements.username.value = profile.username;
const colorInput = profileForm.querySelector(`input[name="color"][value="${profile.avatar_color}"]`);
if (colorInput) colorInput.checked = true;

// Aperçu en direct de l'avatar
profileForm.addEventListener('input', () => {
  const data = Object.fromEntries(new FormData(profileForm));
  $('#profile-avatar').replaceChildren(avatar({ username: data.username || '?', avatar_color: data.color }));
});

/* ------------------------------------------------------------------ */
/* Modification du profil                                              */
/* ------------------------------------------------------------------ */

profileForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const { username, color } = Object.fromEntries(new FormData(profileForm));
  if (!/^[A-Za-z0-9_]{3,20}$/.test(username.trim())) {
    return setMessage(profileForm, 'Pseudo : 3 à 20 caractères (lettres sans accent, chiffres ou _).');
  }

  setLoading(profileForm, true);
  const { data, error: updateError } = await supabase.rpc('update_profile', {
    p_username: username.trim(),
    p_avatar_color: color,
  });
  setLoading(profileForm, false);

  if (updateError) {
    const taken = updateError.code === '23505' || /déjà utilisé/i.test(updateError.message);
    return setMessage(profileForm, taken ? 'Ce pseudo est déjà utilisé.' : translateError(updateError));
  }
  renderSummary(data);
  setMessage(profileForm, 'Profil mis à jour.', 'success');
});

/* ------------------------------------------------------------------ */
/* Changement de mot de passe                                          */
/* ------------------------------------------------------------------ */

passwordForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const { password, confirm } = Object.fromEntries(new FormData(passwordForm));
  if (password.length < 6) return setMessage(passwordForm, 'Le mot de passe doit contenir au moins 6 caractères.');
  if (password !== confirm) return setMessage(passwordForm, 'Les deux mots de passe ne correspondent pas.');

  setLoading(passwordForm, true);
  const { error: pwError } = await supabase.auth.updateUser({ password });
  setLoading(passwordForm, false);

  if (pwError) return setMessage(passwordForm, translateError(pwError));
  passwordForm.reset();
  setMessage(passwordForm, 'Mot de passe modifié.', 'success');
});

/* ------------------------------------------------------------------ */
/* Déconnexion et réinitialisation du mode démo                        */
/* ------------------------------------------------------------------ */

$('#btn-logout').addEventListener('click', async () => {
  await supabase.auth.signOut();
  window.location.replace('index.html');
});

const resetButton = $('#btn-reset-demo');
if (backendMode === 'local') {
  resetButton.hidden = false;
  resetButton.addEventListener('click', async () => {
    if (!confirm('Effacer TOUS les comptes et messages du mode démo enregistrés dans ce navigateur ?')) return;
    const { resetLocalData } = await import('../services/local-backend.js');
    resetLocalData();
    window.location.replace('index.html');
  });
}

/**
 * images.js — Partage d'images via Supabase Storage.
 * Les fichiers sont déposés dans le bucket « chat-images » sous le chemin
 * <room_id>/<identifiant-aléatoire>.<extension>
 */
import { supabase, backendMode } from '../services/supabase.js';
import { SUPABASE_URL, IMAGE_BUCKET, MAX_IMAGE_SIZE } from '../config.js';

const ALLOWED_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

/** Vérifie le fichier ; retourne un message d'erreur ou null s'il est valide. */
export function validateImage(file) {
  if (!ALLOWED_TYPES.includes(file.type)) return 'Formats acceptés : PNG, JPEG, GIF, WEBP.';
  if (file.size > MAX_IMAGE_SIZE) return `Image trop lourde (maximum ${MAX_IMAGE_SIZE / 1024 / 1024} Mo).`;
  return null;
}

/**
 * Envoie l'image dans le stockage et retourne son URL publique.
 * @throws {Error} si l'envoi échoue
 */
export async function uploadImage(file, roomId) {
  const extension = file.type.split('/')[1].replace('jpeg', 'jpg');
  const path = `${roomId}/${crypto.randomUUID()}.${extension}`;

  const { error } = await supabase.storage
    .from(IMAGE_BUCKET)
    .upload(path, file, { contentType: file.type, cacheControl: '31536000', upsert: false });
  if (error) throw error;

  return supabase.storage.from(IMAGE_BUCKET).getPublicUrl(path).data.publicUrl;
}

/**
 * Sécurité : n'affiche que les images provenant de NOTRE bucket
 * (empêche l'insertion de liens arbitraires, ex. « javascript: »).
 */
export function isAllowedImageUrl(url) {
  if (typeof url !== 'string') return false;
  // Mode démo : les images sont stockées sous forme de data URL
  if (backendMode === 'local') return /^data:image\/(png|jpeg|gif|webp);base64,/.test(url);
  return url.startsWith(`${SUPABASE_URL.replace(/\/$/, '')}/storage/v1/object/public/${IMAGE_BUCKET}/`);
}

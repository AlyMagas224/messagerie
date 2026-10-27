/**
 * config.js — Paramètres de connexion à Supabase.
 *
 * À remplir avec les valeurs de VOTRE projet :
 *   Supabase > Project Settings > API
 *     - Project URL           → SUPABASE_URL
 *     - anon / public key     → SUPABASE_ANON_KEY
 *
 * La clé « anon » est publique par conception : elle peut être publiée sur
 * GitHub Pages. La sécurité des données est assurée par les politiques RLS
 * définies dans supabase/schema.sql. Ne JAMAIS mettre la clé « service_role » ici.
 */
export const SUPABASE_URL = 'https://VOTRE-PROJET.supabase.co';
export const SUPABASE_ANON_KEY = 'VOTRE-CLE-ANON-PUBLIQUE';

/** Nom du bucket de stockage des images (doit correspondre à schema.sql). */
export const IMAGE_BUCKET = 'chat-images';

/** Taille maximale d'une image envoyée (5 Mo, identique à la limite du bucket). */
export const MAX_IMAGE_SIZE = 5 * 1024 * 1024;

/** Nombre de messages chargés à l'ouverture d'un salon (puis par « Charger plus »). */
export const PAGE_SIZE = 50;

/** Emojis disponibles pour les réactions (doit correspondre à la contrainte SQL). */
export const REACTION_EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '🎉'];

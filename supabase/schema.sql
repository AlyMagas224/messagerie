-- =============================================================================
-- ALY & CONDE Services — Boutique en ligne (cours 8WEB101)
-- Schéma de base de données Supabase (PostgreSQL)
--
-- MODE D'EMPLOI (uniquement pour activer Supabase, le site fonctionne sans) :
--   Supabase > SQL Editor > New query > coller CE FICHIER en entier > Run.
--   Le script est rejouable sans erreur et ne réinitialise pas les stocks.
--
-- PRINCIPE DE SÉCURITÉ : le navigateur ne peut PAS écrire directement dans les
-- commandes ni modifier les prix. Une commande passe par la fonction
-- place_order(), qui relit les prix et les stocks dans la base et calcule les
-- taxes côté serveur. Un visiteur ne peut donc pas s'accorder un rabais.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. TABLES
-- -----------------------------------------------------------------------------

-- Catalogue (lecture publique, modification par l'administrateur seulement)
create table if not exists public.products (
  id           text primary key,
  name         text not null,
  description  text not null default '',
  details      text[] not null default '{}',
  category     text not null check (category in ('ordinateurs', 'accessoires', 'services')),
  kind         text not null check (kind in ('produit', 'service')),
  price        numeric(10, 2) not null check (price >= 0),
  stock        integer check (stock is null or stock >= 0),  -- null = service (sans stock)
  emoji        text not null default '📦',
  color        text not null default '#d3e7e4',
  image        text,
  featured     boolean not null default false,
  created_at   timestamptz not null default now()
);

-- Favoris (fonctionnalité secondaire) : un utilisateur, un produit
create table if not exists public.favorites (
  user_id     uuid not null references auth.users (id) on delete cascade,
  product_id  text not null references public.products (id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (user_id, product_id)
);

-- Codes promotionnels (FONCTIONNALITÉ SUPPLÉMENTAIRE).
-- Aucune lecture directe permise : on ne peut pas « lister » les codes.
create table if not exists public.promo_codes (
  code          text primary key,
  kind          text not null check (kind in ('percent', 'free_shipping')),
  value         numeric(5, 2) not null default 0 check (value >= 0 and value <= 100),
  min_subtotal  numeric(10, 2) not null default 0,
  active        boolean not null default true,
  expires_at    timestamptz
);

create sequence if not exists public.order_number_seq;

-- Commandes
create table if not exists public.orders (
  id              uuid primary key default gen_random_uuid(),
  number          text not null unique,
  user_id         uuid not null references auth.users (id) on delete cascade,
  status          text not null default 'En attente',
  subtotal        numeric(10, 2) not null default 0,
  discount        numeric(10, 2) not null default 0,
  shipping        numeric(10, 2) not null default 0,
  tps             numeric(10, 2) not null default 0,
  tvq             numeric(10, 2) not null default 0,
  total           numeric(10, 2) not null default 0,
  promo_code      text,
  payment_method  text not null check (payment_method in ('livraison', 'interac')),
  customer        jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now()
);
create index if not exists orders_user_idx on public.orders (user_id, created_at desc);

-- Lignes de commande (le nom et le prix sont « figés » au moment de l'achat)
create table if not exists public.order_items (
  id          bigint generated always as identity primary key,
  order_id    uuid not null references public.orders (id) on delete cascade,
  product_id  text references public.products (id) on delete set null,
  name        text not null,
  unit_price  numeric(10, 2) not null,
  quantity    integer not null check (quantity between 1 and 20)
);
create index if not exists order_items_order_idx on public.order_items (order_id);

-- Messages du formulaire de contact
create table if not exists public.contact_messages (
  id          bigint generated always as identity primary key,
  name        text not null check (char_length(name) between 2 and 100),
  email       text not null check (char_length(email) between 5 and 200),
  subject     text not null check (char_length(subject) between 2 and 150),
  message     text not null check (char_length(message) between 5 and 2000),
  created_at  timestamptz not null default now()
);


-- -----------------------------------------------------------------------------
-- 2. FONCTIONS (« security definer » : exécutées avec les droits du propriétaire)
-- -----------------------------------------------------------------------------

-- Vérifie un code promotionnel pour un sous-total donné (en dollars).
create or replace function public.validate_promo(p_code text, p_subtotal numeric)
returns jsonb
language plpgsql stable security definer
set search_path = public
as $$
declare
  v_promo public.promo_codes%rowtype;
begin
  select * into v_promo
  from public.promo_codes
  where upper(code) = upper(trim(coalesce(p_code, '')))
    and active
    and (expires_at is null or expires_at > now());

  if not found then
    return jsonb_build_object('valid', false, 'reason', 'unknown');
  end if;

  if coalesce(p_subtotal, 0) < v_promo.min_subtotal then
    return jsonb_build_object('valid', false, 'reason', 'min', 'min_subtotal', v_promo.min_subtotal);
  end if;

  return jsonb_build_object(
    'valid', true,
    'code', v_promo.code,
    'kind', v_promo.kind,
    'value', v_promo.value,
    'min_subtotal', v_promo.min_subtotal
  );
end;
$$;

-- Passe une commande. Tout est recalculé ici :
--   * prix et stocks lus dans la table products ;
--   * rabais du code promotionnel revalidé ;
--   * livraison : 9,99 $ sous 100 $ (après rabais), offerte sinon ; aucune pour
--     une commande composée uniquement de services ;
--   * taxes : TPS 5 % et TVQ 9,975 % sur (sous-total - rabais + livraison).
-- En cas d'erreur, RIEN n'est enregistré (transaction atomique).
create or replace function public.place_order(
  p_items    jsonb,
  p_promo    text,
  p_customer jsonb,
  p_payment  text
)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_user       uuid := auth.uid();
  v_order_id   uuid := gen_random_uuid();
  v_number     text;
  v_item       jsonb;
  v_prod       public.products%rowtype;
  v_promo      public.promo_codes%rowtype;
  v_qty        integer;
  v_subtotal   numeric(10, 2) := 0;
  v_discount   numeric(10, 2) := 0;
  v_shipping   numeric(10, 2) := 0;
  v_taxable    numeric(10, 2);
  v_tps        numeric(10, 2);
  v_tvq        numeric(10, 2);
  v_total      numeric(10, 2);
  v_physical   boolean := false;
  v_free_ship  boolean := false;
  v_promo_code text := null;
begin
  if v_user is null then
    raise exception 'Connexion requise pour commander.';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Le panier est vide.';
  end if;
  if jsonb_array_length(p_items) > 50 then
    raise exception 'Le panier contient trop d''articles.';
  end if;
  if p_payment is null or p_payment not in ('livraison', 'interac') then
    raise exception 'Mode de paiement invalide.';
  end if;

  v_number := 'MCS-' || to_char(now(), 'YYYYMMDD') || '-'
              || lpad(nextval('public.order_number_seq')::text, 4, '0');

  insert into public.orders (id, number, user_id, payment_method, customer)
  values (v_order_id, v_number, v_user, p_payment, coalesce(p_customer, '{}'::jsonb));

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_qty := (v_item ->> 'qty')::integer;
    if v_qty is null or v_qty < 1 or v_qty > 20 then
      raise exception 'Quantité invalide.';
    end if;

    -- « for update » verrouille la ligne : deux achats simultanés ne peuvent
    -- pas vendre le dernier exemplaire en double.
    select * into v_prod from public.products where id = (v_item ->> 'id') for update;
    if not found then
      raise exception 'Article introuvable.';
    end if;

    if v_prod.stock is not null then
      if v_prod.stock < v_qty then
        raise exception 'Stock insuffisant pour « % ».', v_prod.name;
      end if;
      update public.products set stock = stock - v_qty where id = v_prod.id;
    end if;

    if v_prod.kind = 'produit' then
      v_physical := true;
    end if;

    v_subtotal := v_subtotal + v_prod.price * v_qty;

    insert into public.order_items (order_id, product_id, name, unit_price, quantity)
    values (v_order_id, v_prod.id, v_prod.name, v_prod.price, v_qty);
  end loop;

  -- Code promotionnel (facultatif)
  if p_promo is not null and trim(p_promo) <> '' then
    select * into v_promo
    from public.promo_codes
    where upper(code) = upper(trim(p_promo))
      and active
      and (expires_at is null or expires_at > now());
    if not found then
      raise exception 'Code promotionnel invalide ou expiré.';
    end if;
    if v_subtotal < v_promo.min_subtotal then
      raise exception 'Ce code exige un achat minimum de % $.', v_promo.min_subtotal;
    end if;
    v_promo_code := v_promo.code;
    if v_promo.kind = 'percent' then
      v_discount := round(v_subtotal * v_promo.value / 100, 2);
    else
      v_free_ship := true;
    end if;
  end if;

  if v_physical and not v_free_ship and (v_subtotal - v_discount) < 100 then
    v_shipping := 9.99;
  end if;

  v_taxable := v_subtotal - v_discount + v_shipping;
  v_tps     := round(v_taxable * 0.05, 2);
  v_tvq     := round(v_taxable * 0.09975, 2);
  v_total   := v_taxable + v_tps + v_tvq;

  update public.orders
  set subtotal = v_subtotal, discount = v_discount, shipping = v_shipping,
      tps = v_tps, tvq = v_tvq, total = v_total, promo_code = v_promo_code
  where id = v_order_id;

  return jsonb_build_object(
    'id', v_order_id, 'number', v_number,
    'subtotal', v_subtotal, 'discount', v_discount, 'shipping', v_shipping,
    'tps', v_tps, 'tvq', v_tvq, 'total', v_total
  );
end;
$$;

revoke all on function public.validate_promo(text, numeric)          from public;
revoke all on function public.place_order(jsonb, text, jsonb, text)  from public, anon;
grant execute on function public.validate_promo(text, numeric)          to anon, authenticated;
grant execute on function public.place_order(jsonb, text, jsonb, text)  to authenticated;


-- -----------------------------------------------------------------------------
-- 3. SÉCURITÉ : ROW LEVEL SECURITY (RLS)
-- -----------------------------------------------------------------------------

alter table public.products          enable row level security;
alter table public.favorites         enable row level security;
alter table public.promo_codes       enable row level security;  -- aucune politique = accès refusé
alter table public.orders            enable row level security;
alter table public.order_items       enable row level security;
alter table public.contact_messages  enable row level security;

-- Catalogue : lecture par tous. Aucune écriture depuis le site.
drop policy if exists "products_select" on public.products;
create policy "products_select" on public.products
  for select to anon, authenticated using (true);

-- Favoris : chacun ne voit et ne gère que les siens
drop policy if exists "favorites_select" on public.favorites;
create policy "favorites_select" on public.favorites
  for select to authenticated using (user_id = auth.uid());

drop policy if exists "favorites_insert" on public.favorites;
create policy "favorites_insert" on public.favorites
  for insert to authenticated with check (user_id = auth.uid());

drop policy if exists "favorites_delete" on public.favorites;
create policy "favorites_delete" on public.favorites
  for delete to authenticated using (user_id = auth.uid());

-- Commandes : lecture des siennes seulement ; création uniquement via place_order()
drop policy if exists "orders_select" on public.orders;
create policy "orders_select" on public.orders
  for select to authenticated using (user_id = auth.uid());

drop policy if exists "order_items_select" on public.order_items;
create policy "order_items_select" on public.order_items
  for select to authenticated
  using (exists (select 1 from public.orders o where o.id = order_id and o.user_id = auth.uid()));

-- Contact : tout le monde peut écrire, personne ne peut lire depuis le site
-- (les messages se consultent dans Supabase > Table Editor).
drop policy if exists "contact_insert" on public.contact_messages;
create policy "contact_insert" on public.contact_messages
  for insert to anon, authenticated with check (true);


-- -----------------------------------------------------------------------------
-- 4. DONNÉES DE DÉPART
-- -----------------------------------------------------------------------------

insert into public.products
  (id, name, description, details, category, kind, price, stock, emoji, color, image, featured)
values
  ('laptop-probook', 'Portable ProBook 15"', 'Un portable 15,6 pouces rapide et silencieux, pensé pour le travail et les études.', array['Écran 15,6" Full HD antireflet', 'Processeur 8 cœurs, 16 Go de mémoire', 'SSD de 512 Go', 'Jusqu''à 10 heures d''autonomie'], 'ordinateurs', 'produit', 899.00, 8, '💻', '#d3e7e4', 'assets/produits/laptop-probook.svg', true),
  ('ecran-24', 'Écran 24" Full HD', 'Un écran net et confortable pour travailler longtemps sans fatigue visuelle.', array['Dalle IPS 24 pouces, 1920 × 1080', 'Bordures fines, pied inclinable', 'Entrées HDMI et DisplayPort'], 'ordinateurs', 'produit', 189.99, 14, '🖥️', '#d3e7e4', null, false),
  ('tablette-10', 'Tablette 10 pouces 64 Go', 'Légère et polyvalente : lecture, notes, visioconférence et divertissement.', array['Écran 10,4 pouces', '64 Go de stockage, extensible', 'Deux caméras, USB-C'], 'ordinateurs', 'produit', 329.00, 10, '📱', '#d3e7e4', null, false),
  ('souris-ergo', 'Souris sans fil ergonomique', 'Une prise en main naturelle pour réduire la fatigue du poignet.', array['Connexion sans fil 2,4 GHz', 'Capteur réglable jusqu''à 3200 ppp', 'Pile incluse'], 'accessoires', 'produit', 34.99, 40, '🖱️', '#f5e7c2', null, false),
  ('clavier-meca', 'Clavier mécanique compact', 'Frappe précise et agréable dans un format compact qui libère de l''espace.', array['Format 75 %', 'Interrupteurs mécaniques silencieux', 'Filaire USB-C'], 'accessoires', 'produit', 79.99, 25, '⌨️', '#f5e7c2', null, false),
  ('casque-bt', 'Casque audio Bluetooth', 'Un son clair pour la musique, les cours en ligne et les appels.', array['Bluetooth 5, micro intégré', 'Jusqu''à 30 heures d''autonomie', 'Coussinets souples'], 'accessoires', 'produit', 119.00, 18, '🎧', '#f5e7c2', 'assets/produits/casque-bt.svg', true),
  ('ssd-1to', 'Disque SSD externe 1 To', 'Sauvegardez et transportez vos fichiers dans un boîtier compact et robuste.', array['Capacité de 1 To', 'Connexion USB-C', 'Résiste aux chocs du quotidien'], 'accessoires', 'produit', 109.99, 30, '💾', '#f5e7c2', null, false),
  ('chargeur-65w', 'Chargeur rapide USB-C 65 W', 'Un seul chargeur pour votre portable, votre tablette et votre téléphone.', array['Puissance de 65 W', 'Deux ports : USB-C et USB-A', 'Format de voyage'], 'accessoires', 'produit', 44.50, 50, '🔌', '#f5e7c2', null, false),
  ('webcam-hd', 'Webcam HD 1080p', 'Une image nette pour vos réunions et vos cours à distance.', array['Full HD 1080p', 'Microphone intégré', 'Volet de confidentialité'], 'accessoires', 'produit', 59.99, 22, '📷', '#f5e7c2', null, false),
  ('sac-portable', 'Sac à dos pour portable', 'Compartiment rembourré pour portable jusqu''à 16 pouces et rangements pour vos accessoires.', array['Portable jusqu''à 16 pouces', 'Tissu résistant à l''eau', 'Poche antivol dorsale'], 'accessoires', 'produit', 64.00, 4, '🎒', '#f5e7c2', null, false),
  ('srv-installation', 'Installation et configuration d''ordinateur', 'Nous préparons votre ordinateur : système, mises à jour, logiciels et transfert de vos fichiers.', array['Intervention environ 1 h 30', 'Installation des logiciels courants', 'Transfert de vos fichiers', 'Sur rendez-vous'], 'services', 'service', 89.00, null, '🛠️', '#e3def3', 'assets/produits/srv-installation.svg', true),
  ('srv-depannage', 'Dépannage informatique à distance (1 heure)', 'Un problème logiciel, un virus, une lenteur ? Nous intervenons à distance, en direct avec vous.', array['Séance de 1 heure', 'Diagnostic et correction', 'Aucun déplacement'], 'services', 'service', 60.00, null, '🧑‍💻', '#e3def3', null, false),
  ('srv-site-vitrine', 'Création de site vitrine', 'Un site clair et adapté aux téléphones pour présenter votre activité et vous faire contacter.', array['Jusqu''à 5 pages', 'Adapté aux téléphones', 'Formulaire de contact', 'Mise en ligne incluse'], 'services', 'service', 750.00, null, '🌐', '#e3def3', 'assets/produits/srv-site-vitrine.svg', true),
  ('srv-formation', 'Formation bureautique (2 heures)', 'Une séance pratique pour maîtriser vos outils de bureautique, seul ou en petit groupe.', array['Séance de 2 heures', 'Contenu adapté à votre niveau', 'Sur place ou en visioconférence'], 'services', 'service', 120.00, null, '🎓', '#e3def3', null, false)
on conflict (id) do nothing;

insert into public.promo_codes (code, kind, value, min_subtotal, active)
values
  ('BIENVENUE10', 'percent', 10, 0, true),
  ('MAGAS15', 'percent', 15, 100, true),
  ('LIVRAISON', 'free_shipping', 0, 0, true)
on conflict (code) do nothing;

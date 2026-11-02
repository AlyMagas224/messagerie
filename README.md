# messagerie
# Babil — Messagerie instantanée Web

> Projet Fil-Rouge — **8WEB101 Conception et programmation de sites Web** — UQAC  
> Équipe : **Aly Magassouba** · **Mamadou Saliou Conde**

🔗 **Site en ligne :** https://alymagas224.github.io/messagerie/

Babil est une messagerie instantanée Web qui permet d'échanger des messages texte et des images
en temps réel, en conversation privée ou dans des salons de groupe. Le site est réalisé en HTML,
CSS et JavaScript, hébergé sur **GitHub Pages**, et ses données (comptes, salons, messages) sont
enregistrées dans **Supabase**.

## Fonctionnalités

### Fonctionnalités principales

| Fonctionnalité | Réalisation |
|---|---|
| Inscription / connexion | Courriel et mot de passe, pseudo unique, couleur d'avatar |
| Liste de contacts | Ajout par pseudo, suppression, statut en ligne |
| Liste des salons | Conversations privées et salons de groupe, triés par activité, avec compteur de non-lus |
| Messages en temps réel | Réception instantanée, sans rechargement de la page |
| Affichage horodaté | Heure de chaque message, séparateurs « Aujourd'hui / Hier / date » |

### Fonctionnalités secondaires

| Fonctionnalité | Réalisation |
|---|---|
| Notification | Son, notification du navigateur et compteur de non-lus dans l'onglet |
| Partage d'images | Bouton 📎, copier-coller ou glisser-déposer (PNG, JPEG, GIF, WEBP, 5 Mo max) |
| « en ligne / hors ligne » | Pastille verte, ou « vu à … » |
| « en train d'écrire… » | Affiché en direct sous la conversation |
| « envoyé / reçu / lu » | ✓ envoyé · ✓✓ reçu · ✓✓ coloré lu |

### ⭐ Fonctionnalité supplémentaire : réactions emoji

Chaque message peut recevoir des réactions (👍 ❤️ 😂 😮 😢 🎉). Les réactions s'affichent sous le
message avec leur nombre ; le survol d'une réaction indique qui a réagi, et un nouveau clic sur sa
propre réaction la retire. Elles sont enregistrées dans Supabase et synchronisées en temps réel
chez tous les membres de la conversation.

## Technologies

| Couche | Outil |
|---|---|
| Structure | HTML5 |
| Style | CSS3 (variables, Grid, Flexbox, media queries), thème clair et sombre |
| Interactivité | JavaScript (modules ES), sans framework |
| Données | Supabase : base PostgreSQL, authentification, temps réel, stockage d'images |
| Hébergement | GitHub Pages |

## Arborescence

```
.
├── index.html            Accueil
├── inscription.html      Inscription
├── connexion.html        Connexion
├── chat.html             Messagerie
├── profil.html           Profil de l'utilisateur
├── aide.html             Aide et FAQ
├── 404.html              Page introuvable
├── assets/               Logo et illustration
├── css/                  Styles (base, pages, formulaires, messagerie)
├── js/
│   ├── config.js         Paramètres de connexion à Supabase
│   ├── services/         Connexion aux données
│   ├── utils/            Fonctions utilitaires
│   ├── pages/            Scripts des pages publiques
│   └── chat/             Modules de la messagerie (messages, salons, contacts, réactions…)
├── supabase/
│   └── schema.sql        Tables, sécurité et fonctions de la base de données
└── docs/
    └── conception.md     Arborescence, maquettes et modèle de données
```

## Sécurité

- Chaque utilisateur ne peut lire que les salons, messages et réactions des conversations dont il est membre (Row Level Security de Supabase).
- L'auteur et la date d'un message sont fixés par le serveur et ne peuvent pas être falsifiés.
- Les messages sont affichés comme du texte brut, ce qui protège contre les injections de code (XSS).

## Déroulement du projet

| Séance | Travail |
|---|---|
| 2 | Conception : arborescence, maquettes (`docs/conception.md`) |
| 3 | Structure HTML et publication sur GitHub Pages |
| 4 | Style CSS |
| 5 | Interactivité JavaScript : envoyer et afficher des messages |
| 6 | Enregistrement des données avec Supabase |
| 7 | Optimisation et adaptation au téléphone |
| 8 | Finalisation, tests et documentation |


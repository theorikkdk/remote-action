# Remote Action

Remote Action est un module Foundry VTT pour le systeme `dnd5e`.

Il permet a des utilisateurs autorises de declencher des actions depuis un client joueur, puis de les relayer vers un client recepteur principal, typiquement un ecran central ou une TV de table. Le module vise les usages DnD5e avec `socketlib` et conserve des chemins compatibles avec Midi-QOL lorsque disponible.

## Prerequis

- Foundry VTT v12 ou v13
- Systeme `dnd5e`
- Module `socketlib`
- Midi-QOL recommande pour les workflows automatises de degats / effets

## Fonctionnalites principales

- Configuration d'un recepteur principal.
- Configuration des emetteurs autorises.
- Relais d'usage d'items / activities DnD5e vers le recepteur.
- Support des workflows Foundry / dnd5e / Midi-QOL existants.
- Mode debug et logs de diagnostic.
- Interface de configuration utilisateur dediee.

## Reglages

Les reglages principaux du module sont disponibles dans les parametres Foundry :

- `Mode debug`
- `Notifications cote emetteur`
- `Intercepter l'usage depuis la fiche acteur`
- `Utiliser les jets d'attaque Foundry`
- `Utiliser les jets de degats Foundry`
- `Utiliser les jets de sauvegarde Foundry`
- sous-menu `Configuration des utilisateurs`

Le sous-menu utilisateurs permet de choisir :

- le recepteur principal
- les emetteurs autorises

## Mode recommande

Le mode principal recommande pour la table est :

- `Utiliser les jets d'attaque Foundry` = desactive
- `Utiliser les jets de degats Foundry` = active
- `Utiliser les jets de sauvegarde Foundry` = active

Dans ce mode, le jet d'attaque peut etre gere hors Foundry, tandis que le module conserve un workflow de degats exploitable par Foundry / dnd5e / Midi-QOL.

## Installation manuelle

1. Installer `socketlib`.
2. Copier le dossier du module dans `Data/modules/remote-action`.
3. Activer Remote Action dans une partie utilisant `dnd5e`.
4. Configurer le recepteur principal et les emetteurs autorises.

## Publication GitHub

Pour une release Foundry, joindre au tag GitHub :

- `module.json`
- `remote-action.zip`

Le zip doit contenir le dossier complet du module, avec `module.json` a la racine du zip.

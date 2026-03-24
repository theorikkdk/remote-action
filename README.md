# Remote Action

Remote Action est un module Foundry VTT pour le systeme `dnd5e`.

Ce depot contient uniquement le squelette MVP du module :

- structure de fichiers propre et simple
- chargement du module et cycle de vie Foundry
- settings de base
- integration preparatoire avec `socketlib`
- hooks UI minimaux
- helpers de debug
- localisation FR/EN minimale

La logique metier n'est pas encore implementee.

## Objectif du module

A terme, le module servira de couche de relais entre des utilisateurs autorises (emetteurs) et un utilisateur recepteur principal, afin d'executer certaines actions a distance dans une partie DnD5e.

Dans cette premiere version :

- aucune action DnD5e n'est interceptee
- aucune logique de relais avancee n'est activee
- aucun flux metier definitif n'est encore branche

## Prerequis

- Foundry VTT
- systeme `dnd5e`
- module `socketlib`

## Structure

```text
module.json
README.md
scripts/
  main.js
  settings.js
  socket.js
  relay.js
  execute.js
  ui-hooks.js
  debug.js
languages/
  fr.json
  en.json
```

## Architecture

### `scripts/main.js`

Point d'entree du module. Initialise l'etat partage, enregistre les settings, les hooks UI et le socket.

### `scripts/settings.js`

Declare les settings du module :

- utilisateur recepteur principal
- utilisateurs emetteurs autorises
- mode debug

### `scripts/socket.js`

Prepare l'enregistrement `socketlib` et l'exposition des handlers reseau du module.

### `scripts/relay.js`

Contient la future couche de relais. Pour l'instant, les validations et les appels sont stubs et documentes.

### `scripts/execute.js`

Contient la future couche d'execution cote recepteur. Pour l'instant, aucun traitement DnD5e n'est implemente.

### `scripts/ui-hooks.js`

Centralise les hooks d'interface minimaux utiles au MVP.

### `scripts/debug.js`

Expose les helpers de log et de lecture de configuration.

## Settings prevus

### Recepteur principal

Setting monde stockant l'ID de l'utilisateur qui recevra les actions a distance.

### Emetteurs autorises

Setting monde stockant une liste d'IDs utilisateurs. Pour ce MVP, la valeur est stockee sous forme de texte separe par des virgules afin d'eviter de figer trop tot une interface complexe.

### Debug

Setting client permettant d'activer des logs supplementaires.

## Installation

1. Installer `socketlib` dans Foundry.
2. Copier ce module dans le dossier `Data/modules/remote-action`.
3. Activer le module dans une partie utilisant `dnd5e`.

Note : le dossier du module doit s'appeler exactement `remote-action` et le manifest attendu doit se trouver a `D:\FoundryVTT\Data\modules\remote-action\module.json`.

## Compatibilite

L'action `open-actor-sheet` fonctionne dans le MVP.

Attention : certains modules d'affichage, comme Monk's Common Display, peuvent empecher l'ouverture visible des fiches si leur masquage d'interface est actif.

Dans nos tests, l'usage de Lock View pour masquer l'UI, avec Monk's Common Display actif mais sans masquage d'interface par Monk's, fonctionne correctement.

## Suite recommandee

Les prochaines etapes naturelles seront :

1. definir le format des messages de relais
2. ajouter les controles d'autorisation
3. brancher les premiers points d'entree DnD5e
4. creer une UI de configuration plus confortable pour les emetteurs autorises

## Etat

Pret a servir de base de developpement, mais volontairement limite au squelette initial.
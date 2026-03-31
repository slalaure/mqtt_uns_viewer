# 🗺️ ROADMAP: Transformation I3X & Semantic Fabric

**Version :** 1.0
**Objectif :** Transformer le viewer MQTT "Topic-Centric" en une plateforme "Data-Centric" compatible i3X, capable de gérer des objets sémantiques tout en conservant la flexibilité des topics bruts.

---

## 📅 Phase 1 : Cœur Sémantique (Backend)
**Objectif :** Rendre le backend capable de comprendre les concepts d'Objets, de Types et de Relations.

### Tâche 1.1 : Refonte du Modèle de Données (`uns_model.json`)
* **Fichier :** `data/uns_model.json`
* **Action :** Restructurer le fichier pour supporter la spec i3X.
    * Ajouter les sections racines : `namespaces`, `objectTypes`, `relationshipTypes`, `instances`.
    * Définir les propriétés clés : `elementId`, `typeId`, `isComposition`, `attributes` (mapping vers topics).
    * *Note :* Conserver la compatibilité avec les outils actuels via une migration ou un adaptateur temporaire.

### Tâche 1.2 : Service `SemanticManager`
* **Nouveau Fichier :** `database/semanticManager.js`
* **Responsabilité :** Moteur d'indexation en mémoire.
* **Fonctions clés :**
    * `loadModel()` : Charge le JSON et construit un graphe directionnel (Parent -> Enfant).
    * `resolveTopic(topic)` : Retourne l'objet (Instance + Type) associé à un topic MQTT.
    * `resolveElement(elementId)` : Retourne la liste des topics MQTT (métriques) associés à un objet i3X.

### Tâche 1.3 : Indexation "Au Vol"
* **Fichier :** `mqtt-handler.js`
* **Action :**
    * À chaque message entrant, interroger le `SemanticManager`.
    * Si le topic correspond à une définition du modèle, enrichir l'objet message interne avec `elementId` et `typeId` avant stockage dans DuckDB (pour optimiser les requêtes futures).

---

## 📅 Phase 2 : API Standardisée i3X (Backend)
**Objectif :** Exposer les données selon le contrat OpenAPI i3X (Lecture seule pour l'instant).

### Tâche 2.1 : Routeur I3X
* **Nouveau Fichier :** `routes/i3xApi.js`
* **Action :** Créer les endpoints d'exploration.
    * `GET /namespaces`
    * `GET /objecttypes` & `POST /objecttypes/query`
    * `GET /relationshiptypes`

### Tâche 2.2 : Exploration des Instances
* **Fichier :** `routes/i3xApi.js`
* **Action :**
    * `GET /objects` : Retourne les instances définies dans le `SemanticManager`.
    * `POST /objects/related` : Navigue dans le graphe (Parents/Enfants/Siblings).

### Tâche 2.3 : Données & Format VQT
* **Fichier :** `routes/i3xApi.js` (utilisant `database/dataManager.js`)
* **Action :**
    * Implémenter `POST /objects/value` (Dernière valeur) et `POST /objects/history`.
    * **Transformation VQT :** Formater les sorties DuckDB pour inclure `{ value: ..., quality: "Good", timestamp: ... }`.
    * Gérer la récursion (`maxDepth`) pour les objets complexes (`isComposition: true`).

---

## 📅 Phase 3 : Streaming & Temps Réel (Backend)
**Objectif :** Supporter le streaming standardisé pour les clients tiers tout en gardant les WebSockets pour l'UI.

### Tâche 3.1 : Bus d'Événements (Event Bus)
* **Fichiers :** `mqtt-handler.js`, `server.js`
* **Action :**
    * Instancier un `NodeJS.EventEmitter` global.
    * Le `mqtt-handler` émet `events.emit('data', { topic, payload... })`.
    * Le `websocket-manager` écoute cet événement au lieu d'être appelé directement.

### Tâche 3.2 : Adaptateur SSE (Server-Sent Events)
* **Fichier :** `routes/i3xApi.js`
* **Action :**
    * Implémenter `POST /subscriptions` (Création contexte).
    * Implémenter `GET /subscriptions/{id}/stream` (Flux SSE).
    * Le flux SSE s'abonne à l'`EventEmitter` global et filtre selon les `elementIds` souscrits.

---

## 📅 Phase 4 : Interface de Modélisation (Frontend)
**Objectif :** Créer et éditer le modèle sémantique graphiquement.

### Tâche 4.1 : Vue Modeler
* **Fichiers :** `public/html/view.modeler.html`, `public/view.modeler.js`
* **UI :**
    * Liste des Types (Classes) à gauche.
    * Zone d'édition (Propriétés, Relations) à droite.
    * **Assistant de Mapping :** Permettre de sélectionner un topic "réel" depuis l'arbre MQTT pour le lier à une propriété d'un Type.

### Tâche 4.2 : Visualisation de Graphe
* **Action :** Intégrer une librairie de visualisation (ex: Vis.js ou SVG D3) pour afficher les relations entre les types (`IsParentOf`, `HasComponent`).

---

## 📅 Phase 5 : Vue Objet (Frontend - Tree)
**Objectif :** Offrir la vision métier dans l'arbre de gauche.

### Tâche 5.1 : Switch "MQTT / Objects"
* **Fichier :** `public/view.tree.js`
* **UI :** Ajouter un toggle switch dans le header de l'arbre.
* **Logique :**
    * *Mode MQTT :* Comportement actuel (basé sur les slashes `/`).
    * *Mode Objet :* Interroge l'API `/api/i3x/objects` et construit l'arbre selon `parentId`.

### Tâche 5.2 : Drag & Drop Sémantique
* **Fichier :** `public/tree-manager.js`
* **Action :** Enrichir l'événement `dragstart`.
    * Le payload du Drag doit contenir le type de source :
        * `{ type: 'topic', path: 'dt/usine/pompe1' }` (Mode MQTT)
        * `{ type: 'element', id: 'pump-101', typeId: 'PumpType' }` (Mode Objet)

---

## 📅 Phase 6 : Intégration Profonde (Outils Polymorphiques)
**Objectif :** Rendre les outils (Chart, SVG, Mapper) agnostiques de la source (Topic ou Objet).

### Tâche 6.1 : Chart Polymorphique (Smart Axis V2)
* **Fichier :** `public/view.chart.js`
* **Action :**
    * Dans `onDrop` : Détecter si `type === 'element'`.
    * Si Élément : Appeler `/api/i3x/objects/value` pour récupérer la structure.
    * Auto-population : Ajouter automatiquement toutes les propriétés numériques de l'objet (Vitesse, Température) dans le graphique.
    * Utiliser les métadonnées i3X (`EngUnit`) pour configurer les axes Y sans "devinettes".

### Tâche 6.2 : SVG Binding Abstrait
* **Fichier :** `public/view.svg.js`
* **Action :**
    * Mettre à jour `registerSvgBindings` pour accepter des ID d'objets.
    * Dans `updateMap` : Si le binding est sur un Objet, utiliser le `SemanticManager` (côté client ou via API) pour router les messages MQTT reçus vers les éléments SVG correspondants.

### Tâche 6.3 : Mapper Sémantique
* **Fichier :** `public/view.mapper.js` et `mapper_engine.js`
* **Action :**
    * *Source :* Permettre de choisir un Objet i3X comme source. Le moteur s'abonne "sous le capot" à tous les topics composants cet objet.
    * *Target :* Permettre d'écrire vers une propriété d'un Objet i3X (le moteur résout le topic de destination via le modèle).

---

## ✅ Critères de Succès

1.  **Dualité :** L'application fonctionne toujours parfaitement sans modèle i3X (mode "Raw MQTT").
2.  **Interopérabilité :** Un client i3X tiers (ex: script Python) peut découvrir la hiérarchie et lire les données.
3.  **Expérience Utilisateur :** Un utilisateur peut glisser une "Machine" (Objet) dans le Chart et voir instantanément ses courbes de température et vibration, sans connaître les topics MQTT.
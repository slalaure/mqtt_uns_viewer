# Plan de Test Global - Korelate (v1.6.0-beta1)

Ce document décrit la stratégie et les scénarios de test pour garantir la stabilité, la performance et la sécurité de Korelate.

## 🛠 Stratégie de Test
- **Tests Unitaires / Intégration (Backend & Logique pure)** : Exécutés via `Jest` (`npx jest`). Ils valident les moteurs internes sans dépendance au DOM.
- **Tests Bout-en-Bout (E2E / Parcours Utilisateurs)** : Exécutés via `Playwright` (`npx playwright test`). Ils simulent un utilisateur réel dans le navigateur (Chromium, WebKit, Firefox).
- **Tests de Résilience (Chaos Testing)** : Valident le comportement du système sous contrainte extrême (Data Storms, coupures réseau).

---

## 1. Tests Unitaires & Intégration (Backend)

### 1.1. Core Engines (Moteurs Principaux)
* **Metrics & Observability (`metricsManager.test.js` & `errorUtils.test.js`)**
    * *Counters* : Vérifier l'incrémentation correcte des compteurs de messages et d'erreurs (par code).
    * *Format* : S'assurer que la sortie Prometheus est valide et contient les jauges (`DLQ Size`, `WS Connections`).
    * *Log Format* : Vérifier que `logError` structure correctement les métadonnées (`code`, `traceId`, `stack`).
* **Message Dispatcher (`messageDispatcher.test.js`)**
    * *Anti-Spam* : Vérifier qu'un namespace dépassant 50 msgs/sec est throttle.
    * *Payload Limits* : Vérifier qu'un payload > 2MB est tronqué et remplacé par un message d'erreur pour éviter l'OOM.
    * *Worker Pool* : Vérifier que le parsing JSON lourd et le décodage Sparkplug B sont bien déchargés aux threads.
* **Alert Manager (`alertManager.test.js`)**
    * *Sandbox Isolation* : Vérifier que le code JS utilisateur (`condition_code`) ne peut pas accéder au système (`require('fs')` doit échouer).
    * *Évaluation* : Vérifier qu'une condition vraie insère une nouvelle alerte en base et déclenche un WebHook.
* **Mapper Engine (`mapperEngine.test.js`)**
    * *Transformation* : Vérifier qu'un payload en entrée est correctement manipulé et ré-émis sur le topic cible.
    * *Split* : Vérifier que retourner un tableau d'objets publie bien plusieurs messages distincts.
* **LLM Engine (`llmEngine.test.js`)**
    * *Tool Execution Loop* : Simuler une réponse de l'IA demandant un appel d'outil, vérifier que l'outil s'exécute et que le résultat est renvoyé à l'IA pour synthèse.
    * *Prompt Injection* : Vérifier que le contexte du broker est correctement formatté.

### 1.2. Storage & Repositories
* **DuckDB & DLQ (`chaos.test.js` & `dbManager`)**
    * *Auto-Prune* : Dépasser la taille max (`DUCKDB_MAX_SIZE_MB`), vérifier que les chunks les plus anciens sont supprimés.
    * *DLQ Spill* : Envoyer > 20,000 messages sans accès DB, vérifier que 5,000 messages basculent dans la Dead Letter Queue.
* **Perennial Repositories (`*Repository.test.js`)**
    * *TimescaleDB* : Vérifier le batching SQL par 1000 lignes.
    * *DynamoDB* : Vérifier le découpage par batchs de 25 items (limite AWS) et le routing des `UnprocessedItems` vers la DLQ.
    * *Azure Table* : Vérifier le groupement par `PartitionKey` et la limite de 100 items par transaction.

### 1.3. Protocol Connectors
* **MQTT Provider (`mqttProvider.test.js`)**
    * *Connexion* : Tester la connexion avec et sans MTLS (certificats).
    * *MQTT v5* : Vérifier l'extraction du `correlationId` depuis les `userProperties`.
* **OPC UA Provider (`opcuaProvider.test.js`)**
    * *Subscriptions* : Vérifier la conversion des variations d'un `NodeId` en format JSON UNS `value/quality/timestamp`.
    * *Backoff* : Vérifier les tentatives de reconnexion exponentielles si le serveur OPC UA tombe.
* **File Provider (`fileProvider.test.js`)**
    * *CSV Parsing* : Vérifier le routage dynamique via la colonne `topic` d'un CSV.
* **I3X Provider (`i3xProvider.test.js`)**
    * *Subscription* : Vérifier la connexion à un serveur I3X distant, la création d'une souscription et la réception de données via le flux SSE.
    * *Write* : Vérifier l'écriture de données vers un serveur distant via `PUT /value`.
* **Industrial Providers (Modbus, S7, EIP, BACnet, KNX, SNMP)**
    * *Polling* (Modbus/S7/EIP/BACnet/SNMP) : Vérifier que le cycle de lecture périodique injecte bien les données dans le dispatcher.
    * *Events* (KNX) : Vérifier la réaction immédiate aux télégrammes de groupe sans polling.
    * *Mapping Syntax* : Valider le parsing des syntaxes complexes (`Addr:Len::Topic`).
    * *Missing Libs* : Vérifier que l'absence d'une lib optionnelle ne bloque pas le démarrage du serveur.
* **IT/Data Connectors (SQL, REST, Kafka)**
    * *SQL Poller* : Vérifier la gestion du curseur (statefulness) pour éviter de renvoyer les mêmes lignes.
    * *REST Poller* : Vérifier les différentes méthodes d'authentification (Basic, Bearer, API Key).
    * *Kafka* : Vérifier la conversion correcte des buffer Kafka en JSON ainsi que l'injection des headers (offset, partition).

### 1.4. I3X & Semantic Manager (`semanticManager.test.js`)
* *Indexation* : Vérifier que les relations (ex: `SuppliesTo`) sont bien indexées en mémoire (aller et retour).
* *Résolution* : Associer un topic brut MQTT à son `elementId` I3X.

---

## 2. Tests Unitaires Frontend (Vanilla JS)

* **State Manager (`state.js`)**
    * Vérifier que modifier `state.activeView` déclenche bien les callbacks abonnés (`subscribe()`).
* **Chart Logic (`chartLogic.test.mjs`)**
    * *Downsampling* : Tester l'algorithme LTTB pour réduire 10 000 points à 500 sans perdre les pics/creux.
    * *Smart Axis* : Vérifier que `ambient_temperature` et `motor_temperature` sont groupés sur le même axe Y.
* **Utils (`utils.test.js`)**
    * *Regex* : Convertir `factory/+/temp/#` en Regex standard valide pour le client.

---

## 3. Parcours Utilisateurs (Tests E2E - Playwright)

### 3.1. Authentification & RBAC (`login.spec.js`)
* **Scenario A : Redirection non-authentifié** : Tenter d'accéder à `/tree`, vérifier la redirection vers `/login`.
* **Scenario B : Login Admin** : Se connecter avec les identifiants `.env`, vérifier l'apparition de l'onglet `Admin` et `CDM Modeler`.
* **Scenario C : Login User** : Se connecter avec un compte standard, vérifier l'absence des onglets Admin et l'impossibilité de cliquer sur "Save Live" dans le Mapper.

### 3.2. Navigation & Interface (`navigation.spec.js`)
* **Scenario A : Dark Mode** : Cliquer sur le toggle de thème, vérifier les variables CSS et la sauvegarde dans le `localStorage`.
* **Scenario B : Resizing** : Déplacer la barre de séparation (`.resizer`), vérifier que les panneaux s'ajustent correctement.

### 3.3. Temps Réel & Arborescence (Tree View)
* **Scenario A : Ingestion MQTT** : Publier un message. Vérifier l'apparition immédiate (et l'animation "pulse") du noeud dans l'arborescence.
* **Scenario B : Mode I3X** : Cliquer sur le noeud "I3X Semantic Graph", vérifier la navigation dans le modèle au lieu des topics MQTT physiques.

### 3.4. Création de Graphiques (`chart.spec.js`)
* **Scenario A : Plot Variables** : Sélectionner un topic, cocher deux variables (ex: `temp` et `pressure`). Vérifier l'affichage du Canvas Chart.js.
* **Scenario B : Time Travel** : Utiliser le slider temporel. Vérifier que la requête backend `time_bucket` met à jour le graphe avec l'historique.
* **Scenario C : Save Chart** : Enregistrer le graphique ("Save As"). Vérifier son apparition dans le menu déroulant.

### 3.5. ETL & Mapper (`mapper.spec.js`)
* **Scenario A : Création de Règle** : Sélectionner `factory/raw`, créer une target `uns/factory/clean`. Ajouter un script JS.
* **Scenario B : Validation** : Si la target est `spBv1.0/`, vérifier que l'UI affiche une erreur si l'input n'est pas du Sparkplug.
* **Scenario C : Live Deploy** : Sauvegarder la règle, injecter un message, et vérifier dans le Payload Viewer cible que la donnée a bien été transformée.

### 3.6. Tableaux de Bord & HMI (`hmi.spec.js`)
* **Scenario A : Upload d'Asset** : En tant qu'admin, uploader un fichier `.svg` via le panel Admin.
* **Scenario B : Visualisation** : Aller dans l'onglet HMI, sélectionner le fichier, vérifier l'exécution des `window.registerSvgBindings`.

### 3.7. Assistant IA (Chat & Modèles)
* **Scenario A : Recherche Sémantique** : Demander à l'IA "Quels sont les topics liés aux pompes ?". Vérifier l'utilisation du Tool `search_uns_concept`.
* **Scenario B : Actions Sensibles (Approbation)** : Demander à l'IA "Supprime l'historique du topic X". Vérifier l'apparition du bloc d'approbation (Dry-Run) bloquant l'action tant que l'utilisateur n'a pas cliqué sur "Approve".
* **Scenario C : Vision/Upload** : Uploader une image de capteur et demander "Quel est ce modèle ?".

### 3.8. Gestion des Alertes & Webhooks
* **Scenario A : Règle d'Alerte** : Créer une règle "Temp > 100".
* **Scenario B : Déclenchement** : Injecter une température de 110. Vérifier l'apparition de l'alerte en rouge dans l'UI.
* **Scenario C : Webhook** : Vérifier que le Webhook configuré a bien reçu le POST HTTP.
* **Scenario D : Workflow IA** : Vérifier que la colonne "AI Analysis" se remplit avec l'investigation automatique de l'agent LLM.

### 3.9. Administration & Maintenance
* **Scenario A : DLQ Replay** : Aller dans Admin -> DB. Simuler des erreurs en base, voir le compteur DLQ monter, cliquer sur "Replay", vérifier que les messages sont réintégrés.
* **Scenario B : System Logs** : Vérifier la lecture asynchrone des 500 dernières lignes du fichier `korelate.log`.

### 3.10. CDM Modeler & Semantic Metadata
* **Scenario A : Gestion des Propriétés** : Créer un nouvel objet, ajouter une propriété avec Label, Type et Unité.
* **Scenario B : Métadonnées de Sécurité** : Définir des niveaux de Confidentialité (ex: "Restricted") et de Sensibilité (ex: "Highly Sensitive"). Vérifier la persistance après sauvegarde.
* **Scenario C : Contraintes de Clé (PK/FK)** : Définir une propriété comme Primary Key. Définir une autre comme Foreign Key et sélectionner un objet cible dans le menu "Link to". Vérifier la visibilité conditionnelle du sélecteur FK.

### 3.11. AI Learning Studio (Chart Profiling)
* **Scenario A : Data Profiling** : Select a time range on the chart, click "Profile & Learn". Verify that the backend calculates Min, Max, Mean, StdDev, Frequency, and Chatter correctly.
* **Scenario B : AI Synthesis** : Confirm the analysis. Verify that the AI returns a structured JSON with `schema_updates` and `alert_rules`.
* **Scenario C : Suggestion Display** : Verify that the suggestions are displayed in a formatted modal with clear sections for model updates and alert rules.
* **Scenario D : Robustness** : Attempt profiling with no data in range. Verify that the UI handles the "No data found" or empty results gracefully.

---

## 4. Tests de Résilience (Chaos & Load Testing)

* **Test 1 : WebSocket Backpressure** : Injecter 10 000 msgs/seconde. Vérifier que la mémoire du navigateur ne crashe pas et que l'indicateur "⚠️ Sampling Active" s'affiche côté Frontend.
* **Test 2 : Coupure de Base de Données (Perennial)** : Configurer un Postgres (`TimescaleDB`). Couper le réseau vers Postgres. Constater que l'application ne crashe pas, que la mémoire tamponne, puis se vide dans la DLQ (fichiers `.jsonl`). Rétablir le réseau, vérifier que la routine de *Retry* en tâche de fond restaure les données.
* **Test 3 : Fuites Mémoire (Memory Leaks)** : Basculer 50 fois entre tous les onglets (Vue Chart, Mapper, HMI). Effectuer un snapshot de mémoire (Heap Dump) dans Chrome DevTools. Vérifier que les instances `Chart.js`, `Ace Editor` et les `Intervals` sont bien détruits par les fonctions `unmount()`.
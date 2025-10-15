# [MODIFICATION] Utilise une image Node.js v20 basée sur Debian (Bookworm)
FROM node:20-bookworm-slim

# Définit le répertoire de travail dans le conteneur
WORKDIR /usr/src/app

# Installe les outils de compilation pour Debian (au cas où)
RUN apt-get update && apt-get install -y python3 g++ make --no-install-recommends && rm -rf /var/lib/apt/lists/*

# Copie les fichiers de dépendances et les installe
COPY package*.json ./
RUN npm install

# Copie le reste du code de l'application
COPY . .

# Crée un répertoire pour les données persistantes de l'utilisateur
RUN mkdir -p /usr/src/app/data/certs

# Expose le port sur lequel l'application s'exécute
EXPOSE 8080

# La commande pour démarrer l'application
CMD [ "node", "server.js" ]
# Use a Node.js v20 image based on Debian (Bookworm)
FROM node:20-bookworm-slim

# Set the working directory inside the container
WORKDIR /usr/src/app

# Install build tools for Debian (just in case)
RUN apt-get update && apt-get install -y python3 g++ make --no-install-recommends && rm -rf /var/lib/apt/lists/*

# Copy dependency files and install them
COPY package*.json ./
RUN npm install

# Explicitly copy the .env.example file from the project root
COPY .env.example .

# Copy the rest of the application code
COPY . .

# Create a directory for persistent user data
RUN mkdir -p /usr/src/app/data/certs

# Expose the port on which the application runs
EXPOSE 8080

# The command to start the application
CMD [ "node", "server.js" ]
#!/bin/bash
echo "Starting ALL simulation profiles..."
COMPOSE_PROFILES=all docker compose -f docker-compose.yml.local up -d

echo "Waiting for all containers to initialize (20s)..."
sleep 20

echo "Running full protocol integration test..."
node tests/integration_protocols.js
EXIT_CODE=$?

echo "Tearing down containers..."
COMPOSE_PROFILES=all docker compose -f docker-compose.yml.local down --remove-orphans

if [ $EXIT_CODE -eq 0 ]; then
    echo "✅ Integration successful."
else
    echo "❌ Integration failed."
fi
exit $EXIT_CODE

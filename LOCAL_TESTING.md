# Local Testing with Embedded MQTT & OPC UA Servers

This guide explains how to use the embedded MQTT and OPC UA servers for local development and testing without waiting for external brokers to connect.

## Quick Start

### Option 1: Using the Preconfigured Compose File (Recommended)

The easiest way to start everything with local test servers:

```bash
docker-compose -f docker-compose.yml.local up
```

This will start:
- **Web UI**: http://localhost:8080
- **MQTT Broker**: `mqtt://localhost:1883` (or `mqtt://mqtt:1883` from Docker)
- **OPC UA Server**: `opc.tcp://localhost:4840` (or `opc.tcp://opcua:4840` from Docker)
- **Admin Account**: 
  - Username: `admin`
  - Password: `password`

The application is **pre-configured** to connect to these local brokers automatically.

> ⚠️ `simulator-alat` is privé et ne doit pas être exposé dans le code central.
> Par défaut les simulateurs auto-démarrés sont :
> - `stark` (Stack Industries)
> - `deathstar` (Death Star)
> - `paris_metro` (RATP)
> - `mainchem` (anciennement manuchem)
> 
> Si vous avez un simulateur local non commité, placez-le dans `data/simulators` et mettez-le dans `.gitignore`.

### Option 2: Using the Standard Compose with Manual Configuration

If you prefer to customize which services to run:

```bash
# Start with main app, MQTT, and OPC UA (pick and choose)
docker-compose up app mqtt opcua -d
```

Then manually configure MQTT brokers in the web UI (`http://localhost:8080/config.html`).

## Architecture

### MQTT Broker (Mosquitto)

- **Container**: `eclipse-mosquitto:2.0.18-alpine`
- **Port**: `1883` (MQTT), `9001` (WebSocket)
- **Features**:
  - Anonymous access enabled (for local testing)
  - Persistence enabled
  - Logging to both file and stdout

**Configuration File**: `config/mosquitto/mosquitto.conf`

### OPC UA Server

- **Custom Docker Image** (built from `Dockerfile.opcua`)
- **Port**: `4840`
- **Features**:
  - Sample equipment: `TestEquipment/Pump_01`, `TestEquipment/Sensor_01`
  - Dynamic sensor readings (Temperature, Humidity, Pressure, Speed, etc.)
  - Writable variables (e.g., Setpoint)
  - All values update on-demand when read

**Source Code**: `config/opcua/opcua-server.js`

## Available Test Data

### MQTT Topics

Subscribe to any topic. Example:

```bash
# From host machine
mosquitto_sub -h localhost -t "#"

# Or from inside a container
docker exec korelate_mqtt_local mosquitto_sub -t "#"
```

### OPC UA Nodes

Browse the address space at `opc.tcp://localhost:4840/`:

```
TestEquipment/
├── Pump_01/
│   └── Status/
│       ├── Running (Boolean)
│       ├── Speed (Float) - 1000-1500 RPM
│       └── Pressure (Float) - 100-150 bar
└── Sensor_01/
    ├── Temperature (Float) - 20-50°C
    ├── Humidity (Float) - 40-90%
    ├── Counter (Int32) - random 0-1000
    └── Setpoint (Float, writable) - default 25°C
```

## Publishing Test Data to MQTT

Once the MQTT broker is running, you can publish test data:

```bash
# Publish a simple JSON message
mosquitto_pub -h localhost -t "test/temperature" -m '{"sensor":"room1","value":23.5}'

# From inside Docker
docker exec korelate_mqtt_local mosquitto_pub -t "sensors/pump" -m '{"speed":1200,"pressure":105}'
```

## Configuration

### Using Local Servers in `.env` (Docker Compose Standard)

If using the standard `docker-compose.yml`, set in your `.env` file:

```env
MQTT_BROKERS='[
  {
    "id": "local-mqtt",
    "host": "mqtt",
    "port": 1883,
    "protocol": "mqtt",
    "clientId": "my-app",
    "username": "",
    "password": "",
    "subscribe": ["#"],
    "publish": ["#"],
    "certFilename": "",
    "keyFilename": "",
    "caFilename": "",
    "alpnProtocol": "",
    "rejectUnauthorized": false
  }
]'
```

**Important**: Use service name `mqtt` (not `localhost`) as the host inside Docker containers.

### For OPC UA Connections

Configure OPC UA connector to connect to:
- **From Host**: `opc.tcp://localhost:4840/`
- **From Docker**: `opc.tcp://opcua:4840/`

## Persisting Data

### Mosquitto Persistence

Mosquitto data and logs are stored in Docker volumes:
- `mosquitto_data` - Broker messages and state
- `mosquitto_logs` - Log files

To view logs:

```bash
docker logs korelate_mqtt_local
# or
docker exec korelate_mqtt_local tail -f /mosquitto/log/mosquitto.log
```

### Application Data

Application data is persisted in the `./data` volume (mounted from host).

## Stopping and Cleanup

```bash
# Stop all services
docker-compose -f docker-compose.yml.local down

# Stop and remove volumes (wipes all data)
docker-compose -f docker-compose.yml.local down -v

# Stop specific service
docker-compose -f docker-compose.yml.local down mqtt
```

## Troubleshooting

### Service Won't Start

Check logs:
```bash
docker logs korelate_app_local
docker logs korelate_mqtt_local
docker logs korelate_opcua_local
```

### Can't Connect to MQTT from App

Ensure you're using the Docker service name `mqtt` (not `localhost`), not your host machine's IP:

```yaml
# ✅ Correct (inside Docker)
"host": "mqtt"

# ❌ Wrong for Docker
"host": "127.0.0.1"
```

### OPC UA Server Won't Start

- Check that port `4840` is not already in use
- Ensure `Dockerfile.opcua` exists
- Review the OPC UA logs: `docker logs korelate_opcua_local`

### Can't Connect from OPC UA Client

- From **host machine**: Use `opc.tcp://localhost:4840/`
- From **Docker container**: Use `opc.tcp://opcua:4840/`

## Performance Notes

- All sensor values in OPC UA are **generated on-demand** (not pre-computed)
- Each read operation generates fresh random data within realistic ranges
- MQTT is lightweight (Mosquitto ~50MB memory)
- OPC UA server is minimal (~150MB with Node.js runtime)

## Next Steps

1. **Add more sensors/equipment**: Edit `opcua-server.js` to add more OPC UA nodes
2. **Publish from IoT Devices**: Use MQTT publishers or OPC UA clients to inject real data
3. **Create Mappings**: Use the UI to map MQTT topics and OPC UA nodes to your UNS model
4. **Build Workflows**: Create alerts and automations in the Chat interface

## References

- [Mosquitto Documentation](https://mosquitto.org/documentation/)
- [Node OPC UA Documentation](https://node-opcua.github.io/)
- [MQTT Protocol](https://mqtt.org/)

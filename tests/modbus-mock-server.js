/**
 * @license Apache License, Version 2.0
 * @author Sebastien Lalaurette
 *
 * Modbus TCP Mock Server
 * Provides a local test dataset for Korelate's Modbus Connector.
 */

const ModbusRTU = require("modbus-serial");

const vector = {
    getCoil: (addr) => addr % 2 === 0,
    getDiscreteInput: (addr) => addr % 2 !== 0,
    getInputRegister: (addr) => addr * 10,
    getHoldingRegister: (addr) => {
        // Dynamic values
        if (addr === 1) return 220 + Math.floor(Math.random() * 10); // Simulated Temp
        if (addr === 2) return 1000 + Math.floor(Math.random() * 50); // Simulated Pressure
        return addr * 100;
    },
    setCoil: (addr, val) => {
        console.log("Modbus: setCoil at", addr, "to", val);
    },
    setRegister: (addr, val) => {
        console.log("Modbus: setRegister at", addr, "to", val);
    }
};

const serverTCP = new ModbusRTU.ServerTCP(vector, { host: "0.0.0.0", port: 5020, debug: false, unitID: 1 });

serverTCP.on("initialized", () => {
    console.log("✅ Modbus TCP Mock Server initialized on port 5020");
});

serverTCP.on("error", (err) => {
    console.error("❌ Modbus Server Error:", err);
});

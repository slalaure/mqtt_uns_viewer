/**
 * @license Apache License, Version 2.0
 * * Simulation Scenario: Extreme Stress Test
 * Focus: High frequency, dynamic deep topics, and massive payloads.
 */

module.exports = (logger, publish, isSparkplugEnabled) => {
    let intervalId = null;
    
    // --- Configuration ---
    const FREQUENCY_MS = 50;       // Loop every 50ms
    const MESSAGES_PER_TICK = 20;  // Send 20 messages per loop = ~400 msgs/second
    const HUGE_PAYLOAD_CHANCE = 0.05; // 5% chance to send a massive payload
    
    // Generates a ~250KB JSON payload
    function generateMassivePayload() {
        const largeArray = new Array(15000).fill(0).map(() => Math.random());
        return JSON.stringify({
            timestamp: new Date().toISOString(),
            alert: "STRESS_WARNING",
            description: "This is a massive payload designed to test memory limits and websocket buffer sizes.",
            data_dump: largeArray
        });
    }

    function start() {
        if (intervalId) return;
        logger.warn(`[StressSim] 🔥 Starting STRESS TEST. Target: ${MESSAGES_PER_TICK * (1000/FREQUENCY_MS)} msgs/sec.`);
        
        intervalId = setInterval(() => {
            for(let i = 0; i < MESSAGES_PER_TICK; i++) {
                // 1. Generate deep, ever-growing topic tree to stress the frontend DOM
                const level1 = Math.floor(Math.random() * 5);
                const level2 = Math.floor(Math.random() * 20);
                const device = Math.floor(Math.random() * 100);
                const topic = `stress_test/area_${level1}/cell_${level2}/equipment_${device}/telemetry/sensor_x`;
                
                // 2. Mix of small and massive payloads
                const isHuge = Math.random() < HUGE_PAYLOAD_CHANCE;
                const payload = isHuge 
                    ? generateMassivePayload() 
                    : JSON.stringify({ value: Math.random() * 100, status: "ok" });

                // Publish (fire and forget)
                try {
                    publish(topic, payload, false);
                } catch (e) {
                    logger.error({ err: e }, "[StressSim] Publish failed (Buffer full?)");
                }
            }
        }, FREQUENCY_MS);
    }

    function stop() {
        if (intervalId) {
            clearInterval(intervalId);
            intervalId = null;
            logger.info("[StressSim] 🛑 Stopped stress test.");
        }
    }

    return { start, stop };
};
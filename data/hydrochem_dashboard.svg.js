/**
 * @license Apache License, Version 2.0
 * @author Sebastien Lalaurette
 * Custom JS Bindings for the HyDroChem-AG 2026 HMI Dashboard.
 * Handles parsing the 6-batch RCA simulation and updating the SVG DOM dynamically.
 */

window.registerSvgBindings({
    initialize: (svgRoot, context) => {
        console.log("[HyDroChem-AG HMI] SVG initialized.");
        
        // Setup internal state for animations
        svgRoot.dataset.animSpeed = 0; // line speed
        svgRoot.dataset.animExhaust = 0; // exhaust fan speed
        
        let rollRot = 0;
        let agitatorRot = 0;
        let exhaustRot = 0;
        let webOffset = 0;

        const animLoop = () => {
            try {
                const speed = parseFloat(svgRoot.dataset.animSpeed) || 0;
                const exhaust = parseFloat(svgRoot.dataset.animExhaust) || 0;

                // Animate Rolls & Web if line is running
                if (speed > 0) {
                    rollRot = (rollRot + speed * 0.5) % 360;
                    svgRoot.querySelectorAll('.anim-roll').forEach(roll => {
                        const cx = roll.getAttribute('cx');
                        const cy = roll.getAttribute('cy');
                        if (cx && cy) roll.setAttribute('transform', `rotate(${rollRot}, ${cx}, ${cy})`);
                    });

                    webOffset = (webOffset - speed * 0.5) % 20;
                    const web = svgRoot.querySelector('#anim-web');
                    if (web) web.style.strokeDashoffset = webOffset;

                    // Flow animation
                    const flow = svgRoot.querySelector('#anim-flow');
                    if (flow) flow.style.strokeDashoffset = webOffset * 2;

                    // Agitator animation
                    agitatorRot = (agitatorRot + 15) % 360;
                    const agitator = svgRoot.querySelector('#anim-agitator');
                    if (agitator) agitator.setAttribute('transform', `translate(150, 340) rotate(${agitatorRot})`);
                }

                // Animate Exhaust Fan (Independent of line speed)
                if (exhaust > 0) {
                    exhaustRot = (exhaustRot + exhaust * 0.5) % 360;
                    const exhaustFan = svgRoot.querySelector('#anim-exhaust-fan');
                    if (exhaustFan) exhaustFan.setAttribute('transform', `translate(980, 20) rotate(${exhaustRot})`);
                }
            } catch (e) {}

            context.requestAnimationFrame(animLoop);
        };
        
        context.requestAnimationFrame(animLoop);
    },

    update: (brokerId, topic, payload, svgRoot, context) => {
        let data;
        try { data = (typeof payload === 'string') ? JSON.parse(payload) : payload; } 
        catch (e) { return; }
        
        const setText = (id, text) => {
            const el = svgRoot.querySelector(`#${id}`);
            if (el) el.textContent = text;
        };

        const setColor = (id, colorClass) => {
            const el = svgRoot.querySelector(`#${id}`);
            if (el) {
                // Clear old color classes
                el.classList.remove('text-nominal', 'text-warning', 'text-critical', 'text-idle');
                el.classList.add(colorClass);
            }
        };

        // 1. MES: Line Status & Work Order
        if (topic.includes('mes/line_1/status')) {
            setText('val-wo', data.active_wo || 'WAITING');
            setText('val-status', data.status || 'UNKNOWN');
            
            const ind = svgRoot.querySelector('#ind-status');
            if (ind) {
                ind.classList.remove('fill-nominal', 'fill-idle', 'fill-critical');
                if (data.status === 'RUNNING') {
                    ind.classList.add('fill-nominal');
                    setColor('val-status', 'text-nominal');
                } else if (data.status === 'IDLE') {
                    ind.classList.add('fill-idle');
                    setColor('val-status', 'text-idle');
                    // Stop line animations
                    svgRoot.dataset.animSpeed = 0;
                } else {
                    ind.classList.add('fill-critical');
                    setColor('val-status', 'text-critical');
                    svgRoot.dataset.animSpeed = 0;
                }
            }
        }

        // 2. BMS: Substation & Cleanroom
        if (topic.includes('bms/electrical/main_substation')) {
            if (data.voltage_v !== undefined) {
                setText('val-voltage', data.voltage_v.toFixed(1));
                // Highlight sag
                if (data.voltage_v < 380) setColor('val-voltage', 'text-critical');
                else setColor('val-voltage', 'text-nominal');
            }
        }
        if (topic.includes('bms/hvac/cleanroom_area')) {
            if (data.pressure_pa !== undefined) {
                setText('val-cr-pressure', data.pressure_pa.toFixed(2));
                // Highlight pressure drop
                if (data.pressure_pa < 14.5) setColor('val-cr-pressure', 'text-critical');
                else setColor('val-cr-pressure', 'text-nominal');
            }
        }

        // 3. MES: Coating
        if (topic.includes('mes/line_1/coating')) {
            if (data.pump_hz !== undefined) setText('val-pump', data.pump_hz.toFixed(1));
            if (data.mass_flow_kg_min !== undefined) setText('val-flow', data.mass_flow_kg_min.toFixed(2));
            if (data.gap_um !== undefined) setText('val-gap', data.gap_um.toFixed(0));
        }

        // 4. MES: Drying Oven
        if (topic.includes('mes/line_1/drying_oven')) {
            if (data.zone1_temp_c !== undefined) setText('val-z1', data.zone1_temp_c.toFixed(1));
            if (data.zone2_temp_c !== undefined) setText('val-z2', data.zone2_temp_c.toFixed(1));
            if (data.zone3_temp_c !== undefined) {
                setText('val-z3', data.zone3_temp_c.toFixed(1));
                // Highlight if Zone 3 temp spikes due to poor exhaust
                if (data.zone3_temp_c > 182) setColor('val-z3', 'text-warning');
                else setColor('val-z3', 'text-value-small'); // Reset to default blue
            }
            if (data.zone4_temp_c !== undefined) setText('val-z4', data.zone4_temp_c.toFixed(1));
            if (data.zone5_temp_c !== undefined) setText('val-z5', data.zone5_temp_c.toFixed(1));
            if (data.zone6_temp_c !== undefined) setText('val-z6', data.zone6_temp_c.toFixed(1));
            
            if (data.voc_exhaust_fan_hz !== undefined) {
                setText('val-exhaust', data.voc_exhaust_fan_hz.toFixed(1));
                svgRoot.dataset.animExhaust = data.voc_exhaust_fan_hz;
                // Highlight exhaust drop
                if (data.voc_exhaust_fan_hz < 40) setColor('val-exhaust', 'text-critical');
                else setColor('val-exhaust', 'text-nominal');
            }
            
            if (data.total_power_kw !== undefined) setText('val-power', data.total_power_kw.toFixed(1));
        }

        // 5. MES: Web Handling
        if (topic.includes('mes/line_1/web_handling')) {
            if (data.speed_m_min !== undefined) {
                setText('val-speed', data.speed_m_min.toFixed(1));
                svgRoot.dataset.animSpeed = data.speed_m_min; // Update animation speed
            }
            if (data.tension_n !== undefined) {
                setText('val-tension', data.tension_n.toFixed(1));
                // Highlight abnormal tension (Operator Red Herring)
                if (data.tension_n > 155 || data.tension_n < 145) setColor('val-tension', 'text-warning');
                else setColor('val-tension', 'text-value');
            }
        }

        // 6. QMS: Laser Scanner
        if (topic.includes('qms/line_1/laser_scanner')) {
            if (data.thickness_um !== undefined) setText('val-thickness', data.thickness_um.toFixed(2));
            if (data.fissure_count_per_m2 !== undefined) {
                setText('val-fissures', data.fissure_count_per_m2.toFixed(2));
                
                // Animate scanner beam color based on defect rate
                const beam = svgRoot.querySelector('#scanner-beam');
                if (data.fissure_count_per_m2 > 10.0) {
                    setColor('val-fissures', 'text-critical');
                    if (beam) beam.setAttribute('fill', '#f85149'); // Red beam
                } else if (data.fissure_count_per_m2 > 1.0) {
                    setColor('val-fissures', 'text-warning');
                    if (beam) beam.setAttribute('fill', '#d29922'); // Yellow beam
                } else {
                    setColor('val-fissures', 'text-value');
                    if (beam) beam.setAttribute('fill', '#3fb950'); // Green beam
                }
            }
        }
    },

    reset: (svgRoot) => {
        svgRoot.dataset.animSpeed = 0;
        svgRoot.dataset.animExhaust = 0;
    }
});
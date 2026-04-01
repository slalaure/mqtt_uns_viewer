/**
 * @license Apache License, Version 2.0
 * @author Sebastien Lalaurette
 * Custom JS Bindings for the HyDroChem-AG 2026 HMI Dashboard.
 * Fixes CSS ID selectors and implements generic data-key fallbacks properly.
 */

let fanRotation = 0;
let rollRotation = 0;
let webOffset = 0;
let animationFrameId = null;
let webTexture = null;

function createWebTexture() {
    if (!window.THREE) return null;
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 128;
    const ctx = canvas.getContext('2d');
    
    ctx.fillStyle = '#f0f6fc';
    ctx.fillRect(0, 0, 128, 128);
    ctx.fillStyle = '#c9d1d9';
    for(let i=0; i<128; i+=32) {
        ctx.fillRect(i, 0, 16, 128);
    }

    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(10, 1);
    return texture;
}

window.registerHmiBindings({
    initialize: (hmiRoot, context) => {
        console.log("[HyDroChem-AG HMI] Initialized.");
        
        hmiRoot.dataset.fanSpeed = 0;
        hmiRoot.dataset.webSpeed = 0;

        const webPlane = hmiRoot.querySelector('#moving-web-3d');
        if (webPlane) {
            const applyTexture = () => {
                try {
                    const mesh = webPlane.getObject3D('mesh');
                    if (mesh && window.THREE) {
                        webTexture = createWebTexture();
                        if (webTexture) {
                            mesh.material.map = webTexture;
                            mesh.material.needsUpdate = true;
                        }
                    } else {
                        context.setTimeout(applyTexture, 100);
                    }
                } catch (e) {}
            };
            
            if (webPlane.hasLoaded) {
                applyTexture();
            } else {
                context.addEventListener(webPlane, 'loaded', applyTexture);
            }
        }

        // --- Continuous Animation Loop ---
        const renderLoop = () => {
            try {
                const fanBlades3d = hmiRoot.querySelector('#fan-blades-3d');
                const svgFan2d = hmiRoot.querySelector('#svg_anim_fan');
                const svgRolls = hmiRoot.querySelectorAll('.svg_anim_roll');
                
                const speedPct = parseFloat(hmiRoot.dataset.fanSpeed) || 0;
                const webSpeed = parseFloat(hmiRoot.dataset.webSpeed) || 0;

                // 1. Fan Rotation (3D and 2D)
                if (speedPct > 0) {
                    fanRotation = (fanRotation + (speedPct / 100) * 15) % 360;
                    if (fanBlades3d) fanBlades3d.setAttribute('rotation', `0 ${fanRotation} 0`);
                    if (svgFan2d) svgFan2d.setAttribute('transform', `rotate(${fanRotation})`);
                }

                // 2. Web & 2D Roll Movement
                if (webSpeed > 0) {
                    if (webTexture) {
                        webOffset -= (webSpeed / 200); 
                        webTexture.offset.x = webOffset;
                    }

                    rollRotation = (rollRotation + webSpeed * 1.5) % 360;
                    svgRolls.forEach(roll => {
                        const cx = roll.getAttribute('cx');
                        const cy = roll.getAttribute('cy');
                        if (cx && cy) {
                            roll.setAttribute('transform', `rotate(${rollRotation}, ${cx}, ${cy})`);
                        }
                    });
                }
            } catch (e) {
            }

            context.requestAnimationFrame(renderLoop);
        };
        
        context.requestAnimationFrame(renderLoop);
    },

    update: (brokerId, topic, payload, hmiRoot, context) => {
        let data;
        try { data = (typeof payload === 'string') ? JSON.parse(payload) : payload; } 
        catch (e) { return; }
        
        const vars = data.variables || data;

        const setText = (id, text) => {
            const el = hmiRoot.querySelector(`#${id}`);
            if (el) el.textContent = text;
        };
        
        const setColor = (id, color) => {
            const el = hmiRoot.querySelector(`#${id}`);
            if (el) {
                if (el.tagName.toUpperCase() === 'TEXT' || el.tagName.toUpperCase() === 'TSPAN') {
                    el.setAttribute('fill', color);
                } else {
                    el.style.color = color;
                }
            }
        };

        // --- OT: Drying Oven (Updates 3D and 2D components) ---
        // Le reste du tableau (MES, Power, etc.) est géré par les tags data-key dans le HTML via le moteur central !
        if (topic.includes('drying_oven')) {
            
            if (vars.temp_c !== undefined) {
                const tempStr = `${parseFloat(vars.temp_c).toFixed(1)} °C`;
                setText('label-3d-temp', tempStr);
                setText('label-svg-temp', tempStr);
                
                let color = '#d29922'; // Nominal (Gold/Yellow)
                let statusText = 'Status: NOMINAL';
                let intensity = 0.8;

                if (vars.temp_c < 118.0 && vars.temp_c > 30) {
                    color = '#f85149'; // Warning (Red)
                    statusText = 'Status: WARNING (Temp Drop)';
                    intensity = 0.4;
                } else if (vars.temp_c <= 30) {
                    color = '#8b949e'; // Idle (Gray)
                    statusText = 'Status: IDLE';
                    intensity = 0.1;
                }

                setText('label-3d-status', statusText);
                setColor('label-3d-temp', color);
                setColor('label-svg-temp', color);
                
                try {
                    const glowBox = hmiRoot.querySelector('#oven-glow-3d');
                    const light = hmiRoot.querySelector('#oven-light-3d');
                    if (glowBox) glowBox.setAttribute('color', color);
                    if (light) {
                        light.setAttribute('color', color);
                        light.setAttribute('intensity', intensity);
                    }
                } catch(e) {}

                const svgGlow = hmiRoot.querySelector('#svg-oven-glow');
                if (svgGlow) {
                    svgGlow.setAttribute('stop-color', color);
                }
            }

            if (vars.fan_vfd_speed_pct !== undefined) {
                hmiRoot.dataset.fanSpeed = vars.fan_vfd_speed_pct;
                setText('label-svg-fan', `${parseFloat(vars.fan_vfd_speed_pct).toFixed(0)} %`);
            }
            if (vars.web_speed_m_min !== undefined) {
                hmiRoot.dataset.webSpeed = vars.web_speed_m_min;
            }
        }
    },

    reset: (hmiRoot) => {
        if (animationFrameId) {
            cancelAnimationFrame(animationFrameId);
            animationFrameId = null;
        }
        hmiRoot.dataset.fanSpeed = 0;
        hmiRoot.dataset.webSpeed = 0;
    }
});
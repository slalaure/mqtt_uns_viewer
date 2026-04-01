
window.registerSvgBindings({
  initialize: (svgRoot, context) => {
    console.log("Biopomeria View Initialized");
  },
  update: (brokerId, topic, payload, svgRoot, context) => {
    if (!topic.includes('france/fonroche/biopomeria/data')) return;

    // Helper to safe update text
    const updateText = (id, val, unit = '') => {
      const el = svgRoot.getElementById(id);
      if (el) el.textContent = (val !== undefined && val !== null) ? Number(val).toFixed(2) + unit : '--';
    };

    // Helper for status LED
    const updateLed = (id, state) => {
      const el = svgRoot.getElementById(id);
      if (el) el.setAttribute('fill', state == 1 ? '#00ff00' : '#555');
    };

    // --- ZONE 1: ADMISSION ---
    updateText('val_flow_in', payload.AI_FT0102, ' Nm³/h');
    updateText('val_press_in', payload.AI_PT1101, ' mbar');

    // --- ZONE 2: COMPRESSION ---
    // Power is sometimes negative in data, taking absolute or raw? Keeping raw to show faults.
    updateText('val_comp_pwr', payload.AI_C3101_POWER, ' kW'); 
    updateText('val_comp_press', payload.AI_PT3101, ' bar');
    
    // Animation: Rotate fan if power > 10 (or < -10 given the weird data)
    const fan = svgRoot.getElementById('fan_blade');
    if (fan) {
        if (Math.abs(payload.AI_C3101_POWER) > 10) {
            let currentRot = fan.getAttribute('transform') || 'rotate(0, 300, 250)';
            let angle = parseFloat(currentRot.match(/rotate\(([\d\.]+)/)?.[1] || 0);
            fan.setAttribute('transform', `rotate(${(angle + 15) % 360}, 300, 250)`);
        }
    }

    // --- ZONE 3: EPURATION ---
    updateText('val_temp_proc', payload.AI_TT8602, ' °C');
    updateText('val_co2_raw', payload.AI_AI8401_CO2, ' %'); // The weird negative value

    // --- ZONE 4: INJECTION ---
    updateText('val_ch4', payload.AI_AI8402_CH4, ' %');
    updateText('val_cadence', payload.Cadence, ' %');
    
    // Status LEDs
    updateLed('led_run', payload.Status_Demarree);
    updateLed('led_inj', payload.Status_Injection);
    updateLed('led_fault', payload.Fault_General);

    // Dynamic Pipe Color based on Quality
    const pipe = svgRoot.getElementById('pipe_out');
    if (pipe) {
        if (payload.AI_AI8402_CH4 > 97) pipe.setAttribute('stroke', '#00ff00'); // Good
        else if (payload.AI_AI8402_CH4 > 90) pipe.setAttribute('stroke', 'orange'); // Warning
        else pipe.setAttribute('stroke', '#555'); // Bad/Off
    }
  },
  reset: (svgRoot) => {
    // Reset logic if needed
  }
});

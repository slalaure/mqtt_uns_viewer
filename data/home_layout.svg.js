window.registerSvgBindings({
  initialize: (svgRoot) => {
    // Cache device elements
    const heaters = {
      'home/bedroom1/heater': svgRoot.getElementById('heater_bedroom1'),
      'home/bedroom2/heater': svgRoot.getElementById('heater_bedroom2'),
      'home/living_room/heater': svgRoot.getElementById('heater_living'),
      'home/kitchen/heater': svgRoot.getElementById('heater_kitchen'),
      'home/entrance/heater': svgRoot.getElementById('heater_entrance')
    };

    const lights = {
      'home/living_room/light1': svgRoot.getElementById('light_living1'),
      'home/living_room/light2': svgRoot.getElementById('light_living2'),
      'home/garden/light': svgRoot.getElementById('light_garden')
    };

    const sensors = {
      'home/bedroom1/measurements': svgRoot.getElementById('sensor_bedroom1'),
      'home/bedroom2/measurements': svgRoot.getElementById('sensor_bedroom2')
    };

    // Store references for update function
    window._deviceElements = { heaters, lights, sensors };
  },

  update: (brokerId, topic, payload, svgRoot) => {
    const elements = window._deviceElements;

    // Handle heater temperature changes
    if (topic.startsWith('home/')) {
      const roomType = topic.split('/')[1];
      const deviceType = topic.split('/')[2].split('/')[0];

      if (deviceType === 'heater') {
        const el = elements.heaters[topic];
        if (el && payload.temp) {
          // Change color based on temperature
          const temp = parseFloat(payload.temp);
          el.setAttribute('fill', temp > 22 ? '#f44336' : temp < 20 ? '#00e676' : '#ff9800');
        }
      }

      // Handle light state
      if (deviceType === 'light') {
        const el = elements.lights[topic];
        if (el && payload.state) {
          el.setAttribute('fill', payload.state === 'ON' ? '#ffeb3b' : '#8bc34a');
        }
      }

      // Update sensor indicators
      if (deviceType === 'measurements') {
        const el = elements.sensors[topic];
        if (el && payload.motion) {
          el.setAttribute('fill', payload.motion ? '#ffeb3b' : '#2196f3');
        }
      }
    }
  },

  reset: (svgRoot) => {
    // Reset all devices to default states
    svgRoot.querySelectorAll('circle, rect').forEach(el => {
      if (el.id.startsWith('heater_')) el.setAttribute('fill', '#ff9800');
      if (el.id.startsWith('light_')) el.setAttribute('fill', '#8bc34a');
      if (el.id.startsWith('sensor_')) el.setAttribute('fill', '#2196f3');
    });
  }
});
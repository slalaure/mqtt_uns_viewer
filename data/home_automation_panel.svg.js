
window.registerSvgBindings({
    initialize: (svgRoot) => {
        console.log("SVG Initialized");
    },
    update: (brokerId, topic, payload, svgRoot) => {
        console.log(`Received message: Topic=${topic}, Payload=${JSON.stringify(payload)}`);

        // Living Room
        if (topic === "france/isere/grenoble/home/living_room/heater") {
            document.getElementById("living_room_heater_status").textContent = payload.status || "N/A";
        } else if (topic === "france/isere/grenoble/home/living_room/light") {
            document.getElementById("living_room_light_status").textContent = payload.status || "N/A";
        } else if (topic === "france/isere/grenoble/home/living_room/rollershutter") {
            document.getElementById("living_room_rollershutter_status").textContent = payload.status || "N/A";
        } else if (topic === "france/isere/grenoble/home/living_room/measurements") {
            document.getElementById("living_room_measurements_status").textContent = `${payload.temperature}°C` || "N/A";
        } else if (topic === "france/isere/grenoble/home/living_room/target_temperature") {
            document.getElementById("living_room_target_temp_status").textContent = `${payload.temperature}°C` || "N/A";
        }

        // Kitchen
        else if (topic === "france/isere/grenoble/home/kitchen/heater") {
            document.getElementById("kitchen_heater_status").textContent = payload.status || "N/A";
        } else if (topic === "france/isere/grenoble/home/kitchen/rollershutter") {
            document.getElementById("kitchen_rollershutter_status").textContent = payload.status || "N/A";
        } else if (topic === "france/isere/grenoble/home/kitchen/target_temperature") {
            document.getElementById("kitchen_target_temp_status").textContent = `${payload.temperature}°C` || "N/A";
        } else if (topic === "france/isere/grenoble/home/kitchen/measurements") {
            document.getElementById("kitchen_measurements_status").textContent = `${payload.temperature}°C` || "N/A";
        }

        // Bedroom 1
        else if (topic === "france/isere/grenoble/home/bedroom1/heater") {
            document.getElementById("bedroom1_heater_status").textContent = payload.status || "N/A";
        }

        // Bedroom 2
        else if (topic === "france/isere/grenoble/home/bedroom2/heater") {
            document.getElementById("bedroom2_heater_status").textContent = payload.status || "N/A";
        } else if (topic === "france/isere/grenoble/home/bedroom2/measurements") {
            document.getElementById("bedroom2_measurements_status").textContent = `${payload.temperature}°C` || "N/A";
        } else if (topic === "france/isere/grenoble/home/bedroom2/target_temperature") {
            document.getElementById("bedroom2_target_temp_status").textContent = `${payload.temperature}°C` || "N/A";
        }

        // Bedroom 4
        else if (topic === "france/isere/grenoble/home/bedroom4/heater") {
            document.getElementById("bedroom4_heater_status").textContent = payload.status || "N/A";
        } else if (topic === "france/isere/grenoble/home/bedroom4/measurements") {
            document.getElementById("bedroom4_measurements_status").textContent = `${payload.temperature}°C` || "N/A";
        }

        // Loft
        else if (topic === "france/isere/grenoble/home/loft/light") {
            document.getElementById("loft_light_status").textContent = payload.status || "N/A";
        }

        // Entrance
        else if (topic === "france/isere/grenoble/home/entrance/heater") {
            document.getElementById("entrance_heater_status").textContent = payload.status || "N/A";
        } else if (topic === "france/isere/grenoble/home/entrance/measurements") {
            document.getElementById("entrance_measurements_status").textContent = `${payload.temperature}°C` || "N/A";
        }

        // General Home Status
        else if (topic === "france/isere/grenoble/home/heating_mode") {
            document.getElementById("heating_mode_status").textContent = payload.mode || "N/A";
        } else if (topic === "france/isere/grenoble/home/ventilation") {
            document.getElementById("ventilation_status").textContent = payload.status || "N/A";
        }
    },
    reset: (svgRoot) => {
        console.log("SVG Reset");
        // Reset all status texts to N/A or default values
        document.getElementById("living_room_heater_status").textContent = "N/A";
        document.getElementById("living_room_light_status").textContent = "N/A";
        document.getElementById("living_room_rollershutter_status").textContent = "N/A";
        document.getElementById("living_room_measurements_status").textContent = "N/A";
        document.getElementById("living_room_target_temp_status").textContent = "N/A";

        document.getElementById("kitchen_heater_status").textContent = "N/A";
        document.getElementById("kitchen_rollershutter_status").textContent = "N/A";
        document.getElementById("kitchen_target_temp_status").textContent = "N/A";
        document.getElementById("kitchen_measurements_status").textContent = "N/A";

        document.getElementById("bedroom1_heater_status").textContent = "N/A";

        document.getElementById("bedroom2_heater_status").textContent = "N/A";
        document.getElementById("bedroom2_measurements_status").textContent = "N/A";
        document.getElementById("bedroom2_target_temp_status").textContent = "N/A";

        document.getElementById("bedroom4_heater_status").textContent = "N/A";
        document.getElementById("bedroom4_measurements_status").textContent = "N/A";

        document.getElementById("loft_light_status").textContent = "N/A";

        document.getElementById("entrance_heater_status").textContent = "N/A";
        document.getElementById("entrance_measurements_status").textContent = "N/A";

        document.getElementById("heating_mode_status").textContent = "N/A";
        document.getElementById("ventilation_status").textContent = "N/A";
    }
});

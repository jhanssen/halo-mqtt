import options from "@jhanssen/options";
import mqtt from "mqtt";

import { list_locations } from "./halo.js";

const option = options("halo-mqtt");

const haloEmail = option("halo-email");
const haloPassword = option("halo-password");
const haloHost = option("halo-host");

const mqttUser = option("mqtt-user");
const mqttPassword = option("mqtt-password");
const mqttHost = option("mqtt-host");

const data = { state: {} };

if (mqttHost === undefined) {
    console.error("need an mqtt host");
    process.exit(1);
}

if (haloEmail === undefined || haloPassword === undefined) {
    console.error("need an email and password");
    process.exit(1);
}

const mqttOpts = {};
if (mqttUser !== undefined) {
    mqttOpts.username = mqttUser;
}
if (mqttPassword !== undefined) {
    mqttOpts.password = mqttPassword;
}

const CommandTopic = "halomqtt/light/command";
const StateTopic = "halomqtt/light/state";

const client = mqtt.connect(mqttHost, mqttOpts);
client.on("connect", () => {
    client.subscribe([CommandTopic + "/+"], () => {
        console.log("listening for halomqtt/light/set");
    });
    publishDevices();
});
client.on("message", (topic, payload) => {
    // console.log("topic msg", topic);
    if (data.locations === undefined) {
        console.error("no locations");
        return;
    }
    if (topic.startsWith(CommandTopic)) {
        let json;
        try {
            json = JSON.parse(payload.toString());
        } catch (e) {
            console.error("json parse error", e.message, payload.toString());
            return;
        }
        console.log("got set topic", topic, json);

        const rx = /\/halomqtt_([0-9]+)_([0-9]+)$/;
        const m = rx.exec(topic);
        if (!m) {
            console.error("invalid command topic", topic);
            return;
        }

        const locId = parseInt(m[1]);
        const devId = parseInt(m[2]);

        // find device
        let dev = undefined;
        for (const cloc of data.locations) {
            if (cloc.location_id === locId) {
                for (const cdev of cloc.devices) {
                    if (cdev.did === devId) {
                        dev = cdev;
                        break;
                    }
                }
            }
        }

        if (dev === undefined) {
            console.error("couldn't find device for message");
            return;
        }

        // update state
        const devStr = `halomqtt_${locId}_${devId}`;
        const currentState = data.state[devStr];
        if (currentState === undefined) {
            console.error(`unable to find current state for ${devStr}`);
            return;
        }

        let brightness = undefined;
        let colorTemp = undefined;
        if ("brightness" in json) {
            brightness = json.brightness;
        }
        if ("state" in json) {
            // ON or OFF
            if (json.state === "OFF") {
                brightness = 0;
            } else if (json.state === "ON" && brightness === undefined && currentState.brightness === 0) {
                brightness = 255;
            }
        }
        if ("color_temp" in json) {
            colorTemp = Math.floor(1000000 / json.color_temp);
        }

        if (brightness === undefined && colorTemp === undefined) {
            console.error("no brightness or colorTemp", topic, json);
        }

        if (brightness !== undefined) {
            console.log("set brightness", devStr, brightness);
            dev.set_brightness(brightness).catch(e => {
                console.error("failed to set brightness", e);
            });
            currentState.brightness = brightness;
            currentState.state = brightness === 0 ? "OFF" : "ON";
        }
        if (colorTemp !== undefined) {
            console.log("set color temp", devStr, brightness);
            dev.set_color_temp(colorTemp).catch(e => {
                console.error("failed to set color temp", e);
            });
            currentState.color_temp = json.color_temp;
        }

        console.log("update state", `${StateTopic}/${devStr}`, currentState);
        client.publish(`${StateTopic}/${devStr}`, JSON.stringify(currentState), { retain: true });
    }
});

function publishDevices() {
    if (data.locations === undefined)
        return;
    const msg = [];
    for (const loc of data.locations) {
        const devices = [];
        msg.push({
            id: loc.location_id,
            name: loc.name,
            devices
        });
        for (const dev of loc.devices) {
            devices.push({
                id: dev.did,
                name: dev.name,
                mac: dev.mac
            });
            const devStr = `halomqtt_${loc.location_id}_${dev.did}`;

            const discovery = {
                name: dev.name || devStr,
                command_topic: `${CommandTopic}/${devStr}`,
                state_topic: `${StateTopic}/${devStr}`,
                object_id: devStr,
                unique_id: devStr,
                brightness: true,
                color_mode: true,
                supported_color_modes: ["color_temp"],
                max_mireds: Math.floor(1000000 / 2700),
                min_mireds: Math.floor(1000000 / 5000),
                schema: "json",
            };
            console.log("discovery", devStr, discovery);
            client.publish(`homeassistant/light/${devStr}/config`, JSON.stringify(discovery), { retain: true });
            // initial state
            const initial = {
                state: "ON",
                color_temp: Math.floor(1000000 / 5000),
                brightness: 255,
                color_mode: "color_temp"
            };
            console.log("initial state", devStr, initial);
            client.publish(`${StateTopic}/${devStr}`, JSON.stringify(initial), { retain: true });
            data.state[devStr] = initial;
        }
    }
}

async function init() {
    const locs = await list_locations(haloEmail, haloPassword, haloHost);
    data.locations = locs;
    publishDevices();
}

(async function() {
    await init();
})().catch((e) => {
    console.error(e);
    process.exit(1);
});

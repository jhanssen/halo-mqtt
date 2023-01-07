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

const data = {};

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

const SetTopic = "/halo-mqtt/set-value";
const GetTopic = "/halo-mqtt/get-devices";

const client = mqtt.connect(mqttHost, mqttOpts);
client.on("connect", () => {
    client.subscribe([SetTopic, GetTopic], () => {
        console.log("listening for set-value and get-devices");
    });
    publishDevices();
});
client.on("message", (topic, payload) => {
    // console.log("topic msg", topic);
    if (data.locations === undefined) {
        console.error("no locations");
        return;
    }
    if (topic === SetTopic) {
        let json;
        try {
            json = JSON.parse(payload.toString());
        } catch (e) {
            console.error("json parse error", e.message, payload.toString());
            return;
        }
        const locId = json.locId;
        const devId = json.devId;
        if (typeof locId !== "number" || typeof devId !== "number") {
            console.error("invalid id for message");
            return;
        }
        const value = json.value;
        if (typeof value !== "number") {
            console.error("invalid value for message");
            return;
        }

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

        switch (json.type) {
        case "set-brightness":
            dev.set_brightness(value).catch(e => {
                console.error("failed to set brightness", e);
            });
            break;
        case "set-color-temp":
            dev.set_color_temp(value).catch(e => {
                console.error("failed to set color temp", e);
            });
            break;
        default:
            console.error(`invalid data type "${json.type}"`);
            break;
        }
    } else if (topic === GetTopic) {
        publishDevices();
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
        }
    }
    client.publish("/halo-mqtt/devices", JSON.stringify(msg));
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

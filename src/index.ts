import options from "@jhanssen/options";
import mqtt from "mqtt";
import { xdgData } from "xdg-basedir";

import { load as loadCloud, CloudLocation, defaultHost as haloDefaultHost } from "./cloud";
import { load as loadLocal, store as storeLocal } from "./local";
import {
    initializeLocations, Device, Location,
    findLocation, setOnDeviceAlive, setOnDeviceDead
} from "./halo";

const option = options("halo-mqtt");

const haloEmail = option("halo-email") as string | undefined;
const haloPassword = option("halo-password") as string | undefined;
const haloHost = option("halo-host", haloDefaultHost) as string;

const mqttUser = option("mqtt-user") as string | undefined;
const mqttPassword = option("mqtt-password") as string | undefined;
const mqttHost = option("mqtt-host") as string | undefined;

const bluezIface = option("bluez-interface", "hci0") as string;

interface DeviceState {
    state: "ON" | "OFF";
    color_temp: number;
    brightness: number;
    color_mode: "color_temp";
}

interface CommandPayload {
    brightness?: number;
    color_temp?: number;
    state?: "ON" | "OFF";
}

const data: {
    locations: Location[] | undefined;
    state: { [key: string]: DeviceState };
    exited: boolean;
} = { locations: undefined, state: {}, exited: false };

if (mqttHost === undefined) {
    console.error("need an mqtt host");
    process.exit(1);
}

if (haloEmail === undefined || haloPassword === undefined) {
    console.error("need an email and password");
    process.exit(1);
}

const mqttOpts: mqtt.IClientOptions = {};
if (mqttUser !== undefined) {
    mqttOpts.username = mqttUser;
}
if (mqttPassword !== undefined) {
    mqttOpts.password = mqttPassword;
}

const localLocationsFile = `${xdgData}/halo-mqtt/locations.json`;
const CommandTopic = "halomqtt/light/command";
const StateTopic = "halomqtt/light/state";

const enum PublishMode { Keep, Override }

let mqttConnected = false;

function unpublishDevice(loc: Location, dev: Device) {
    const devStr = `halomqtt_${loc.id}_${dev.did}`;
    console.log("unpublishing device", devStr);
    client.publish(`homeassistant/light/${devStr}/config`, "", { retain: true });
}

function unpublishDevices(locs: Location[] | undefined): void {
    if (data.locations === undefined)
        return;
    const existing: string[] = [];
    if (data.locations !== undefined) {
        for (const loc of data.locations) {
            for (const dev of loc.devices) {
                const devStr = `halomqtt_${loc.id}_${dev.did}`;
                existing.push(devStr);
            }
        }
    }
    if (locs !== undefined) {
        for (const loc of locs) {
            for (const dev of loc.devices) {
                const devStr = `halomqtt_${loc.id}_${dev.did}`;
                const idx = existing.indexOf(devStr);
                if (idx !== -1) {
                    existing.splice(idx, 1);
                }
            }
        }
    }
    for (const devStr of existing) {
        client.publish(`homeassistant/light/${devStr}/config`, "", { retain: true });
    }
}

function publishDevice(loc: Location, dev: Device) {
    const devStr = `halomqtt_${loc.id}_${dev.did}`;
    console.log("republishing device", devStr);
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
        schema: "json"
    };
    client.publish(`homeassistant/light/${devStr}/config`, JSON.stringify(discovery), { retain: true });
}

function publishDevices(locs: Location[] | undefined, mode: PublishMode): boolean {
    if (!mqttConnected)
        return false;
    if (locs === undefined) {
        let wrote = false;
        if (mode === PublishMode.Override) {
            // remove all existing
            unpublishDevices(locs);
            wrote = data.locations !== undefined;
            data.locations = undefined;
        }
        return wrote;
    }
    if (data.locations !== undefined && mode === PublishMode.Keep)
        return false;

    unpublishDevices(locs);
    for (const loc of locs) {
        for (const dev of loc.devices) {
            let shouldPublish = !dev.dead;
            if (shouldPublish && data.locations !== undefined) {
                const floc = findLocation(data.locations, dev);
                if (floc !== undefined) {
                    shouldPublish = false;
                    break;
                }
            }

            if (!shouldPublish)
                continue;

            const devStr = `halomqtt_${loc.id}_${dev.did}`;
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
                schema: "json"
            };
            console.log("discovery", devStr, discovery);
            client.publish(`homeassistant/light/${devStr}/config`, JSON.stringify(discovery), { retain: true });
            // initial state
            let initial: DeviceState | undefined = data.state[devStr];
            if (initial === undefined) {
                initial = {
                    state: "ON",
                    color_temp: Math.floor(1000000 / 5000),
                    brightness: 255,
                    color_mode: "color_temp"
                };
                data.state[devStr] = initial;
            }
            console.log("initial state", devStr, initial);
            client.publish(`${StateTopic}/${devStr}`, JSON.stringify(initial), { retain: true });
        }
    }
    data.locations = locs;
    return true;
}

function copyDevices(locs: Location[]): Location[] {
    const cloneLoc = (loc: Location) => {
        const cloc: Location = {
            id: loc.id,
            name: loc.name,
            passphrase: loc.passphrase,
            devices: loc.devices.slice(0)
        };
        return cloc;
    };

    const ret: Location[] = [];
    for (const loc of locs) {
        ret.push(cloneLoc(loc));
    }
    return ret;
}

const client = mqtt.connect(mqttHost, mqttOpts);
client.on("connect", () => {
    client.subscribe([CommandTopic + "/+"], () => {
        console.log("listening for halomqtt/light/set");
    });
    mqttConnected = true;
    publishDevices(data.locations, PublishMode.Keep);
});
client.on("message", (topic: string, payload: Buffer) => {
    // console.log("topic msg", topic);
    if (data.locations === undefined) {
        console.error("no locations");
        return;
    }
    if (topic.startsWith(CommandTopic)) {
        let json: CommandPayload;
        try {
            json = JSON.parse(payload.toString()) as CommandPayload;
        } catch (e) {
            console.error("json parse error", (e as Error).message, payload.toString());
            return;
        }
        console.log("got set topic", topic, json);

        const rx = /\/halomqtt_([0-9]+)_([0-9]+)$/;
        const m = rx.exec(topic);
        if (!m) {
            console.error("invalid command topic", topic);
            return;
        }

        const locId = parseInt(m[1] as string, 10);
        const devId = parseInt(m[2] as string, 10);

        // find device
        let dev: Device | undefined;
        for (const cloc of data.locations) {
            if (cloc.id === locId) {
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

        if (dev.dead) {
            console.error("device is dead", dev.mac);
            return;
        }

        // update state
        const devStr = `halomqtt_${locId}_${devId}`;
        const currentState = data.state[devStr];
        if (currentState === undefined) {
            console.error(`unable to find current state for ${devStr}`);
            return;
        }

        let brightness: number | undefined;
        let colorTemp: number | undefined;
        if (typeof json.brightness === "number") {
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
        if (typeof json.color_temp === "number") {
            colorTemp = Math.floor(1000000 / json.color_temp);
        }

        if (brightness === undefined && colorTemp === undefined) {
            console.error("no brightness or colorTemp", topic, json);
            return;
        }

        if (brightness !== undefined) {
            currentState.brightness = brightness;
            currentState.state = brightness === 0 ? "OFF" : "ON";

            dev.set_brightness(brightness).catch(() => {
                // silence eslint
            });
        }

        if (colorTemp !== undefined) {
            currentState.color_temp = json.color_temp as number;

            dev.set_color_temp(colorTemp).catch(() => {
                // silence eslint
            });
        }

        console.log("update state", `${StateTopic}/${devStr}`, currentState);
        client.publish(`${StateTopic}/${devStr}`, JSON.stringify(currentState), { retain: true });
    }
});

async function initCloud() {
    console.log("initing cloud");
    let apilocs: CloudLocation[];
    try {
        apilocs = await loadCloud(haloEmail as string, haloPassword as string, haloHost);
    } catch (e) {
        if (data.locations) {
            // ignore this cloud error since we already have cached locations
            console.error("ignored cloud error", e);
            return;
        }
        throw e;
    }
    const locs = await initializeLocations(apilocs, bluezIface);
    if (locs) {
        console.log("publishing cloud");
        if (publishDevices(copyDevices(locs), PublishMode.Override)) {
            await storeLocal(localLocationsFile, apilocs);
        }
    } else {
        console.error("no locations from api (cloud)");
    }
}

async function initLocal() {
    console.log("initing local");
    const apilocs = await loadLocal(localLocationsFile);
    const locs = await initializeLocations(apilocs, bluezIface);
    if (locs) {
        console.log("publishing local");
        publishDevices(copyDevices(locs), PublishMode.Keep);
    } else {
        console.error("no locations from api (local)");
    }
}

function exit() {
    if (data.exited)
        return;
    data.exited = true;

    console.log("exiting...");

    const waits: Array<Promise<void>> = [];

    if (data.locations) {
        for (const loc of data.locations) {
            for (const dev of loc.devices) {
                if (dev.dead)
                    continue;
                // remove device from hass
                const devStr = `halomqtt_${loc.id}_${dev.did}`;
                client.publish(`homeassistant/light/${devStr}/config`, "", { retain: true });

                console.log("disconnecting from", dev.mac);
                waits.push(dev.disconnect());
            }
        }
    }

    if (waits.length === 0) {
        process.exit(0);
    } else {
        Promise.all(waits).then(() => {
            process.exit(0);
        }).catch((e: Error) => {
            console.error("failed to disconnect from device", e.message);
            process.exit(1);
        });
    }
}

async function init() {
    setOnDeviceAlive(publishDevice);
    setOnDeviceDead(unpublishDevice);

    await initLocal();
    await initCloud();

    process.once("SIGINT", exit);
    process.once("SIGTERM", exit);
}

(async function() {
    await init();
})().catch(e => {
    console.error(e);
    process.exit(1);
});

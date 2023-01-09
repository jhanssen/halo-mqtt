import options from "@jhanssen/options";
import mqtt from "mqtt";
import { xdgData } from "xdg-basedir";
import { readFile, writeFile, mkdir, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { find_location, initialize_locations, on_device_alive, on_device_dead } from "./halo.js";
import { list_locations } from "./cloud.js";

const option = options("halo-mqtt");

const haloEmail = option("halo-email");
const haloPassword = option("halo-password");
const haloHost = option("halo-host");

const mqttUser = option("mqtt-user");
const mqttPassword = option("mqtt-password");
const mqttHost = option("mqtt-host");

const data = { state: {}, exited: false, queue: [], queueTimer: undefined };

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

const localLocationsFile = `${xdgData}/halo-mqtt/locations.json`;

const QueueDelay = 1000;
const MaxConnectRetries = 5;
const CommandTopic = "halomqtt/light/command";
const StateTopic = "halomqtt/light/state";

const PublishKeep = 0;
const PublishOverride = 1;

const EnqueueBack = 0;
const EnqueueFront = 1;

let mqttConnected = false;

function runQueue() {
    if (data.queueTimer !== undefined)
        return;

    data.queueTimer = setTimeout(() => {
        data.queueTimer = undefined;
        if (data.queue.length === 0) {
            return;
        }

        data.queue.pop()();
    }, QueueDelay);
}

function enqueue(cmd, where) {
    if (where === EnqueueFront) {
        data.queue.splice(0, 0, cmd);
    } else {
        data.queue.push(cmd);
    }
}

const client = mqtt.connect(mqttHost, mqttOpts);
client.on("connect", () => {
    client.subscribe([CommandTopic + "/+"], () => {
        console.log("listening for halomqtt/light/set");
    });
    mqttConnected = true;
    publishDevices(data.locations, PublishKeep);
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
            currentState.brightness = brightness;
            currentState.state = brightness === 0 ? "OFF" : "ON";

            let connectCount = 0;
            const cmd = () => {
                console.log("set brightness", devStr, brightness);
                dev.set_brightness(brightness).then(() => {
                    runQueue();
                }).catch(e => {
                    if (e.type === "org.bluez.Error.Failed") {
                        if (e.text === "Not connected") {
                            enqueue(cmd, EnqueueFront);

                            // try to reconnect
                            console.log("set brightness failed, trying to reconnect");
                            dev.init().then(() => {
                                if (connectCount++ < MaxConnectRetries) {
                                    dev.dead = false;
                                } else if (dev.dead) {
                                    // tell hass this device is dead
                                    const loc = find_location(data.locations, dev);
                                    if (loc !== undefined) {
                                        console.log(`device is dead after ${MaxConnectRetries} retries`, dev.mac);
                                        unpublishDevice(loc, dev);
                                    } else {
                                        console.log("device dead but not found in locations", dev.mac);
                                    }
                                }

                                runQueue();
                            }).catch(e => {
                                console.error("device reinit failed", e);

                                runQueue();
                            });
                        } else {
                            console.error("brightness failed", e);

                            runQueue();
                        }
                    } else if (e.type === "org.bluez.Error.InProgress") {
                        enqueue(cmd, EnqueueFront);
                        runQueue();
                    } else {
                        console.error("failed to set brightness", e);

                        runQueue();
                    }
                });
            };

            enqueue(cmd);
            runQueue();
        }
        if (colorTemp !== undefined) {
            currentState.color_temp = json.color_temp;

            let connectCount = 0;
            const cmd = () => {
                console.log("set color temp", devStr, colorTemp);
                dev.set_color_temp(colorTemp).then(() => {
                    runQueue();
                }).catch(e => {
                    if (e.type === "org.bluez.Error.Failed") {
                        if (e.text === "Not connected") {
                            enqueue(cmd, EnqueueFront);

                            // try to reconnect
                            console.log("set color temp failed, trying to reconnect");
                            dev.init().then(() => {
                                if (connectCount++ < MaxConnectRetries) {
                                    dev.dead = false;
                                } else if (dev.dead) {
                                    // tell hass this device is dead
                                    const loc = find_location(data.locations, dev);
                                    if (loc !== undefined) {
                                        console.log(`device is dead after ${MaxConnectRetries} retries`, dev.mac);
                                        unpublishDevice(loc, dev);
                                    } else {
                                        console.log("device dead but not found in locations", dev.mac);
                                    }
                                }

                                runQueue();
                            }).catch(e => {
                                console.error("device reinit failed", e);

                                runQueue();
                            });
                        } else {
                            console.error("color temp failed", e);

                            runQueue();
                        }
                    } else if (e.type === "org.bluez.Error.InProgress") {
                        enqueue(cmd, EnqueueFront);
                        runQueue();
                    } else {
                        console.error("failed to set color temp", e);

                        runQueue();
                    }
                });
            };

            enqueue(cmd);
            runQueue();
        }

        console.log("update state", `${StateTopic}/${devStr}`, currentState);
        client.publish(`${StateTopic}/${devStr}`, JSON.stringify(currentState), { retain: true });
    }
});

function unpublishDevice(loc, dev) {
    const devStr = `halomqtt_${loc.id}_${dev.did}`;
    console.log("unpublishing device", devStr);
    client.publish(`homeassistant/light/${devStr}/config`, "", { retain: true });
}

function unpublishDevices(locs) {
    if (data.locations === undefined)
        return;
    const existing = [];
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

function publishDevice(loc, dev) {
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
        schema: "json",
    };
    client.publish(`homeassistant/light/${devStr}/config`, JSON.stringify(discovery), { retain: true });
}

function publishDevices(locs, mode) {
    if (!mqttConnected)
        return false;
    if (locs === undefined) {
        let wrote = false;
        if (mode === PublishOverride) {
            // remove all existing
            unpublishDevices(locs);
            wrote = data.locations !== undefined;
            data.locations = undefined;
        }
        return wrote;
    }
    if (data.locations !== undefined && mode === PublishKeep)
        return false;

    unpublishDevices(locs);
    for (const loc of locs) {
        for (const dev of loc.devices) {
            let shouldPublish = !dev.dead;
            if (shouldPublish && data.locations !== undefined) {
                const floc = find_location(data.locations, dev);
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
                schema: "json",
            };
            console.log("discovery", devStr, discovery);
            client.publish(`homeassistant/light/${devStr}/config`, JSON.stringify(discovery), { retain: true });
            // initial state
            let initial = data.state[devStr];
            if (initial === undefined) {
                initial = {
                    state: "ON",
                    color_temp: Math.floor(1000000 / 5000),
                    brightness: 255,
                    color_mode: "color_temp"
                };
                data.state[devStr] = initial;
            };
            console.log("initial state", devStr, initial);
            client.publish(`${StateTopic}/${devStr}`, JSON.stringify(initial), { retain: true });
        }
    }
    data.locations = locs;
    return true;
}

function exit() {
    if (data.exited)
        return;
    data.exited = true;

    console.log("exiting...");

    const waits = [];
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

    if (waits.length === 0) {
        process.exit(0);
    } else {
        Promise.all(waits).then(() => {
            process.exit(0);
        }).catch(e => {
            console.error("failed to disconnect from device", e.message);
            process.exit(1);
        });
    }
}

async function read_locations(file) {
    try {
        const data = await readFile(file, "utf8");
        const json = JSON.parse(data);
        return json;
    } catch (e) {
        if (e.code !== "ENOENT") {
            console.error("read_locations error", e.message);
            try {
                await unlink(file);
            } catch (e) {
            }
            throw e;
        }
        return undefined;
    }
}

async function store_locations(file, locs) {
    const ldata = JSON.stringify(locs) || "";
    for (;;) {
        try {
            await writeFile(file, ldata, "utf8");
            return;
        } catch (e) {
            if (e.code === "ENOENT") {
                // try to make the dir
                const base = dirname(file);
                await mkdir(base, { recursive: true });
            } else {
                console.error(`unable to store data ${file}, ${e.message}`);
                throw e;
            }
        }
    }
}

function copyDevices(locs) {
    const cloneLoc = loc => {
        return {
            id: loc.id,
            name: loc.name,
            passphrase: loc.passphrase,
            devices: loc.devices.slice(0)
        };
    };

    const ret = [];
    for (const loc of locs) {
        ret.push(cloneLoc(loc));
    }
    return ret;
}

async function initCloud() {
    console.log("initing cloud");
    let apilocs;
    try {
        apilocs = await list_locations(haloEmail, haloPassword, haloHost);
    } catch (e) {
        if (data.locations) {
            // ignore this cloud error since we already have cached locations
            console.error("ignored cloud error", e);
            return;
        }
        throw e;
    }
    const locs = await initialize_locations(apilocs);
    console.log("publishing cloud");
    if (publishDevices(copyDevices(locs), PublishOverride)) {
        await store_locations(localLocationsFile, apilocs);
    }
}

async function initLocal() {
    console.log("initing local");
    const apilocs = await read_locations(localLocationsFile);
    const locs = await initialize_locations(apilocs);
    console.log("publishing local");
    publishDevices(copyDevices(locs), PublishKeep);
}

async function init() {
    on_device_alive((loc, dev) => publishDevice(loc, dev));
    on_device_dead((loc, dev) => unpublishDevice(loc, dev));

    await initLocal();
    await initCloud();

    process.once("SIGINT", exit);
    process.once("SIGTERM", exit);
}

(async function() {
    await init();
})().catch((e) => {
    console.error(e);
    process.exit(1);
});

// most of this is ported from https://github.com/nayaverdier/halohome/blob/main/halohome/__init__.py

import needle from "needle";
import { createBluetooth } from "node-ble";
import { generate_key, make_packet, random_seq } from "./crypto.js";

const defaultHost = "https://api.avi-on.com";
const MaxTries = 3;

const data = {};

export class Device {
    constructor(did, pid, name, mac, key) {
        this.did = did;
        this.pid = pid;
        this.name = name;
        this.mac = mac.replace(/(.{2})/g,"$1:").slice(0, -1).toUpperCase();
        this.key = key;
    }

    async init() {
        console.log("initializing", this.name, this.mac);
        const bdev = await data.adapter.waitDevice(this.mac);
        await bdev.connect();
        const gatt = await bdev.gatt();

        const SERVICE = "0000fef1-0000-1000-8000-00805f9b34fb";
        const CHARACTERISTIC_LOW = "c4edc000-9daf-11e3-8003-00025b000b00";
        const CHARACTERISTIC_HIGH = "c4edc000-9daf-11e3-8004-00025b000b00";

        const service = await gatt.getPrimaryService(SERVICE);
        const characteristicLow = await service.getCharacteristic(CHARACTERISTIC_LOW);
        const characteristicHigh = await service.getCharacteristic(CHARACTERISTIC_HIGH);

        this.characteristicLow = characteristicLow;
        this.characteristicHigh = characteristicHigh;

        console.log("- initialized");
    }

    async sendPacket(packet) {
        const csrpacket = make_packet(this.key, random_seq(), packet);
        const low = csrpacket.slice(0, 20);
        const high = csrpacket.slice(20);

        // console.log(low);
        // console.log(high);

        for (let i = 0; i < MaxTries; ++i) {
            try {
                if (this.characteristicLow === undefined) {
                    await this.init();
                }

                await this.characteristicLow.writeValueWithoutResponse(low);
                await this.characteristicHigh.writeValueWithoutResponse(high);

                return true;
            } catch (e) {
                this.characteristicLow = undefined;
                this.characteristicHigh = undefined;

                if (i === MaxTries - 1) {
                    throw e;
                }
            }
        }

        return false;
    }

    async set_brightness(brightness) {
        const packet = Buffer.from([
            0x80 + this.did, 0x80, 0x73, 0, 0x0A,
            0, 0, 0, brightness, 0, 0, 0, 0
        ]);
        // console.log("brighty", packet);
        return await this.sendPacket(packet);
    }

    async set_color_temp(color) {
        const colorBytes = Buffer.allocUnsafe(2);
        colorBytes.writeInt16BE(color);
        const packet = Buffer.from([
            0x80 + this.did, 0x80, 0x73, 0, 0x1D,
            0, 0, 0, 0x01, colorBytes[0], colorBytes[1], 0, 0
        ]);
        // console.log("tempy", packet);
        return await this.sendPacket(packet);
    }
}

async function make_request(host, path, body) {
    const headers = {};
    if (data.auth_token !== undefined) {
        headers["Accept"] = "application/api.avi-on.v2";
        headers["Authorization"] = `Token ${data.auth_token}`;
    }
    let resp;
    if (body !== undefined) {
        resp = await needle("post", `${host}/${path}`, body, { json: true, headers });
    } else {
        resp = await needle("get", `${host}/${path}`, undefined, { headers });
    }
    // console.log(headers, resp);
    if (resp.statusCode >= 200 && resp.statusCode < 300) {
        return resp.body;
    }
    throw new Error(`Invalid statusCode ${resp.statusCode} for ${host}/${path}`);
}

async function load_devices(host, location_id, key) {
    const resp = await make_request(host, `locations/${location_id}/abstract_devices`);
    // console.log(resp);
    let startId = undefined;
    const devs = [];
    for (const adev of resp.abstract_devices) {
        if (startId === undefined)
            startId = adev.avid;
        const devId = adev.avid - startId;
        const pid = adev.pid;
        const name = adev.name;
        const mac = adev.friendly_mac_address;

        const dev = new Device(devId, pid, name, mac, key);
        for (let i = 0; i < MaxTries; ++i) {
            try {
                await dev.init();
                break;
            } catch (e) {
                if (e.type !== "org.bluez.Error.Failed" || i == MaxTries - 1) {
                    throw e;
                }
            }
        }
        devs.push(dev);
    }
    return devs;
}

async function load_locations(host) {
    const resp = await make_request(host, "locations");
    // console.log(resp);
    if (!("locations" in resp)) {
        throw new Error("No locations in locations response");
    }
    const locs = [];
    for (const loc of resp.locations) {
        const location_id = loc.id;

        const key = generate_key(Buffer.concat([
            Buffer.from(loc.passphrase, "ascii"),
            Buffer.from([ 0x00, 0x4d, 0x43, 0x50 ])
        ]));

        const devices = await load_devices(host, location_id, key);
        locs.push({ location_id, name: loc.name, passphrase: loc.passphrase, devices });
    }
    return locs;
}

export async function list_locations(email, password, host) {
    if (host === undefined)
        host = defaultHost;
    const resp = await make_request(host, "sessions", { email, password });
    if (!("credentials" in resp)) {
        throw new Error("No credentials in response");
    }
    data.auth_token = resp.credentials["auth_token"];

    const { bluetooth, destroy } = createBluetooth();
    const adapter = await bluetooth.defaultAdapter();
    if (!await adapter.isDiscovering())
        await adapter.startDiscovery();

    if (data.adapter === undefined) {
        process.on("exit", () => {
            destroy();
        });
    }

    data.adapter = adapter;

    return await load_locations(host);
}

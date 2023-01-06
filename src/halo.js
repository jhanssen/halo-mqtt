import needle from "needle";
import { createBluetooth } from "node-ble";
import { generate_key } from "./crypto.js";

const defaultHost = "https://api.avi-on.com";

const data = {};

class Device {
    constructor(did, pid, name, mac, key) {
        this.did = did;
        this.pid = pid;
        this.name = name;
        this.mac = mac;
        this.key = key;
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

        const key = generate_key(Buffer.concat(
            Buffer.from(loc.passphrase, "ascii"),
            Buffer.from([ 0x00, 0x4d, 0x43, 0x50 ])
        ));

        const devices = await load_devices(host, location_id, key);
        locs.push({ location_id, passphrase: loc.passphrase, devices });
    }
    return locs;
}

export async function list_devices(email, password, host) {
    if (host === undefined)
        host = defaultHost;
    const resp = await make_request(host, "sessions", { email, password });
    if (!("credentials" in resp)) {
        throw new Error("No credentials in response");
    }
    data.auth_token = resp.credentials["auth_token"];

    const { bluetooth, destroy } = createBluetooth();
    const adapter = await bluetooth.defaultAdapter();

    data.adapter = adapter;

    return await load_locations(host);
}

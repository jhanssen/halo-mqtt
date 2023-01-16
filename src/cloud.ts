import needle from "needle";

const data: { auth_token: string | undefined } = { auth_token: undefined };
export const defaultHost = "https://api.avi-on.com";

interface KeyValue {
    [key: string]: unknown;
}

export interface CloudDevice {
    did: number;
    pid: number;
    name: string;
    mac: string;
}

export interface CloudLocation {
    id: number;
    name: string;
    passphrase: string;
    devices: CloudDevice[];
}

async function make_request(host: string, path: string, body?: KeyValue) {
    const headers: { [ key: string ]: string } = {};
    if (data.auth_token !== undefined) {
        headers["Accept"] = "application/api.avi-on.v2";
        headers["Authorization"] = `Token ${data.auth_token}`;
    }
    let resp;
    if (body !== undefined) {
        resp = await needle("post", `${host}/${path}`, body, { json: true, headers });
    } else {
        resp = await needle("get", `${host}/${path}`, { headers });
    }
    // console.log(headers, resp);
    if (resp.statusCode !== undefined && resp.statusCode >= 200 && resp.statusCode < 300) {
        return resp.body;
    }
    throw new Error(`Invalid statusCode ${resp.statusCode} for ${host}/${path}`);
}

async function load_devices(host: string, locid: string): Promise<CloudDevice[]> {
    const resp = await make_request(host, `locations/${locid}/abstract_devices`);
    // console.log(resp);
    let startId: number | undefined;
    const devs: CloudDevice[] = [];
    for (const adev of resp.abstract_devices) {
        if (startId === undefined)
            startId = adev.avid as number;
        const did = (adev.avid as number) - startId;
        const pid = adev.pid as number;
        const name = adev.name as string;
        const mac = (adev.friendly_mac_address as string).replace(/(.{2})/g,"$1:").slice(0, -1).toUpperCase();

        devs.push({ did, pid, name, mac });
    }
    return devs;
}

async function load_locations(host: string): Promise<CloudLocation[]> {
    const resp = await make_request(host, "locations");
    // console.log(resp);
    if (!("locations" in resp)) {
        throw new Error("No locations in locations response");
    }
    const locs: CloudLocation[] = [];
    for (const loc of resp.locations) {
        const devices = await load_devices(host, loc.id as string);
        locs.push({
            id: loc.id as number,
            name: loc.name as string,
            passphrase: loc.passphrase as string,
            devices
        });
    }
    return locs;
}

export async function load(email: string, password: string, host: string): Promise<CloudLocation[]> {
    const resp = await make_request(host, "sessions", { email, password });
    if (!("credentials" in resp)) {
        throw new Error("No credentials in response");
    }
    data.auth_token = resp.credentials.auth_token;

    return await load_locations(host);
}

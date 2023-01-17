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

async function make_request<T>(host: string, path: string, body?: KeyValue): Promise<T> {
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
    if (resp.statusCode !== undefined && resp.statusCode >= 200 && resp.statusCode < 300 && typeof resp.body === "object") {
        return resp.body as T;
    }
    throw new Error(`Invalid response, status code: ${resp.statusCode}, body type: ${typeof resp.body} for ${host}/${path}`);
}

interface ApiAbstractDevice {
    avid?: number;
    pid?: number;
    name?: string;
    friendly_mac_address?: string;
}

interface ApiAbstractDevicesResponse {
    abstract_devices?: ApiAbstractDevice[];
}

async function load_devices(host: string, locid: number): Promise<CloudDevice[]> {
    const resp = await make_request<ApiAbstractDevicesResponse>(host, `locations/${locid}/abstract_devices`);
    // console.log(resp);
    let startId: number | undefined;
    const devs: CloudDevice[] = [];
    if (!(resp.abstract_devices instanceof Array)) {
        throw new Error("No abstract_devices in device response");
    }
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

interface ApiLocation {
    id?: number;
    name?: string;
    passphrase?: string;
}

interface ApiLocationsResponse {
    locations?: ApiLocation[];
}

async function load_locations(host: string): Promise<CloudLocation[]> {
    const resp = await make_request<ApiLocationsResponse>(host, "locations");
    // console.log(resp);
    if (!(resp.locations instanceof Array)) {
        throw new Error("No locations in locations response");
    }
    const locs: CloudLocation[] = [];
    for (const loc of resp.locations) {
        const devices = await load_devices(host, loc.id as number);
        locs.push({
            id: loc.id as number,
            name: loc.name as string,
            passphrase: loc.passphrase as string,
            devices
        });
    }
    return locs;
}

interface ApiCredentials {
    auth_token?: string;
}

interface ApiSessionsResponse {
    credentials?: ApiCredentials;
}

export async function load(email: string, password: string, host: string): Promise<CloudLocation[]> {
    const resp = await make_request<ApiSessionsResponse>(host, "sessions", { email, password });
    if (typeof resp.credentials !== "object") {
        throw new Error("No credentials in sessions response");
    }
    data.auth_token = resp.credentials.auth_token;

    return await load_locations(host);
}

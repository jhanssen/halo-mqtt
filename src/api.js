import needle from "needle";

const data = {};
const defaultHost = "https://api.avi-on.com";

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

async function load_devices(host, locid, key) {
    const resp = await make_request(host, `locations/${locid}/abstract_devices`);
    // console.log(resp);
    let startId = undefined;
    const devs = [];
    for (const adev of resp.abstract_devices) {
        if (startId === undefined)
            startId = adev.avid;
        const did = adev.avid - startId;
        const pid = adev.pid;
        const name = adev.name;
        const mac = adev.friendly_mac_address.replace(/(.{2})/g,"$1:").slice(0, -1).toUpperCase();

        devs.push({ did, pid, name, mac });
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
        const devices = await load_devices(host, loc.id);
        locs.push({ id: loc.id, name: loc.name, passphrase: loc.passphrase, devices });
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

    return await load_locations(host);
}

// most of this is ported from https://github.com/nayaverdier/halohome/blob/main/halohome/__init__.py

import { Bluez, Adapter, Variant } from "@sorrir/bluetooth";
import { generate_key, make_packet, random_seq } from "./crypto.js";
import { waitForAsync, AsyncTimeoutError } from "./wait.js";

const MaxTries = 3;
const MsPerTry = 5000;

const data = {};

export class Device {
    constructor(did, pid, name, mac, key) {
        this.did = did;
        this.pid = pid;
        this.name = name;
        this.mac = mac;
        this.key = key;
        this.bdev = undefined;
    }

    async init() {
        console.log("initializing", `'${this.name}'`, this.mac);
        const retry = { maxRetries: MaxTries, retryIntervalMs: MsPerTry };
        const bdev = await data.adapter.getDeviceByAddress(this.mac, retry);
        await bdev.connect();
        await bdev.Connected.waitForValue(true);

        const SERVICE = "0000fef1-0000-1000-8000-00805f9b34fb";
        const CHARACTERISTIC_LOW = "c4edc000-9daf-11e3-8003-00025b000b00";
        const CHARACTERISTIC_HIGH = "c4edc000-9daf-11e3-8004-00025b000b00";

        const service = await bdev.getService({ UUID: SERVICE }, retry);
        if (service === undefined) {
            console.error(`- no service for ${this.name} ${this.mac}`);
            return;
        }
        const characteristicLow = await service.getCharacteristic({ UUID: CHARACTERISTIC_LOW }, retry);
        const characteristicHigh = await service.getCharacteristic({ UUID: CHARACTERISTIC_HIGH }, retry);
        if (characteristicLow === undefined || characteristicHigh === undefined) {
            console.error(`- no characteristic for ${this.name} ${this.mac}`);
            return;
        }

        this.characteristicLow = characteristicLow;
        this.characteristicHigh = characteristicHigh;
        this.bdev = bdev;

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
                if (this.bdev === undefined) {
                    await this.init();
                }

                await this.characteristicLow.writeValue(Array.from(low), {});
                await this.characteristicHigh.writeValue(Array.from(high), {});

                return true;
            } catch (e) {
                this.characteristicLow = undefined;
                this.characteristicHigh = undefined;

                if (this.bdev) {
                    await this.bdev.disconnect();
                    this.bdev = undefined;
                }

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
        console.log("brightness", this.mac, brightness, packet);
        return await this.sendPacket(packet);
    }

    async set_color_temp(color) {
        const colorBytes = Buffer.allocUnsafe(2);
        colorBytes.writeInt16BE(color);
        const packet = Buffer.from([
            0x80 + this.did, 0x80, 0x73, 0, 0x1D,
            0, 0, 0, 0x01, colorBytes[0], colorBytes[1], 0, 0
        ]);
        console.log("set_color_temp", this.mac, color, packet);
        return await this.sendPacket(packet);
    }

    async disconnect() {
        if (this.bdev) {
            await this.bdev.disconnect();
            this.bdev = undefined;
            this.characteristicLow = undefined;
            this.characteristicHigh = undefined;
        }
    }
}

export async function initialize_locations(locations) {
    if (data.adapter === undefined) {
        console.log("connecting to bluez");
        const bluez = await new Bluez().init();
        const adapter = await Adapter.connect(bluez, "/org/bluez/hci0");
        await adapter.Powered.set(true);

        if (!await adapter.Discovering.get()) {
            try {
                await waitForAsync(7500, () => { return adapter.startDiscovery(); });
                await adapter.Discovering.waitForValue(true);
            } catch (e) {
                if (!(e instanceof AsyncTimeoutError)) {
                    throw e;
                }
            }
        }
        await adapter.setDiscoveryFilter({ Transport: new Variant("s", "le") });
        console.log("connected to bluez");

        data.adapter = adapter;
    }

    const existingDevs = [];
    const existingLocs = [];
    if (data.locations) {
        for (const loc of data.locations) {
            existingLocs.push(loc);
            for (const dev of loc.devices) {
                existingDevs.push(dev.mac);
            }
        }
    }

    if (locations) {
        if (data.locations === undefined)
            data.locations = [];
        for (const loc of locations) {
            const key = generate_key(Buffer.concat([
                Buffer.from(loc.passphrase, "ascii"),
                Buffer.from([ 0x00, 0x4d, 0x43, 0x50 ])
            ]));

            const lidx = existingLocs.findIndex(e => e.id === loc.id);
            let devices = undefined;
            if (lidx === -1) {
                data.locations.push({ id: loc.id, name: loc.name, passphrase: loc.passphrase, devices: []});
                devices = data.locations[data.locations.length - 1].devices;
            } else {
                devices = existingLocs[lidx].devices;
            }

            for (const dev of loc.devices) {
                // does this device exist already?
                const didx = existingDevs.indexOf(dev.mac);
                if (didx !== -1) {
                    existingDevs.splice(didx, 1);
                    continue;
                }
                // no, add it
                const ndev = new Device(dev.did, dev.pid, dev.name, dev.mac, key);
                for (let i = 0; i < MaxTries; ++i) {
                    try {
                        await ndev.init();
                        break;
                    } catch (e) {
                        if (e.type !== "org.bluez.Error.Failed" || i == MaxTries - 1) {
                            throw e;
                        }
                    }
                }
                devices.push(ndev);
            }
        }
    }

    return data.locations;
}

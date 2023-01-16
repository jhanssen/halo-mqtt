import { Bluez, Adapter, Device as BluezDevice, GattCharacteristic, Variant, dict as Dict } from "@sorrir/bluetooth";
import { generate_key, make_packet, random_seq } from "./crypto";
import { waitForAsync, AsyncTimeoutError, retryOnError } from "./wait";
import { CloudLocation } from "./cloud";

export interface Location {
    id: number;
    name: string;
    passphrase: string;
    devices: Device[];
}

type InterfacesAddedType = {
    path: string;
    objects: Dict<string, Dict<string, Variant>>;
};

type InterfacesRemovedType = {
    path: string;
    interfaceNames: string[];
};

const data: {
    adapter?: Adapter;
    locations?: Location[];

    onDeviceAlive?: (loc: Location, dev: Device) => void;
    onDeviceDead?: (loc: Location, dev: Device) => void;
} = {};

const MaxTries = 5;
const MsPerTry = 5000;
const QueueDelay = 1000;

interface DeviceError {
    type?: string;
    text?: string;
}

interface DeviceQueueItem {
    cmd: () => Promise<boolean>;
    resolve: (value: boolean | PromiseLike<boolean>) => void;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    reject: (reason?: any) => void;

    connectCount?: number;
}

const enum DeviceQueuePosition {
    Back = 0,
    Front = 1
}

class DeviceQueue {
    private _queue: DeviceQueueItem[];
    private _timer: ReturnType<typeof setTimeout> | undefined;
    private _device: Device;

    constructor(dev: Device) {
        this._device = dev;
        this._queue = [];
    }

    enqueue(item: DeviceQueueItem, position?: DeviceQueuePosition) {
        if (position === DeviceQueuePosition.Front) {
            this._queue.splice(0, 0, item);
        } else {
            this._queue.push(item);
        }
    }

    runQueue() {
        if (this._timer !== undefined)
            return;
        this._timer = setTimeout(() => {
            this._timer = undefined;
            if (this._queue.length === 0)
                return;

            const item = this._queue.shift() as DeviceQueueItem;

            item.cmd().then(result => {
                item.resolve(result);
                this.runQueue();
            }).catch((e: DeviceError) => {
                if (e.type === "org.bluez.Error.Failed") {
                    if (e.text === "Not connected") {
                        this.enqueue(item, DeviceQueuePosition.Front);

                        const dev = this._device;

                        // try to reconnect
                        console.log("command failed, trying to reconnect");
                        dev.init().then(() => {
                            if (item.connectCount === undefined)
                                item.connectCount = 0;
                            if (item.connectCount++ < MaxTries) {
                                dev.dead = false;
                            } else if (dev.dead) {
                                const loc = findLocation(data.locations, dev);
                                if (loc) {
                                    console.log(`device is dead after ${MaxTries} retries`, dev.mac);
                                    if (data.onDeviceDead)
                                        data.onDeviceDead(loc, dev);
                                } else {
                                    console.log("device dead but not found in locations", dev.mac);
                                }
                            }

                            this.runQueue();
                        }).catch(ne => {
                            console.error("device reinit failed", ne);
                            this.runQueue();
                        });
                    } else {
                        item.reject(new Error(`Command failed for ${this._device.mac}, ${e.type} ${e.text}`));

                        console.error("command failed", e);
                        this.runQueue();
                    }
                } else if (e.type === "org.bluez.Error.InProgress") {
                    this.enqueue(item, DeviceQueuePosition.Front);
                    this.runQueue();
                } else {
                    item.reject(new Error(`Command failed for ${this._device.mac}, ${e.type} ${e.text}`));

                    console.error("failed to execute command", e);
                    this.runQueue();
                }
            });
        }, QueueDelay);
    }
}

export class Device {
    public readonly did: number;
    public readonly pid: number;
    public readonly name: string;
    public readonly mac: string;
    public readonly key: Buffer;

    public dead: boolean;

    private _device: BluezDevice | undefined;
    private _path: string | undefined;

    private _characteristicLow: GattCharacteristic | undefined;
    private _characteristicHigh: GattCharacteristic | undefined;

    private _queue: DeviceQueue;

    constructor(did: number, pid: number, name: string, mac: string, key: Buffer) {
        this.did = did;
        this.pid = pid;
        this.name = name;
        this.mac = mac;
        this.key = key;
        this.dead = false;
        this._device = undefined;
        this._path = undefined;
        this._queue = new DeviceQueue(this);
    }

    public get path(): string | undefined { return this._path; }
    public get queue(): DeviceQueue { return this._queue; }

    public async init(): Promise<void> {
        console.log("initializing device", this.name, this.mac);
        const retry = { maxRetries: MaxTries, retryIntervalMs: MsPerTry };
        const bdev = await retryOnError<BluezDevice>({ type: "org.bluez.Error.Failed" }, retry, async () => {
            if (data.adapter === undefined) {
                throw new Error("No adapter");
            }
            const nbdev = await data.adapter.getDeviceByAddress(this.mac, retry);
            if (nbdev === undefined) {
                return undefined;
            }
            await nbdev.connect();
            await nbdev.Connected.waitForValue(true);
            return nbdev;
        });

        if (bdev === undefined) {
            this.dead = true;
            console.error(`- no device for ${this.name} ${this.mac}`);
            return;
        }

        const SERVICE = "0000fef1-0000-1000-8000-00805f9b34fb";
        const CHARACTERISTIC_LOW = "c4edc000-9daf-11e3-8003-00025b000b00";
        const CHARACTERISTIC_HIGH = "c4edc000-9daf-11e3-8004-00025b000b00";

        const service = await bdev.getService({ UUID: SERVICE }, retry);
        if (service === undefined) {
            this.dead = true;
            console.error(`- no service for ${this.name} ${this.mac}`);
            return;
        }

        const characteristicLow = await service.getCharacteristic({ UUID: CHARACTERISTIC_LOW }, retry);
        const characteristicHigh = await service.getCharacteristic({ UUID: CHARACTERISTIC_HIGH }, retry);
        if (characteristicLow === undefined || characteristicHigh === undefined) {
            this.dead = true;
            console.error(`- no characteristic for ${this.name} ${this.mac}`);
            return;
        }

        this._characteristicLow = characteristicLow;
        this._characteristicHigh = characteristicHigh;
        this._device = bdev;
        this._path = bdev.path;

        console.log("- initialized", this.name, this.mac);
    }

    private _sendPacket(packet: Buffer): Promise<boolean> {
        return new Promise<boolean>((resolve, reject) => {
            const cmd = async () => {
                if (this.dead)
                    return false;

                const csrpacket = make_packet(this.key, random_seq(), packet);
                const low = csrpacket.subarray(0, 20);
                const high = csrpacket.subarray(20);

                // console.log(low);
                // console.log(high);

                while (this._characteristicLow === undefined || this._characteristicHigh === undefined) {
                    await this.init();
                }

                await this._characteristicLow.writeValue(Array.from(low), {});
                await this._characteristicHigh.writeValue(Array.from(high), {});

                return true;
            };

            this._queue.enqueue({ cmd, resolve, reject });
            this._queue.runQueue();
        });
    }

    public async set_brightness(brightness: number): Promise<boolean> {
        const packet = Buffer.from([
            0x80 + this.did, 0x80, 0x73, 0, 0x0A,
            0, 0, 0, brightness, 0, 0, 0, 0
        ]);
        console.log("brightness", this.mac, brightness, packet);
        return await this._sendPacket(packet);
    }

    public async set_color_temp(color: number): Promise<boolean> {
        const colorBytes = Buffer.allocUnsafe(2);
        colorBytes.writeInt16BE(color);
        const packet = Buffer.from([
            0x80 + this.did, 0x80, 0x73, 0, 0x1D,
            0, 0, 0, 0x01, colorBytes[0] as number, colorBytes[1] as number, 0, 0
        ]);
        console.log("set_color_temp", this.mac, color, packet);
        return await this._sendPacket(packet);
    }

    public async disconnect(): Promise<void> {
        if (!this.dead && this._device) {
            await this._device.disconnect();
            this.clear();
        }
    }

    public clear(): void {
        // do not clear path here since we depend on it to reinitialize the device if it's readded
        this._device = undefined;
        this._characteristicLow = undefined;
        this._characteristicHigh = undefined;
    }
}

export function findLocation(locations: Location[] | undefined, dev: Device): Location | undefined {
    if (!locations)
        return undefined;
    for (const floc of locations) {
        for (const fdev of floc.devices) {
            if (dev.mac === fdev.mac) {
                return floc;
            }
        }
    }
    return undefined;
}

function checkDeviceAdded(added: InterfacesAddedType) {
    // console.log("checkDeviceAdded", added);
    if ("path" in added && "objects" in added && Object.keys(added.objects).indexOf("org.bluez.Device1") !== -1) {
        // potential device
        if (data.locations) {
            for (const loc of data.locations) {
                for (const dev of loc.devices) {
                    if (dev.path === added.path) {
                        if (!dev.dead)
                            return;
                        console.log("device added", dev.mac);

                        dev.dead = false;
                        dev.init().then(() => {
                            if (data.onDeviceAlive)
                                data.onDeviceAlive(loc, dev);
                        }).catch(() => {
                            dev.dead = true;
                            dev.clear();
                            console.error("unable to reinit device", dev.mac);
                        });
                        return;
                    }
                }
            }
        }
    }
}

function checkDeviceRemoved(removed: InterfacesRemovedType) {
    // console.log("checkDeviceRemoved", removed);
    if ("path" in removed && "interfaceNames" in removed && removed.interfaceNames.indexOf("org.bluez.Device1") !== -1) {
        // potential device
        if (data.locations) {
            for (const loc of data.locations) {
                for (const dev of loc.devices) {
                    if (dev.path === removed.path) {
                        if (dev.dead)
                            return;
                        dev.dead = true;
                        dev.clear();
                        console.log("device removed", dev.mac);

                        if (data.onDeviceDead)
                            data.onDeviceDead(loc, dev);
                        return;
                    }
                }
            }
        }
    }
}

export async function initializeLocations(locations: CloudLocation[] | undefined, iface: string): Promise<Location[] | undefined> {
    if (data.adapter === undefined) {
        console.log("connecting to bluez");
        const bluez = await new Bluez().init();

        bluez.objectManager.InterfacesAdded.on(checkDeviceAdded);
        bluez.objectManager.InterfacesRemoved.on(checkDeviceRemoved);

        const adapter = await Adapter.connect(bluez, `/org/bluez/${iface}`);
        await adapter.Powered.set(true);

        if (!await adapter.Discovering.get()) {
            try {
                await waitForAsync<void>(7500, () => { return adapter.startDiscovery(); });
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

    const existingDevs: string[] = [];
    const existingLocs: Location[] = [];
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
        const deviceInits: Array<Promise<void>> = [];
        for (const loc of locations) {
            const key = generate_key(Buffer.concat([
                Buffer.from(loc.passphrase, "ascii"),
                Buffer.from([ 0x00, 0x4d, 0x43, 0x50 ])
            ]));

            const lidx = existingLocs.findIndex(e => e.id === loc.id);
            let devices: Device[] | undefined;
            if (lidx === -1) {
                data.locations.push({ id: loc.id, name: loc.name, passphrase: loc.passphrase, devices: []});
                devices = (data.locations[data.locations.length - 1] as Location).devices;
            } else {
                devices = (existingLocs[lidx] as Location).devices;
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
                deviceInits.push(ndev.init());
                devices.push(ndev);
            }
        }
        if (deviceInits.length > 0) {
            await Promise.all(deviceInits);
        }
    }

    return data.locations;
}

export function setOnDeviceAlive(alive: (loc: Location, dev: Device) => void | undefined) {
    data.onDeviceAlive = alive;
}

export function setOnDeviceDead(dead: (loc: Location, dev: Device) => void | undefined) {
    data.onDeviceDead = dead;
}

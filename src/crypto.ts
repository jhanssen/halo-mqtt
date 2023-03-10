// ported from https://github.com/nkaminski/csrmesh/blob/master/csrmesh/crypto.py

import { createHash, createHmac, createCipheriv } from "crypto";
import randomInteger from "random-int";

function reverse(src: Buffer) {
    const buffer = Buffer.allocUnsafe(src.length);

    for (let i = 0, j = src.length - 1; i <= j; ++i, --j) {
        buffer[i] = src[j] as number;
        buffer[j] = src[i] as number;
    }

    return buffer;
}

function intTo3Bytes(num: number) {
    const buf = Buffer.allocUnsafe(4);
    buf.writeUint32LE(num);
    return buf.subarray(0, 3);
}

function makeIV(source: number, seq_arr: Buffer) {
    const iv = Buffer.alloc(16);
    seq_arr.copy(iv, 0);
    iv.writeUint16LE(source, 4);
    // console.log("iv", iv);
    return iv;
}

export function generate_key(data: Buffer) {
    const hash = createHash("sha256");
    // console.log("generating key", data);
    hash.update(data);
    const ba = reverse(hash.digest());
    return ba.subarray(0, 16);
}

export function make_packet(key: Buffer, seq: number, data: Buffer) {
    // console.log("key", key);
    // console.log("data", data);
    const eof = 0xff;
    const source = 0x8000;
    const seq_arr = intTo3Bytes(seq);
    const iv = makeIV(source, seq_arr);
    const enc = createCipheriv("aes-128-ofb", key, iv);
    const payload = Buffer.concat([enc.update(data), enc.final()]);
    const prehmac = Buffer.concat([Buffer.alloc(13), payload]);
    seq_arr.copy(prehmac, 8);
    prehmac.writeUint16LE(source, 11);
    // console.log("prehmac", prehmac);
    const hmac = createHmac("sha256", key);
    hmac.update(prehmac);
    const hm = reverse(hmac.digest()).subarray(0, 8);
    const final = Buffer.allocUnsafe(14 + payload.byteLength);
    seq_arr.copy(final, 0);
    final.writeUint16LE(source, 3);
    payload.copy(final, 5);
    hm.copy(final, 5 + payload.byteLength);
    final.writeUint8(eof, 13 + payload.byteLength);
    // console.log("final", final);
    return final;
}

export function random_seq() {
    return randomInteger(1, 16777215);
}

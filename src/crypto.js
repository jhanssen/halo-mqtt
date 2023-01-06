// ported from https://github.com/nkaminski/csrmesh/blob/master/csrmesh/crypto.py

import { createHash, createHmac, createCipheriv } from "node:crypto";
import randomInteger from "random-int";

function reverse(src) {
    const buffer = Buffer.allocUnsafe(src.length);

    for (var i = 0, j = src.length - 1; i <= j; ++i, --j) {
        buffer[i] = src[j];
        buffer[j] = src[i];
    }

    return buffer;
}

function intTo3Bytes(num) {
    const buf = Buffer.allocUnsafe(4);
    buf.writeInt32LE(num);
    return buf.slice(0, 3);
}

function makeIV(source, seq_arr) {
    const iv = Buffer.alloc(16);
    seq_arr.copy(iv, 0);
    iv.writeInt32LE(source, 4);
    return iv;
}

export function generate_key(data) {
    const hash = createHash("sha256");
    hash.update(data);
    const ba = reverse(hash.digest());
    return ba.slice(0, 16);
}

export function make_packet(key, seq, data) {
    const eof = 0xff;
    const source = 0x8000;
    const seq_arr = intTo3Bytes(seq);
    const iv = makeIV(source, seq_arr);
    const enc = createCipheriv("aes-256-ofb", key, iv);
    const payload = Buffer.concat(enc.update(data), enc.final());
    const prehmac = Buffer.concat(Buffer.alloc(13), payload);
    seq_arr.copy(prehmac, 8);
    prehmac.writeInt32LE(source, 11);
    const hmac = createHmac("sha256", key);
    hmac.update(prehmac);
    const hm = reverse(hmac.digest()).slice(0, 8);
    const final = Buffer.allocUnsafe(14 + payload.byteLength);
    seq_arr.copy(final, 0);
    final.writeInt32LE(source, 3);
    payload.copy(final, 5);
    hm.copy(final, 5 + payload.byteLength);
    final.writeInt8(eof, 6 + payload.byteLength);
    return final;
}

export function random_seq() {
    return randomInteger(1, 16777215);
}

import options from "@jhanssen/options";
import { list_devices } from "./halo.js";

const option = options("halo-mqtt");

const email = option("email");
const password = option("password");
const host = option("host");

if (email === undefined || password === undefined) {
    console.error("need an email and password");
    process.exit(1);
}

async function init() {
    await list_devices(email, password, host);
}

(async function() {
    await init();
})().then(() => {
    process.exit(0);
}).catch((e) => {
    console.error(e);
    process.exit(1);
});

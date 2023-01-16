import { readFile, writeFile, mkdir, unlink } from "fs/promises";
import { dirname } from "path";
import { CloudLocation } from "./cloud";

interface NodeError {
    code?: string;
    message: string;
}

export async function load(file: string): Promise<CloudLocation[] | undefined> {
    try {
        const data = await readFile(file, "utf8");
        const json = JSON.parse(data);
        return json as CloudLocation[];
    } catch (e: unknown) {
        if ((e as NodeError).code !== "ENOENT") {
            console.error("read_locations error", (e as NodeError).message);
            try {
                await unlink(file);
            } catch (ne) {
                // silence eslint
            }
            throw e;
        }
        return undefined;
    }
}

export async function store(file: string, locs: CloudLocation[]) {
    const ldata = JSON.stringify(locs) || "";
    for (;;) {
        try {
            await writeFile(file, ldata, "utf8");
            return;
        } catch (e) {
            if ((e as NodeError).code === "ENOENT") {
                // try to make the dir
                const base = dirname(file);
                await mkdir(base, { recursive: true });
            } else {
                console.error(`unable to store data ${file}, ${(e as NodeError).message}`);
                throw e;
            }
        }
    }
}

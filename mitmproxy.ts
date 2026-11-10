#!/usr/bin/env bun
/**
 * chrome-bridge：本地代理（HTTP / HTTPS CONNECT / SOCKS5 共用一个端口），
 * 除本地回环地址（直接转发）外，所有 HTTP(S) 请求都交给 Chrome 扩展用 fetch 发出。
 * 配合 background.js（协议 v5）使用。
 *
 *   ulimit -n 10240 && bun --prefer-offline mitmproxy.ts [--port 1080] [--ws 127.0.0.1:8765] [--ca-dir ~/.chrome-bridge-ca] [--passthrough "*.apple.cn,*.apple.com,*.icloud.com"]
 */
import * as mockttp from "mockttp@4.6.5";
import { findRawHeader, rawHeadersToObject } from "mockttp@4.6.5/dist/util/header-utils";
import { isLocalhostAddress } from "mockttp@4.6.5/dist/util/ip-utils";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { ServerWebSocket } from "bun";

const { values: options } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
        port: { type: "string", short: "p", default: "1080" },
        ws: { type: "string", default: "127.0.0.1:8765" },
        "ca-dir": { type: "string", default: join(homedir(), ".chrome-bridge-ca") },
        passthrough: { type: "string", default: "" },
    },
});

const TIMEOUT_MS = 60_000;
const port = Number(options.port);
const wsUrl = new URL(`ws://${options.ws}`);
const caDir = options["ca-dir"];
const passthrough = options.passthrough
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

type ToExt =
    | {
          t: "req";
          id: string;
          method: string;
          url: string;
          headers: [string, string][];
      }
    | { t: "cancel"; id: string };

type FromExt =
    | { t: "data"; id: string }
    | { t: "end"; id: string; status: number; headers: [string, string][] }
    | { t: "end"; id: string; msg: string }; // 扩展侧失败，文案由扩展拼好

function pack(head: ToExt, body?: Uint8Array): Buffer {
    const h = Buffer.from(`${JSON.stringify(head)}\n`);
    return body?.length ? Buffer.concat([h, body]) : h;
}

function unpack(b: Buffer): { head: FromExt; body: Buffer } {
    const i = b.indexOf(10);
    return {
        head: JSON.parse(b.subarray(0, i).toString("utf8")) as FromExt,
        body: b.subarray(i + 1),
    };
}

type Reply = mockttp.requestSteps.CallbackResponseMessageResult;
type WS = ServerWebSocket<undefined>;

interface Pending {
    id: string;
    method: string;
    chunks: Buffer[];
    size: number;
    seen: number;
    resolve: (reply: Reply) => void;
}

let current: WS | undefined;
const pending = new Map<string, Pending>();

function textReply(statusCode: number, message: string): Reply {
    const rawBody = Buffer.from(`chrome-bridge: ${message}\n`);
    return {
        statusCode,
        headers: {
            "content-type": "text/plain; charset=utf-8",
            "content-length": String(rawBody.length),
        },
        rawBody,
    };
}

function send(head: ToExt, body?: Uint8Array) {
    current?.send(pack(head, body));
}

function finish(p: Pending, reply: Reply) {
    pending.delete(p.id);
    p.resolve(reply);
}

function fail(id: string, why: string, code: number) {
    const p = pending.get(id);
    if (!p) return;
    send({ t: "cancel", id });
    finish(p, textReply(code, why));
}

function failAll(why: string, code: number) {
    for (const id of pending.keys()) fail(id, why, code);
}

setInterval(() => {
    const now = Date.now();
    for (const p of pending.values()) {
        if (now - p.seen > TIMEOUT_MS) fail(p.id, "扩展响应超时", 504);
    }
}, 1000);

const HOP_BY_HOP = new Set([
    "connection",
    "keep-alive",
    "transfer-encoding",
    "te",
    "trailer",
    "upgrade",
]);

function forwardable(raw: [string, string][]): [string, string][] {
    const drop = new Set(HOP_BY_HOP);
    for (const [k, v] of raw)
        if (k.toLowerCase() === "connection")
            for (const n of v.split(",")) drop.add(n.trim().toLowerCase());
    return raw.filter(([k]) => {
        const n = k.toLowerCase();
        return (
            !drop.has(n) &&
            !n.startsWith("proxy-") &&
            !n.startsWith("x-bridge-") &&
            !n.startsWith(":")
        );
    });
}

const NO_BODY_STATUS = new Set([204, 205, 304]);

function complete(p: Pending, status: number, pairs: [string, string][]) {
    const out = forwardable(pairs).filter(([k]) => {
        const n = k.toLowerCase();
        return n !== "content-length" && n !== "content-encoding";
    });

    // mockttp 会删除默认 framing 头，必须显式写回 content-length。
    if (!NO_BODY_STATUS.has(status)) {
        const length =
            p.method === "HEAD" ? findRawHeader(pairs, "content-length")?.[1] : String(p.size);
        if (length) out.push(["content-length", length]);
    }

    const rawBody = p.chunks.length === 1 ? p.chunks[0] : Buffer.concat(p.chunks, p.size);

    finish(p, {
        statusCode: status,
        headers: rawHeadersToObject(out),
        rawBody,
    });
}

function onFrame(head: FromExt, body: Buffer) {
    const p = pending.get(head.id);
    if (!p) return;

    if (head.t === "end") {
        return "msg" in head
            ? finish(p, textReply(502, head.msg))
            : complete(p, head.status, head.headers);
    }

    p.size += body.length;
    p.chunks.push(body);
    p.seen = Date.now();
}

function viaChrome(req: mockttp.CompletedRequest): mockttp.MaybePromise<Reply> {
    if (current?.readyState !== WebSocket.OPEN) return textReply(502, "Chrome 扩展未连接");

    const body = req.body.buffer;

    return new Promise<Reply>((resolve) => {
        const p: Pending = {
            id: req.id,
            method: req.method,
            chunks: [],
            size: 0,
            seen: Date.now(),
            resolve,
        };
        pending.set(req.id, p);
        const head: ToExt = {
            t: "req",
            id: req.id,
            method: req.method,
            url: req.url,
            headers: forwardable(req.rawHeaders),
        };
        send(head, body);
    });
}

const wsServer = Bun.serve({
    hostname: wsUrl.hostname,
    port: Number(wsUrl.port),
    fetch(req, server) {
        if (server.upgrade(req)) return;
        return new Response("websocket only\n", { status: 426 });
    },
    websocket: {
        maxPayloadLength: 2 ** 31 - 1,
        perMessageDeflate: false,
        idleTimeout: 120,
        open(ws: WS) {
            if (current) {
                failAll("扩展连接被替换", 502);
                current.close(1000, "replaced");
            }
            current = ws;
            console.log("[ws]    Chrome 扩展已连接");
        },
        message(ws: WS, message: string | Buffer) {
            if (ws !== current || typeof message === "string") return;
            const frame = unpack(message);
            onFrame(frame.head, frame.body);
        },
        close(ws: WS) {
            if (ws !== current) return;
            current = undefined;
            console.log("[ws]    Chrome 扩展已断开");
            failAll("Chrome 扩展已断开", 502);
        },
    },
});

async function ensureCA(dir: string) {
    const keyPath = join(dir, "ca.key");
    const certPath = join(dir, "ca.pem");
    if (!existsSync(keyPath) || !existsSync(certPath)) {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        const { key, cert } = await mockttp.generateCACertificate({
            subject: {
                commonName: "Chrome Bridge CA",
                organizationName: "chrome-bridge",
            },
        });
        writeFileSync(keyPath, key, { mode: 0o600 });
        writeFileSync(certPath, cert, { mode: 0o644 });
        console.log(`[ca]    已重新生成 CA：${certPath}（需要加入信任）`);
    }
    return { keyPath, certPath };
}

const { keyPath, certPath } = await ensureCA(caDir);

const server = mockttp.getLocal({
    https: {
        keyPath,
        certPath,
        tlsPassthrough: passthrough.map((hostname) => ({ hostname })),
    },
    socks: true,
    passthrough: ["unknown-protocol"],
    http2: false,
    recordTraffic: false,
    suggestChanges: false,
});

await server.forAnyWebSocket().thenPassThrough();
await server
    .forAnyRequest()
    .matching((req) => !!isLocalhostAddress(req.destination.hostname))
    .always()
    .thenPassThrough();
await server.forUnmatchedRequest().thenCallback(viaChrome);

await server.on("abort", (req) => fail(req.id, "客户端已断开", 499));

await server.start(port);

console.log(
    `[proxy] 监听 :${server.port}（HTTP / HTTPS CONNECT / SOCKS5），HTTP(S) 交给 Chrome，本地地址直连`,
);
console.log(`[ws]    等待扩展连接 ws://${wsUrl.hostname}:${wsServer.port}`);
console.log(`[ca]    ${certPath}`);

async function shutdown() {
    failAll("bridge 正在关闭", 503);
    await server.stop();
    wsServer.stop(true);
    process.exit();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

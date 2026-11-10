// ================================================================ ① 扩展通道
const WS_URL = "ws://127.0.0.1:8765";
let ws;
const inflight = new Map();
const decoder = new TextDecoder();

function send(head, body = "") {
    if (ws?.readyState !== WebSocket.OPEN) return;
    ws.send(new Blob([JSON.stringify(head), "\n", body]));
}

function onMessage(data) {
    const bytes = new Uint8Array(data);
    const separator = bytes.indexOf(10);
    const head = JSON.parse(decoder.decode(bytes.subarray(0, separator)));
    if (head.t === "req") handle(head, bytes.subarray(separator + 1));
    else inflight.get(head.id)?.abort();
}

function connect() {
    ws = new WebSocket(WS_URL);
    ws.binaryType = "arraybuffer";
    ws.onopen = () => console.log("[bridge] connected");
    ws.onmessage = ({ data }) => onMessage(data);
    ws.onclose = () => {
        console.warn("[bridge] closed, retry in 1s");
        for (const controller of inflight.values()) controller.abort();
        setTimeout(connect, 1000);
    };
}

setInterval(() => {
    if (ws?.readyState === WebSocket.OPEN) ws.send("ping");
}, 20_000);

connect();

// ================================================================ ② Cookie 桥接
async function applyCookies(url, cookieHeader) {
    if (new URL(url).origin !== "https://mirrors.ustc.edu.cn") return;

    for (const cookie of cookieHeader?.split(";") ?? []) {
        const i = cookie.indexOf("=");
        await chrome.cookies.set({
            url,
            name: cookie.slice(0, i).trim(),
            value: cookie.slice(i + 1).trim(),
            path: "/",
            secure: true,
        });
    }
}

async function cookieHeaders(url) {
    return (await chrome.cookies.getAll({ url })).map((c) => [
        "set-cookie",
        [
            `${c.name}=${c.value}`,
            !c.hostOnly && `Domain=${c.domain}`,
            `Path=${c.path}`,
            c.secure && "Secure",
            c.httpOnly && "HttpOnly",
            c.expirationDate &&
                `Expires=${new Date(c.expirationDate * 1000).toUTCString()}`,
        ]
            .filter(Boolean)
            .join("; "),
    ]);
}

// ================================================================ ③ 请求转发
async function handle(req, body) {
    const controller = new AbortController();
    inflight.set(req.id, controller);
    try {
        const canRedirect = req.method === "GET" || req.method === "HEAD";
        await applyCookies(req.url, new Headers(req.headers).get("cookie"));

        const response = await fetch(req.url, {
            method: req.method,
            headers: req.headers,
            body: canRedirect ? undefined : body,
            credentials: "include",
            cache: "no-store",
            signal: controller.signal,
        });

        if (response.redirected && canRedirect) {
            send({
                t: "end",
                id: req.id,
                status: 302,
                headers: [["location", response.url]],
            });
            await response.body?.cancel();
            return;
        }

        for await (const chunk of response.body ?? []) {
            send({ t: "data", id: req.id }, chunk);
        }
        send({
            t: "end",
            id: req.id,
            status: response.status,
            headers: [
                ...response.headers,
                ...(await cookieHeaders(response.url)),
            ],
        });
    } catch (error) {
        if (!controller.signal.aborted)
            send({ t: "end", id: req.id, msg: String(error) });
    } finally {
        inflight.delete(req.id);
    }
}

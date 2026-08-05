const { spawn } = require("node:child_process");
const {
  createSanitizedChildEnv,
  createSpawnSpec,
  isExecutableUnavailableError,
  resolveCodexCandidates
} = require("./quota-service");

const REQUEST_TIMEOUT_MS = 20_000;
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_BUFFER_BYTES = 4 * 1024 * 1024;

function validateOfficialAuthUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Codex 返回了无效的登录地址");
  }
  const host = url.hostname.toLowerCase();
  const officialHost = host === "chatgpt.com" || host.endsWith(".chatgpt.com") ||
    host === "openai.com" || host.endsWith(".openai.com");
  if (url.protocol !== "https:" || !officialHost) throw new Error("Codex 返回的登录地址不是 OpenAI 官方 HTTPS 地址");
  return url.toString();
}

async function loginWithChatGPT({
  candidates = resolveCodexCandidates(),
  codexHome,
  openExternal,
  requester = loginWithChatGPTFrom
} = {}) {
  if (!codexHome) throw new Error("缺少登录 Profile 目录");
  if (typeof openExternal !== "function") throw new Error("缺少打开官方登录页的方法");
  const failures = [];
  for (const candidate of candidates) {
    try {
      return await requester(candidate, { codexHome, openExternal });
    } catch (error) {
      failures.push(error?.message || String(error));
      if (!isExecutableUnavailableError(error)) throw error;
    }
  }
  throw new Error(failures.at(-1) || "未找到可用的 Codex 程序");
}

function loginWithChatGPTFrom(candidate, {
  codexHome,
  openExternal,
  spawnImpl = spawn,
  requestTimeoutMs = REQUEST_TIMEOUT_MS,
  loginTimeoutMs = LOGIN_TIMEOUT_MS,
  maxBufferBytes = MAX_BUFFER_BYTES
} = {}) {
  const spec = createSpawnSpec(candidate);
  const child = spawnImpl(spec.command, spec.args, {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    env: createSanitizedChildEnv({ ...process.env, CODEX_HOME: codexHome })
  });
  let nextId = 1;
  let buffer = "";
  let stderr = "";
  let closed = false;
  let fatalError = null;
  const pending = new Map();
  const notificationBacklog = [];
  const notificationWaiters = new Set();

  const failAll = (error) => {
    if (closed) return;
    fatalError = fatalError || error;
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    pending.clear();
    for (const waiter of notificationWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    notificationWaiters.clear();
  };

  const cleanup = () => {
    if (closed) return;
    failAll(new Error("Codex 登录会话已结束"));
    closed = true;
    try { if (!child.killed) child.kill(); } catch {}
  };

  const send = (method, params) => {
    if (closed || fatalError) return Promise.reject(fatalError || new Error("Codex 登录会话已结束"));
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        const error = new Error(`Codex 请求超时：${method}`);
        error.code = "ETIMEDOUT";
        reject(error);
      }, requestTimeoutMs);
      pending.set(id, { resolve, reject, timer });
      const message = params === undefined ? { id, method } : { id, method, params };
      child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
        if (!error) return;
        clearTimeout(timer);
        pending.delete(id);
        reject(error);
      });
    });
  };

  const waitForNotification = (method, predicate = () => true) => {
    if (closed || fatalError) return Promise.reject(fatalError || new Error("Codex 登录会话已结束"));
    const existingIndex = notificationBacklog.findIndex((message) => message.method === method && predicate(message.params || {}));
    if (existingIndex >= 0) return Promise.resolve(notificationBacklog.splice(existingIndex, 1)[0].params || {});
    return new Promise((resolve, reject) => {
      const waiter = { method, predicate, resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        notificationWaiters.delete(waiter);
        const error = new Error("等待官方登录完成超时");
        error.code = "ETIMEDOUT";
        reject(error);
      }, loginTimeoutMs);
      notificationWaiters.add(waiter);
    });
  };

  const handleMessage = (message) => {
    if (Object.prototype.hasOwnProperty.call(message, "id")) {
      const request = pending.get(message.id);
      if (!request) return;
      clearTimeout(request.timer);
      pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error.message || JSON.stringify(message.error)));
      else request.resolve(message.result);
      return;
    }
    if (!message.method) return;
    for (const waiter of notificationWaiters) {
      if (waiter.method !== message.method || !waiter.predicate(message.params || {})) continue;
      clearTimeout(waiter.timer);
      notificationWaiters.delete(waiter);
      waiter.resolve(message.params || {});
      return;
    }
    notificationBacklog.push(message);
    if (notificationBacklog.length > 32) notificationBacklog.shift();
  };

  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    if (Buffer.byteLength(buffer, "utf8") > maxBufferBytes) {
      const error = new Error("Codex 登录输出超过安全上限");
      error.code = "EOVERFLOW";
      failAll(error);
      return;
    }
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      try { handleMessage(JSON.parse(line)); } catch {}
    }
  });
  child.stderr.on("data", (chunk) => { stderr = (stderr + chunk.toString("utf8")).slice(-8192); });
  child.once("error", (error) => failAll(error));
  child.once("exit", (code) => failAll(new Error(stderr || `Codex 登录进程退出，代码 ${code}`)));
  child.stdin.on("error", (error) => failAll(error));
  child.stdout.on("error", (error) => failAll(error));
  child.stderr.on("error", (error) => failAll(error));

  return (async () => {
    let loginId = null;
    try {
      await send("initialize", {
        clientInfo: { name: "chatgpt-plus-plus", title: "ChatGPT++", version: "1.5.1" },
        capabilities: null
      });
      const started = await send("account/login/start", {
        type: "chatgpt",
        useHostedLoginSuccessPage: true,
        appBrand: "chatgpt"
      });
      loginId = started?.loginId || null;
      if (!loginId) throw new Error("Codex 未返回登录会话 ID");
      const authUrl = validateOfficialAuthUrl(started?.authUrl);
      try {
        await openExternal(authUrl);
      } catch (error) {
        await send("account/login/cancel", { loginId }).catch(() => {});
        throw new Error(`无法打开官方登录页面：${error?.message || error}`);
      }
      const completionPromise = waitForNotification("account/login/completed", (params) => params.loginId === loginId);
      const completion = await completionPromise;
      if (!completion.success) throw new Error(completion.error || "官方登录未完成");
      const accountResult = await send("account/read", { refreshToken: true });
      return { loginId, authUrl, account: accountResult?.account || null };
    } finally {
      cleanup();
    }
  })();
}

module.exports = { loginWithChatGPT, loginWithChatGPTFrom, validateOfficialAuthUrl };

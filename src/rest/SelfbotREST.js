'use strict';

const { REST, DefaultRestOptions } = require('@discordjs/rest');
const { Agent, ProxyAgent, buildConnector } = require('undici');
const {
  DefaultUserAgent,
  DefaultSecChUa,
  DefaultSuperProperties,
  DefaultCiphers,
  encodeSuperProperties,
} = require('../util/SelfbotDefaults');

/**
 * Header tĩnh mà Discord web client luôn gửi. Thiếu bộ này thì request
 * lộ ra là không phải browser.
 * @param {Object} clientOptions Options của client
 * @returns {Object<string, string>}
 */
function buildSelfbotHeaders(clientOptions) {
  // Fallback vì user có thể truyền `ws` partial.
  const properties = clientOptions.ws?.properties ?? DefaultSuperProperties;
  const userAgent = properties.browser_user_agent ?? DefaultUserAgent;

  return {
    accept: '*/*',
    'accept-language': 'en-US,en;q=0.9',
    origin: 'https://discord.com',
    priority: 'u=1, i',
    referer: 'https://discord.com/channels/@me',
    'sec-ch-ua': DefaultSecChUa,
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
    'user-agent': userAgent,
    'x-debug-options': 'bugReporterEnabled',
    'x-discord-locale': 'en-US',
    'x-discord-timezone': Intl.DateTimeFormat().resolvedOptions().timeZone,
    'x-super-properties': encodeSuperProperties(properties),
    ...withoutAuthorization(clientOptions.http?.headers),
  };
}

/**
 * Bỏ header Authorization khỏi header của người dùng.
 *
 * Token chỉ được đến từ `client.login()`. Để `http.headers` đặt được header này
 * thì một config dựng từ dữ liệu ngoài sẽ gửi request bằng token của người khác.
 * @param {?Object<string, string>} headers Header người dùng truyền
 * @returns {Object<string, string>}
 */
function withoutAuthorization(headers) {
  return Object.fromEntries(Object.entries(headers ?? {}).filter(([key]) => key.toLowerCase() !== 'authorization'));
}

/**
 * `@discordjs/rest` luôn ghép `${authPrefix} ${token}` vào header Authorization.
 * User token gửi trần, không prefix. Sửa tại chỗ trước khi request đi.
 * @param {Object} headers Header của request
 * @param {string} token Token trần
 * @returns {Object} chính object headers đã sửa
 */
function rewriteAuthorization(headers, token) {
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === 'authorization') headers[key] = token;
  }
  return headers;
}

/**
 * Ép `User-Agent` về đúng một dòng, mang giá trị của browser.
 *
 * `@discordjs/rest` tự thêm `User-Agent: DiscordBot (...)` của nó **sau** các
 * header truyền vào. Key viết hoa khác key `user-agent` viết thường của
 * {@link buildSelfbotHeaders}, nên object giữ cả hai và undici gửi đi hai dòng —
 * Discord lấy dòng sau, thành ra mọi request đều lộ ra là bot. Có endpoint chỉ
 * dành cho client thật sẽ im lặng trả `204` rỗng thay vì làm việc, ví dụ
 * `POST /users/@me/invites`.
 * @param {Object} headers Header của request
 * @param {string} userAgent User agent của browser
 * @returns {Object} chính object headers đã sửa
 */
function rewriteUserAgent(headers, userAgent) {
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === 'user-agent') delete headers[key];
  }

  headers['user-agent'] = userAgent;
  return headers;
}

/**
 * Removes the `Origin` header. A browser omits it on same-origin GET requests, so sending it there marks
 * the request as scripted.
 * @param {Object} headers Header của request
 * @returns {Object} chính object headers đã sửa
 */
function removeOrigin(headers) {
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === 'origin') delete headers[key];
  }
  return headers;
}

/**
 * `@discordjs/ws` gọi `GET /gateway/bot` để lấy gateway URL và session limit.
 * User token bị 401 ở route đó, nên trả response tự dựng thay vì gọi mạng.
 * Shape phải khớp `RESTGetAPIGatewayBotResult`.
 * @returns {Object} object giống Response đủ cho @discordjs/rest parse
 */
function makeGatewayBotResponse() {
  const body = JSON.stringify({
    url: 'wss://gateway.discord.gg',
    shards: 1,
    session_start_limit: {
      total: 1000,
      remaining: 1000,
      reset_after: 0,
      max_concurrency: 1,
    },
  });

  // Shape phải khớp `ResponseLike` của @discordjs/rest
  // (packages/rest/src/strategies/undiciRequest.ts).
  return {
    body: null,
    bodyUsed: false,
    status: 200,
    statusText: 'OK',
    ok: true,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => JSON.parse(body),
    text: async () => body,
    arrayBuffer: async () => new TextEncoder().encode(body).buffer,
  };
}

/**
 * Dispatcher undici có TLS fingerprint giống Chrome, hoặc proxy nếu được cấu hình.
 * @param {Object} clientOptions Options của client
 * @returns {Dispatcher}
 */
function buildDispatcher(clientOptions) {
  const proxy = clientOptions.http?.agent;
  const ciphers = DefaultCiphers.join(':');

  if (proxy) {
    return new ProxyAgent({ ...(typeof proxy === 'string' ? { uri: proxy } : proxy), ciphers });
  }

  // Agent chứ không phải Client: Client chỉ phục vụ một origin, Agent dùng
  // được cho mọi host mà REST có thể chạm tới.
  return new Agent({ connect: buildConnector({ ciphers }) });
}

/**
 * Đọc hết body rồi dựng lại một `ResponseLike` phát lại được.
 *
 * Cần vì muốn biết có phải lỗi captcha không thì phải đọc body, mà đọc là tiêu
 * luôn stream — `@discordjs/rest` ở tầng trên sẽ không còn gì để đọc.
 * @param {Object} response Response gốc
 * @returns {Promise<Object>} Response đọc lại được nhiều lần
 */
async function bufferResponse(response) {
  const text = await response.text();

  return {
    body: null,
    bodyUsed: false,
    status: response.status,
    statusText: response.statusText,
    ok: response.ok,
    headers: response.headers,
    text: async () => text,
    json: async () => JSON.parse(text),
    arrayBuffer: async () => new TextEncoder().encode(text).buffer,
  };
}

/**
 * Bóc thông tin captcha từ body lỗi, `null` nếu đây không phải lỗi captcha.
 * @param {string} text Body dạng chuỗi
 * @returns {?Object}
 */
function parseCaptchaError(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }

  if (!data?.captcha_sitekey && !data?.captcha_key) return null;
  return data;
}

/**
 * Tạo instance REST đã gắn shim selfbot.
 * @param {Object} clientOptions Options của client (đã merge default)
 * @returns {REST}
 */
function createSelfbotREST(clientOptions) {
  const dispatcher = buildDispatcher(clientOptions);
  const headers = buildSelfbotHeaders(clientOptions);
  const userAgent = headers['user-agent'];
  // Token phải lấy tại thời điểm request, không phải lúc tạo REST.
  let token = null;

  const rest = new REST({
    ...clientOptions.rest,
    headers,
    makeRequest: async (url, init) => {
      if (new URL(url).pathname.endsWith('/gateway/bot')) {
        return makeGatewayBotResponse();
      }
      if (token) rewriteAuthorization(init.headers, token);
      rewriteUserAgent(init.headers, userAgent);
      // Chrome sends Origin only where the fetch spec asks for it, never on a same-origin GET.
      if (init.method === undefined || init.method.toUpperCase() === 'GET') removeOrigin(init.headers);

      const send = requestInit => DefaultRestOptions.makeRequest(url, { ...requestInit, dispatcher });

      let response = await send(init);
      if (response.status !== 400 || !clientOptions.captchaSolver) return response;

      // Chỉ lỗi 400 mới có thể là captcha, nên chỉ đọc lại body ở nhánh này.
      response = await bufferResponse(response);

      let currentInit = init;
      for (let attempt = 0; attempt < clientOptions.captchaRetryLimit; attempt += 1) {
        const captcha = parseCaptchaError(await response.text());
        if (!captcha) return response;

        const solution = await clientOptions.captchaSolver(captcha, currentInit.headers['user-agent']);

        currentInit = {
          ...currentInit,
          headers: {
            ...currentInit.headers,
            'x-captcha-key': solution,
            ...(captcha.captcha_rqtoken ? { 'x-captcha-rqtoken': captcha.captcha_rqtoken } : {}),
          },
        };

        const retried = await send(currentInit);
        if (retried.status !== 400) return retried;
        response = await bufferResponse(retried);
      }

      return response;
    },
  });

  const originalSetToken = rest.setToken.bind(rest);
  rest.setToken = value => {
    token = value;
    return originalSetToken(value);
  };

  return rest;
}

module.exports = {
  createSelfbotREST,
  bufferResponse,
  parseCaptchaError,
  buildSelfbotHeaders,
  rewriteAuthorization,
  rewriteUserAgent,
  removeOrigin,
  buildDispatcher,
  makeGatewayBotResponse,
};

import { defineConfig, loadEnv } from 'vite';
import {
  handleComputeRoutes,
  handleRatesRequest,
  handleReverseGeocode,
  handleStatusRequest,
} from './server/routesHandler.js';
import {
  handleDriveCallback,
  handleDriveLogin,
  handleDriveLogout,
  handleDrivePull,
  handleDrivePush,
  handleDriveStatus,
} from './server/driveHandler.js';

function readJsonBody(req, maxBytes = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (Buffer.byteLength(raw, 'utf8') > maxBytes) {
        reject(new Error('PAYLOAD_TOO_LARGE'));
      }
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function sendDriveResult(res, result) {
  res.setHeader('Cache-Control', 'no-store');
  if (Array.isArray(result.cookies) && result.cookies.length > 0) {
    res.setHeader('Set-Cookie', result.cookies);
  }
  if (result.redirectUrl) {
    res.statusCode = result.statusCode || 302;
    res.setHeader('Location', result.redirectUrl);
    res.end();
    return;
  }
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.statusCode = result.statusCode || 200;
  res.end(JSON.stringify(result.body));
}

function createRoutesApiPlugin(env) {
  const attachMiddleware = (middlewares) => {
    middlewares.use(async (req, res, next) => {
      const fullUrl = req.url || '';
      const parsedUrl = new URL(fullUrl, 'http://localhost');
      const urlPath = parsedUrl.pathname;

      if (urlPath === '/api/drive-callback') {
        if (req.method !== 'GET') {
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.statusCode = 405;
          res.end(JSON.stringify({ error: 'METHOD_NOT_ALLOWED', message: '僅支援 GET 回呼請求' }));
          return;
        }
        const result = await handleDriveCallback({
          query: {
            code: parsedUrl.searchParams.get('code') || '',
            state: parsedUrl.searchParams.get('state') || '',
            error: parsedUrl.searchParams.get('error') || '',
          },
          headers: req.headers,
          env,
        });
        sendDriveResult(res, result);
        return;
      }

      if (urlPath === '/api/drive') {
        const action = parsedUrl.searchParams.get('action') || '';
        if (req.method === 'GET') {
          if (action === 'login') {
            sendDriveResult(res, handleDriveLogin({ headers: req.headers, env }));
            return;
          }
          if (action === 'pull') {
            sendDriveResult(res, await handleDrivePull({ headers: req.headers, env }));
            return;
          }
          sendDriveResult(res, handleDriveStatus({ headers: req.headers, env }));
          return;
        }
        if (req.method !== 'POST') {
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.statusCode = 405;
          res.end(JSON.stringify({ error: 'METHOD_NOT_ALLOWED', message: '僅支援 GET / POST 請求' }));
          return;
        }
        if (action === 'logout') {
          sendDriveResult(res, handleDriveLogout({ headers: req.headers }));
          return;
        }
        if (action === 'push') {
          try {
            const body = await readJsonBody(req, 4 * 1024 * 1024);
            sendDriveResult(res, await handleDrivePush({ body, headers: req.headers, env }));
          } catch (err) {
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.statusCode = err?.message === 'PAYLOAD_TOO_LARGE' ? 413 : 400;
            res.end(
              JSON.stringify({
                error: err?.message === 'PAYLOAD_TOO_LARGE' ? 'PAYLOAD_TOO_LARGE' : 'INVALID_JSON',
                message: err?.message === 'PAYLOAD_TOO_LARGE' ? '行程內容過大，請減少照片後重試' : '無法解析 JSON 請求內容',
              })
            );
          }
          return;
        }
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.statusCode = 400;
        res.end(JSON.stringify({ error: 'UNKNOWN_ACTION', message: '不支援的操作類型' }));
        return;
      }

      if (urlPath !== '/api/routes' && urlPath !== '/api/routes/status') {
        return next();
      }

      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');

      if (req.method === 'GET') {
        const wantsReverse = /[?&](reverse=1|action=reverse)\b/.test(fullUrl);
        if (wantsReverse) {
          const lat = parsedUrl.searchParams.get('lat');
          const lng = parsedUrl.searchParams.get('lng');
          const result = await handleReverseGeocode(lat, lng, env);
          res.statusCode = result.statusCode;
          res.end(JSON.stringify(result.body));
          return;
        }
        const wantsRates = /[?&](rates=1|action=rates)\b/.test(fullUrl);
        if (wantsRates) {
          const result = await handleRatesRequest();
          res.statusCode = result.statusCode;
          res.end(JSON.stringify(result.body));
          return;
        }
        const result = handleStatusRequest(env);
        res.statusCode = result.statusCode;
        res.end(JSON.stringify(result.body));
        return;
      }

      if (req.method !== 'POST') {
        res.statusCode = 405;
        res.end(JSON.stringify({ error: 'METHOD_NOT_ALLOWED', message: '僅支援 GET / POST 請求' }));
        return;
      }

      try {
        const body = await readJsonBody(req);
        const result = await handleComputeRoutes(body, env);
        res.statusCode = result.statusCode;
        res.end(JSON.stringify(result.body));
      } catch (err) {
        res.statusCode = 400;
        res.end(
          JSON.stringify({
            error: 'INVALID_JSON',
            message: err?.message === 'PAYLOAD_TOO_LARGE' ? '請求內容過大' : '無法解析 JSON 請求內容',
          })
        );
      }
    });
  };

  return {
    name: 'tripcanvas-routes-api-proxy',
    configureServer(server) {
      attachMiddleware(server.middlewares);
    },
    configurePreviewServer(server) {
      attachMiddleware(server.middlewares);
    },
  };
}

export default defineConfig(({ mode }) => {
  // 載入 .env / .env.local 中的非 VITE_ 伺服器環境變數（包含 API 金鑰與 Google OAuth 憑證，絕不注入前端 bundle）
  const env = loadEnv(mode, process.cwd(), '');
  return {
    plugins: [createRoutesApiPlugin(env)],
    server: {
      port: 5173,
      strictPort: false,
      allowedHosts: true,
    },
  };
});

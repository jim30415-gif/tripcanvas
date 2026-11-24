import { defineConfig, loadEnv } from 'vite';
import { handleComputeRoutes, handleStatusRequest } from './server/routesHandler.js';

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 256 * 1024) {
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

function createRoutesApiPlugin(env) {
  const attachMiddleware = (middlewares) => {
    middlewares.use(async (req, res, next) => {
      const urlPath = (req.url || '').split('?')[0];
      if (urlPath !== '/api/routes' && urlPath !== '/api/routes/status') {
        return next();
      }

      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');

      if (req.method === 'GET') {
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
  // 載入 .env / .env.local 中的非 VITE_ 伺服器環境變數（包含 GOOGLE_MAPS_API_KEY，絕不注入前端 bundle）
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

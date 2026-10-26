// BOGA LAMPS admin: local-only server for products, orders and settings.
// Run `node admin.mjs` and open http://localhost:3001. It listens on 127.0.0.1 only.
import { createServer } from 'node:http';
import { readFile, writeFile, rename, mkdir, readdir, unlink } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)));
const port = Number(process.env.ADMIN_PORT) || 3001;
const dataDir = join(root, 'data');
const uploadDir = join(root, 'images', 'products');
const allowedOrigins = [`http://localhost:${port}`, `http://127.0.0.1:${port}`];

const files = {
  products: join(dataDir, 'products.json'),
  orders: join(dataDir, 'orders.json'),
  settings: join(dataDir, 'settings.json'),
};
const defaults = {
  products: [],
  orders: [],
  settings: { whatsappNumber: '524446000621', showPrices: false },
};

const types = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};
const imageTypes = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' };

const COLLECTIONS = ['interior', 'exterior', 'decoracion'];
const ORDER_STATUSES = ['nuevo', 'pagado', 'preparando', 'enviado', 'entregado', 'cancelado'];
const PAYMENT_STATUSES = ['pendiente', 'pagado', 'reembolsado'];

// ---------- Storage ----------
async function load(name) {
  try {
    return JSON.parse(await readFile(files[name], 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return structuredClone(defaults[name]);
    throw err;
  }
}

async function save(name, value) {
  await mkdir(dataDir, { recursive: true });
  const tmp = `${files[name]}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2) + '\n');
  await rename(tmp, files[name]);
}

// Delete uploaded photos that no product uses anymore, so they don't pile up in the repo.
async function pruneUploads(products) {
  const used = new Set(products.flatMap((p) => p.images));
  let names = [];
  try { names = await readdir(uploadDir); } catch { return; }
  await Promise.all(names
    .filter((name) => !used.has(`images/products/${name}`))
    .map((name) => unlink(join(uploadDir, name)).catch(() => {})));
}

// ---------- Validation ----------
const str = (v, max = 500) => String(v ?? '').trim().slice(0, max);
const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : 0;
};
const isLocalImage = (p) => /^(images\/products|brand_assets)\/[^/]+$/.test(p) && !p.includes('..');

function cleanProduct(input) {
  return {
    name: str(input.name, 120),
    sku: str(input.sku, 60),
    category: str(input.category, 80),
    collection: COLLECTIONS.includes(input.collection) ? input.collection : 'interior',
    price: num(input.price),
    stock: Math.floor(num(input.stock)),
    badge: str(input.badge, 40),
    description: str(input.description, 2000),
    tags: (Array.isArray(input.tags) ? input.tags : []).map((t) => str(t, 40)).filter(Boolean).slice(0, 8),
    images: (Array.isArray(input.images) ? input.images : []).map((p) => str(p, 300)).filter(isLocalImage).slice(0, 12),
    imageAlt: str(input.imageAlt, 200),
    imageFit: input.imageFit === 'contain' ? 'contain' : 'cover',
    featured: Boolean(input.featured),
    published: input.published !== false,
  };
}

function cleanOrder(input) {
  const customer = input.customer || {};
  const address = input.address || {};
  return {
    status: ORDER_STATUSES.includes(input.status) ? input.status : 'nuevo',
    customer: {
      name: str(customer.name, 120),
      phone: str(customer.phone, 30),
      email: str(customer.email, 120),
    },
    address: {
      street: str(address.street, 200),
      city: str(address.city, 80),
      state: str(address.state, 80),
      zip: str(address.zip, 10),
      references: str(address.references, 300),
    },
    items: (Array.isArray(input.items) ? input.items : [])
      .map((item) => ({
        productId: str(item.productId, 40),
        name: str(item.name, 120),
        qty: Math.max(1, Math.floor(num(item.qty))),
        price: num(item.price),
      }))
      .filter((item) => item.name)
      .slice(0, 50),
    shippingCost: num(input.shippingCost),
    paymentMethod: str(input.paymentMethod, 40),
    paymentStatus: PAYMENT_STATUSES.includes(input.paymentStatus) ? input.paymentStatus : 'pendiente',
    carrier: str(input.carrier, 60),
    trackingNumber: str(input.trackingNumber, 80),
    notes: str(input.notes, 2000),
  };
}

// ---------- HTTP helpers ----------
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function readBody(req, limit) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new HttpError(413, 'El archivo es demasiado grande. El máximo es 15 MB.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolveBody(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  try {
    return JSON.parse((await readBody(req, 1_000_000)).toString('utf8') || '{}');
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(400, 'Los datos enviados no son válidos.');
  }
}

function send(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}

const newId = (prefix) => `${prefix}_${randomBytes(4).toString('hex')}`;

// ---------- API ----------
async function api(req, res, url) {
  // Block other websites from calling this API through the browser.
  if (req.method !== 'GET') {
    const origin = req.headers.origin;
    if (origin && !allowedOrigins.includes(origin)) throw new HttpError(403, 'Origen no permitido.');
    if (req.headers['x-boga-admin'] !== '1') throw new HttpError(403, 'Solicitud no permitida.');
  }

  const [, , resource, id] = url.pathname.split('/');

  if (resource === 'products') {
    const products = await load('products');
    if (req.method === 'GET' && !id) return send(res, 200, products);
    if (req.method === 'POST' && !id) {
      const product = { id: newId('p'), ...cleanProduct(await readJson(req)), updatedAt: new Date().toISOString() };
      if (!product.name) throw new HttpError(400, 'Escribe el nombre del producto.');
      products.push(product);
      await save('products', products);
      await pruneUploads(products);
      return send(res, 201, product);
    }
    const index = products.findIndex((p) => p.id === id);
    if (index === -1) throw new HttpError(404, 'Ese producto ya no existe.');
    if (req.method === 'PUT') {
      const product = { id, ...cleanProduct(await readJson(req)), updatedAt: new Date().toISOString() };
      if (!product.name) throw new HttpError(400, 'Escribe el nombre del producto.');
      products[index] = product;
      await save('products', products);
      await pruneUploads(products);
      return send(res, 200, product);
    }
    if (req.method === 'DELETE') {
      products.splice(index, 1);
      await save('products', products);
      await pruneUploads(products);
      return send(res, 200, { ok: true });
    }
  }

  if (resource === 'orders') {
    const orders = await load('orders');
    if (req.method === 'GET' && !id) return send(res, 200, orders);
    if (req.method === 'POST' && !id) {
      const next = orders.reduce((max, o) => Math.max(max, Number(o.id.split('-')[1]) || 0), 0) + 1;
      const now = new Date().toISOString();
      const order = { id: `BOGA-${String(next).padStart(4, '0')}`, createdAt: now, updatedAt: now, ...cleanOrder(await readJson(req)) };
      if (!order.customer.name) throw new HttpError(400, 'Escribe el nombre del cliente.');
      orders.push(order);
      await save('orders', orders);
      return send(res, 201, order);
    }
    const index = orders.findIndex((o) => o.id === id);
    if (index === -1) throw new HttpError(404, 'Ese pedido ya no existe.');
    if (req.method === 'PUT') {
      const order = { id, createdAt: orders[index].createdAt, updatedAt: new Date().toISOString(), ...cleanOrder(await readJson(req)) };
      if (!order.customer.name) throw new HttpError(400, 'Escribe el nombre del cliente.');
      orders[index] = order;
      await save('orders', orders);
      return send(res, 200, order);
    }
    if (req.method === 'DELETE') {
      orders.splice(index, 1);
      await save('orders', orders);
      return send(res, 200, { ok: true });
    }
  }

  if (resource === 'settings') {
    if (req.method === 'GET') return send(res, 200, await load('settings'));
    if (req.method === 'PUT') {
      const input = await readJson(req);
      const settings = {
        whatsappNumber: str(input.whatsappNumber, 20).replace(/\D/g, ''),
        showPrices: Boolean(input.showPrices),
      };
      await save('settings', settings);
      return send(res, 200, settings);
    }
  }

  if (resource === 'upload' && req.method === 'POST') {
    const ext = imageTypes[(req.headers['content-type'] || '').split(';')[0]];
    if (!ext) throw new HttpError(415, 'Sube la foto en formato JPG, PNG o WebP.');
    const body = await readBody(req, 15 * 1024 * 1024);
    const base = str(url.searchParams.get('name'), 60)
      .replace(/\.[^.]+$/, '')
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'foto';
    const filename = `${base}-${randomBytes(3).toString('hex')}${ext}`;
    await mkdir(uploadDir, { recursive: true });
    await writeFile(join(uploadDir, filename), body);
    return send(res, 201, { path: `images/products/${filename}` });
  }

  throw new HttpError(404, 'Ruta no encontrada.');
}

// ---------- Static files ----------
async function serveStatic(res, pathname) {
  const relative = normalize(pathname === '/' ? '/admin/index.html' : pathname);
  const filePath = join(root, relative);
  if (!filePath.startsWith(root)) throw new HttpError(403, 'Forbidden');
  const body = await readFile(filePath).catch(() => { throw new HttpError(404, 'Not found'); });
  res.writeHead(200, {
    'Content-Type': types[extname(filePath).toLowerCase()] || 'application/octet-stream',
    'Cache-Control': 'no-cache',
  });
  res.end(body);
}

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${port}`);
    const pathname = decodeURIComponent(url.pathname);
    if (pathname.startsWith('/api/')) await api(req, res, url);
    else await serveStatic(res, pathname);
  } catch (err) {
    const status = err.status || 500;
    if (status === 500) console.error(err);
    send(res, status, { error: status === 500 ? 'Algo falló en el servidor. Revisa la terminal.' : err.message });
  }
}).listen(port, '127.0.0.1', () => {
  console.log(`BOGA LAMPS admin: http://localhost:${port}`);
});

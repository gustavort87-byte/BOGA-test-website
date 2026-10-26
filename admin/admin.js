// BOGA LAMPS admin UI. Talks to admin.mjs at /api/*.
(function () {
  'use strict';

  const COLLECTIONS = { interior: 'Interior', exterior: 'Exterior', decoracion: 'Decoración' };
  const ORDER_STATUS = {
    nuevo: ['Nuevo', 'amber'],
    pagado: ['Pagado', 'olive'],
    preparando: ['Preparando', 'walnut'],
    enviado: ['Enviado', 'slate'],
    entregado: ['Entregado', 'plain'],
    cancelado: ['Cancelado', 'wine'],
  };
  const ACTIVE_STATUSES = ['nuevo', 'pagado', 'preparando', 'enviado'];
  const PAYMENT_STATUS = { pendiente: ['Pendiente', 'amber'], pagado: ['Pagado', 'olive'], reembolsado: ['Reembolsado', 'wine'] };
  const PAYMENT_METHODS = ['Transferencia', 'Efectivo', 'Tarjeta', 'Mercado Pago', 'OXXO', 'Otro'];
  const CARRIERS = ['DHL', 'Estafeta', 'FedEx', 'Paquetexpress', 'Redpack', '99minutos', 'Entrega local', 'Recoge en tienda', 'Otro'];

  const state = {
    products: [], orders: [], settings: {},
    productFilter: 'todos', productQuery: '',
    orderFilter: 'activos', orderQuery: '',
    customerQuery: '',
  };

  const $ = (sel, el = document) => el.querySelector(sel);
  const $$ = (sel, el = document) => Array.from(el.querySelectorAll(sel));
  const view = $('#view');
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' });
  const fmtMoney = (n) => money.format(n || 0);
  const fmtDate = (iso) => new Date(iso).toLocaleDateString('es-MX', { day: 'numeric', month: 'short', year: 'numeric' });
  const pill = ([label, tone]) => `<span class="pill pill-${tone}">${esc(label)}</span>`;
  const orderTotal = (o) => o.items.reduce((sum, i) => sum + i.qty * i.price, 0) + (o.shippingCost || 0);
  const waDigits = (phone) => {
    const d = String(phone || '').replace(/\D/g, '');
    return d.length === 10 ? '52' + d : d;
  };
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  // Number fields start empty instead of showing a 0 you have to delete first.
  const numValue = (n) => (n ? n : '');
  const options = (list, selected) => list.map((v) => `<option ${v === selected ? 'selected' : ''}>${esc(v)}</option>`).join('');
  const optionsMap = (map, selected) => Object.entries(map)
    .map(([value, label]) => `<option value="${value}" ${value === selected ? 'selected' : ''}>${esc(Array.isArray(label) ? label[0] : label)}</option>`).join('');

  // ---------- API ----------
  async function api(method, path, body) {
    const opts = { method, headers: { 'X-Boga-Admin': '1' } };
    if (body instanceof Blob) {
      opts.body = body;
      opts.headers['Content-Type'] = body.type || 'application/octet-stream';
    } else if (body !== undefined) {
      opts.body = JSON.stringify(body);
      opts.headers['Content-Type'] = 'application/json';
    }
    let res;
    try {
      res = await fetch('/api/' + path, opts);
    } catch {
      throw new Error('No hay conexión con el administrador. Revisa que `node admin.mjs` siga abierto.');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'No se pudo completar la acción.');
    return data;
  }

  // ---------- Toast ----------
  let toastTimer;
  function toast(message, isError) {
    const el = $('#toast');
    el.textContent = message;
    el.classList.toggle('error', Boolean(isError));
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), isError ? 5000 : 2600);
  }

  // ---------- Drawer ----------
  const drawer = $('#drawer');
  const scrim = $('#scrim');
  let onSubmit = null;
  let lastFocus = null;
  drawer.inert = true;

  function openDrawer(title, body, foot, submit) {
    lastFocus = document.activeElement;
    $('#drawer-title').textContent = title;
    $('#drawer-body').innerHTML = body;
    $('#drawer-foot').innerHTML = foot;
    $('#drawer-body').scrollTop = 0;
    onSubmit = submit;
    drawer.inert = false;
    drawer.setAttribute('aria-hidden', 'false');
    drawer.classList.add('open');
    scrim.classList.add('open');
    setTimeout(() => { const first = $('input:not([type=file]), select, textarea', drawer); if (first) first.focus(); }, 60);
  }

  function closeDrawer() {
    drawer.classList.remove('open');
    scrim.classList.remove('open');
    drawer.setAttribute('aria-hidden', 'true');
    drawer.inert = true;
    onSubmit = null;
    if (lastFocus) lastFocus.focus();
  }

  scrim.addEventListener('click', closeDrawer);
  drawer.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) closeDrawer(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && drawer.classList.contains('open')) closeDrawer(); });
  $('#drawer-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!onSubmit) return;
    const button = $('#drawer-foot button[type=submit]');
    if (button) button.disabled = true;
    try {
      await onSubmit(new FormData(e.target));
    } catch (err) {
      toast(err.message, true);
    } finally {
      if (button) button.disabled = false;
    }
  });

  // Make table rows open on click and on Enter.
  function bindRows(container, handler) {
    container.addEventListener('click', (e) => {
      if (e.target.closest('a, button')) return;
      const row = e.target.closest('tr[data-id]');
      if (row) handler(row.dataset.id);
    });
    container.addEventListener('keydown', (e) => {
      const row = e.target.closest('tr[data-id]');
      if (row && e.key === 'Enter') handler(row.dataset.id);
    });
  }

  // ======================================================
  // Products
  // ======================================================
  const productFilters = {
    todos: ['Todos', () => true],
    interior: ['Interior', (p) => p.collection === 'interior'],
    exterior: ['Exterior', (p) => p.collection === 'exterior'],
    decoracion: ['Decoración', (p) => p.collection === 'decoracion'],
    portada: ['En la portada', (p) => p.featured && p.published],
    ocultos: ['Ocultos', (p) => !p.published],
    agotados: ['Agotados', (p) => p.stock === 0],
  };

  function renderProducts() {
    const published = state.products.filter((p) => p.published).length;
    const featured = state.products.filter((p) => p.featured && p.published).length;
    view.innerHTML = `
      <div class="view-head">
        <div>
          <h1>Productos</h1>
          <p>${plural(published, 'publicado', 'publicados')} en el sitio, ${featured} en la portada.</p>
        </div>
        <button class="btn" type="button" id="new-product">Nuevo producto</button>
      </div>
      <div class="toolbar">
        <input class="search" type="search" id="product-search" placeholder="Buscar por nombre, SKU o tipo" aria-label="Buscar productos" value="${esc(state.productQuery)}" />
        <div class="filters" id="product-filters"></div>
      </div>
      <div class="panel"><div class="table-wrap" id="product-list"></div></div>`;

    $('#new-product').addEventListener('click', () => openProduct(null));
    $('#product-search').addEventListener('input', (e) => { state.productQuery = e.target.value; drawProducts(); });
    $('#product-filters').addEventListener('click', (e) => {
      const b = e.target.closest('[data-filter]');
      if (b) { state.productFilter = b.dataset.filter; drawProducts(); }
    });
    bindRows($('#product-list'), (id) => openProduct(state.products.find((p) => p.id === id)));
    drawProducts();
  }

  function drawProducts() {
    $('#product-filters').innerHTML = Object.entries(productFilters).map(([key, [label, test]]) =>
      `<button type="button" class="filter" data-filter="${key}" aria-pressed="${state.productFilter === key}">${label}<span class="n">${state.products.filter(test).length}</span></button>`
    ).join('');

    const q = state.productQuery.trim().toLowerCase();
    const list = state.products
      .filter(productFilters[state.productFilter][1])
      .filter((p) => !q || [p.name, p.sku, p.category].join(' ').toLowerCase().includes(q))
      .sort((a, b) => a.name.localeCompare(b.name, 'es'));

    const el = $('#product-list');
    if (!state.products.length) {
      el.innerHTML = `<div class="empty"><strong>Aún no hay productos</strong>Agrega el primero con sus fotos, precio y existencias.<br><button class="btn" type="button" data-new>Nuevo producto</button></div>`;
      $('[data-new]', el).addEventListener('click', () => openProduct(null));
      return;
    }
    if (!list.length) {
      el.innerHTML = `<div class="empty"><strong>Sin resultados</strong>Ningún producto coincide con la búsqueda o el filtro.</div>`;
      return;
    }
    el.innerHTML = `
      <table>
        <thead><tr><th></th><th>Producto</th><th>SKU</th><th>Colección</th><th class="num">Precio</th><th class="num">Existencias</th><th>Estado</th></tr></thead>
        <tbody>${list.map((p) => `
          <tr data-id="${p.id}" tabindex="0">
            <td>${p.images[0] ? `<img class="thumb" src="/${esc(p.images[0])}" alt="" loading="lazy" />` : `<div class="thumb thumb-empty">Sin foto</div>`}</td>
            <td><div class="cell-title">${esc(p.name)}</div><div class="cell-sub">${esc(p.category)}</div></td>
            <td class="muted">${esc(p.sku) || '—'}</td>
            <td>${COLLECTIONS[p.collection]}</td>
            <td class="num">${p.price ? fmtMoney(p.price) : '<span class="muted">Sin precio</span>'}</td>
            <td class="num">${p.stock === 0 ? pill(['Agotado', 'wine']) : p.stock}</td>
            <td>${p.published ? pill(['Publicado', 'olive']) : pill(['Oculto', 'plain'])} ${p.featured && p.published ? pill(['Portada', 'amber']) : ''}</td>
          </tr>`).join('')}
        </tbody>
      </table>`;
  }

  function openProduct(product) {
    const p = product || {
      name: '', sku: '', category: '', collection: 'interior', price: 0, stock: 1, badge: '',
      description: '', tags: [], images: [], imageAlt: '', imageFit: 'cover', featured: false, published: true,
    };
    let images = p.images.slice();
    const categories = [...new Set(state.products.map((x) => x.category).filter(Boolean))];

    const body = `
      <fieldset>
        <legend>Fotos</legend>
        <div class="photos" id="photos"></div>
        <label class="field">Descripción de la foto principal
          <span class="hint">Para personas que usan lector de pantalla y para Google. Ej.: lámpara de mesa con pantalla crema y base de madera.</span>
          <input class="input" name="imageAlt" value="${esc(p.imageAlt)}" maxlength="200" />
        </label>
        <label class="check"><input type="checkbox" name="imageFit" ${p.imageFit === 'contain' ? 'checked' : ''} />
          <span>Mostrar la foto completa, sin recortar<small>Útil para fichas técnicas o fotos con texto.</small></span>
        </label>
      </fieldset>

      <fieldset>
        <legend>Datos del producto</legend>
        <div class="grid-2">
          <label class="field">Nombre<input class="input" name="name" value="${esc(p.name)}" required maxlength="120" /></label>
          <label class="field">SKU o código<input class="input" name="sku" value="${esc(p.sku)}" maxlength="60" /></label>
        </div>
        <div class="grid-2">
          <label class="field">Tipo
            <input class="input" name="category" value="${esc(p.category)}" list="category-list" placeholder="Lámpara de mesa" maxlength="80" />
            <datalist id="category-list">${categories.map((c) => `<option value="${esc(c)}">`).join('')}</datalist>
          </label>
          <label class="field">Colección<select class="input" name="collection">${optionsMap(COLLECTIONS, p.collection)}</select></label>
        </div>
        <div class="grid-2">
          <label class="field">Precio (MXN)<span class="hint">Déjalo en 0 si aún no tiene precio.</span><input class="input" name="price" type="number" min="0" step="0.01" value="${numValue(p.price)}" placeholder="0" /></label>
          <label class="field">Existencias<span class="hint">En 0 se muestra como agotado.</span><input class="input" name="stock" type="number" min="0" step="1" value="${p.stock}" /></label>
        </div>
        <label class="field">Etiqueta junto al nombre<span class="hint">Un dato corto, por ejemplo «73 cm» o «Pantalla negra».</span><input class="input" name="badge" value="${esc(p.badge)}" maxlength="40" /></label>
        <label class="field">Descripción<textarea class="input" name="description" maxlength="2000">${esc(p.description)}</textarea></label>
        <label class="field">Características<span class="hint">Separadas por comas. Ej.: Madera sólida, Luz cálida</span><input class="input" name="tags" value="${esc(p.tags.join(', '))}" /></label>
      </fieldset>

      <fieldset>
        <legend>Visibilidad</legend>
        <label class="check"><input type="checkbox" name="published" ${p.published ? 'checked' : ''} />
          <span>Publicado en el sitio<small>Si lo desmarcas, el producto queda guardado pero nadie lo ve.</small></span>
        </label>
        <label class="check"><input type="checkbox" name="featured" ${p.featured ? 'checked' : ''} />
          <span>Mostrar en la portada<small>Aparece en «Productos destacados».</small></span>
        </label>
      </fieldset>`;

    const foot = `
      <button class="btn" type="submit">${product ? 'Guardar cambios' : 'Crear producto'}</button>
      <button class="btn btn-quiet" type="button" data-close>Cancelar</button>
      <span class="spacer"></span>
      ${product ? '<button class="btn btn-danger" type="button" id="delete-product">Eliminar</button>' : ''}`;

    openDrawer(product ? `Editar ${p.name}` : 'Nuevo producto', body, foot, async (form) => {
      const payload = {
        name: form.get('name'), sku: form.get('sku'), category: form.get('category'), collection: form.get('collection'),
        price: form.get('price'), stock: form.get('stock'), badge: form.get('badge'), description: form.get('description'),
        tags: String(form.get('tags') || '').split(',').map((t) => t.trim()).filter(Boolean),
        images, imageAlt: form.get('imageAlt'), imageFit: form.get('imageFit') ? 'contain' : 'cover',
        featured: Boolean(form.get('featured')), published: Boolean(form.get('published')),
      };
      if (!String(payload.name).trim()) throw new Error('Escribe el nombre del producto.');
      const saved = product ? await api('PUT', 'products/' + product.id, payload) : await api('POST', 'products', payload);
      const i = state.products.findIndex((x) => x.id === saved.id);
      if (i === -1) state.products.push(saved); else state.products[i] = saved;
      closeDrawer();
      renderProducts();
      updateCounts();
      toast(product ? 'Producto guardado' : 'Producto creado');
    });

    const photosEl = $('#photos');
    let uploading = 0;

    function drawPhotos() {
      photosEl.innerHTML = images.map((src, i) => `
        <div class="photo">
          <img src="/${esc(src)}" alt="Foto ${i + 1}" />
          ${i === 0 ? '<span class="tag">Principal</span>' : ''}
          <div class="actions">
            ${i > 0 ? `<button type="button" data-main="${i}" aria-label="Usar como foto principal" title="Usar como principal">★</button>` : ''}
            <button type="button" data-remove="${i}" aria-label="Quitar foto" title="Quitar">✕</button>
          </div>
        </div>`).join('') +
        Array.from({ length: uploading }, () => '<div class="photo"><div class="dropzone" style="border-style:solid;cursor:default">Subiendo…</div></div>').join('') +
        `<label class="dropzone" id="dropzone">
          <input type="file" accept="image/png,image/jpeg,image/webp" multiple />
          <span>Agregar fotos<br><small>o arrástralas aquí</small></span>
        </label>`;
    }

    async function upload(files) {
      const list = Array.from(files).filter((f) => f.type.startsWith('image/'));
      if (!list.length) return toast('Sube la foto en formato JPG, PNG o WebP.', true);
      uploading += list.length;
      drawPhotos();
      for (const file of list) {
        try {
          const { path } = await api('POST', 'upload?name=' + encodeURIComponent(file.name), file);
          images.push(path);
        } catch (err) {
          toast(err.message, true);
        }
        uploading -= 1;
        drawPhotos();
      }
    }

    photosEl.addEventListener('click', (e) => {
      const main = e.target.closest('[data-main]');
      const remove = e.target.closest('[data-remove]');
      if (main) { const [img] = images.splice(Number(main.dataset.main), 1); images.unshift(img); drawPhotos(); }
      if (remove) { images.splice(Number(remove.dataset.remove), 1); drawPhotos(); }
    });
    photosEl.addEventListener('change', (e) => { if (e.target.type === 'file') upload(e.target.files); });
    photosEl.addEventListener('dragover', (e) => { e.preventDefault(); const dz = $('#dropzone'); if (dz) dz.classList.add('over'); });
    photosEl.addEventListener('dragleave', () => { const dz = $('#dropzone'); if (dz) dz.classList.remove('over'); });
    photosEl.addEventListener('drop', (e) => { e.preventDefault(); upload(e.dataTransfer.files); });
    drawPhotos();

    const del = $('#delete-product');
    if (del) del.addEventListener('click', async () => {
      if (!confirm(`¿Eliminar «${p.name}»? Esta acción no se puede deshacer.`)) return;
      try {
        await api('DELETE', 'products/' + product.id);
        state.products = state.products.filter((x) => x.id !== product.id);
        closeDrawer();
        renderProducts();
        updateCounts();
        toast('Producto eliminado');
      } catch (err) { toast(err.message, true); }
    });
  }

  // ======================================================
  // Orders
  // ======================================================
  const orderFilters = {
    activos: ['En curso', (o) => ACTIVE_STATUSES.includes(o.status)],
    ...Object.fromEntries(Object.entries(ORDER_STATUS).map(([key, [label]]) => [key, [label, (o) => o.status === key]])),
    todos: ['Todos', () => true],
  };

  function renderOrders() {
    const active = state.orders.filter((o) => ACTIVE_STATUSES.includes(o.status));
    const pendingPay = active.filter((o) => o.paymentStatus === 'pendiente').length;
    const toShip = state.orders.filter((o) => o.status === 'pagado' || o.status === 'preparando').length;
    view.innerHTML = `
      <div class="view-head">
        <div>
          <h1>Pedidos</h1>
          <p>${active.length} en curso: ${toShip} por enviar, ${pendingPay} con pago pendiente.</p>
        </div>
        <button class="btn" type="button" id="new-order">Nuevo pedido</button>
      </div>
      <div class="toolbar">
        <input class="search" type="search" id="order-search" placeholder="Buscar por cliente, teléfono, pedido o guía" aria-label="Buscar pedidos" value="${esc(state.orderQuery)}" />
        <div class="filters" id="order-filters"></div>
      </div>
      <div class="panel"><div class="table-wrap" id="order-list"></div></div>`;

    $('#new-order').addEventListener('click', () => openOrder(null));
    $('#order-search').addEventListener('input', (e) => { state.orderQuery = e.target.value; drawOrders(); });
    $('#order-filters').addEventListener('click', (e) => {
      const b = e.target.closest('[data-filter]');
      if (b) { state.orderFilter = b.dataset.filter; drawOrders(); }
    });
    bindRows($('#order-list'), (id) => openOrder(state.orders.find((o) => o.id === id)));
    drawOrders();
  }

  function drawOrders() {
    $('#order-filters').innerHTML = Object.entries(orderFilters).map(([key, [label, test]]) =>
      `<button type="button" class="filter" data-filter="${key}" aria-pressed="${state.orderFilter === key}">${label}<span class="n">${state.orders.filter(test).length}</span></button>`
    ).join('');

    const q = state.orderQuery.trim().toLowerCase();
    const qDigits = q.replace(/\D/g, '');
    const list = state.orders
      .filter(orderFilters[state.orderFilter][1])
      .filter((o) => !q
        || [o.id, o.customer.name, o.customer.email, o.trackingNumber].join(' ').toLowerCase().includes(q)
        || (qDigits.length >= 4 && waDigits(o.customer.phone).includes(qDigits)))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    const el = $('#order-list');
    if (!state.orders.length) {
      el.innerHTML = `<div class="empty"><strong>Aún no hay pedidos</strong>Cuando alguien te compre por WhatsApp, regístralo aquí para darle seguimiento al pago y al envío.<br><button class="btn" type="button" data-new>Nuevo pedido</button></div>`;
      $('[data-new]', el).addEventListener('click', () => openOrder(null));
      return;
    }
    if (!list.length) {
      el.innerHTML = `<div class="empty"><strong>Sin resultados</strong>Ningún pedido coincide con la búsqueda o el filtro.</div>`;
      return;
    }
    el.innerHTML = `
      <table>
        <thead><tr><th>Pedido</th><th>Fecha</th><th>Cliente</th><th>Productos</th><th class="num">Total</th><th>Pago</th><th>Estado</th><th>Envío</th></tr></thead>
        <tbody>${list.map((o) => `
          <tr data-id="${o.id}" tabindex="0">
            <td class="cell-title">${esc(o.id)}</td>
            <td class="muted">${fmtDate(o.createdAt)}</td>
            <td><div class="cell-title">${esc(o.customer.name)}</div><div class="cell-sub">${esc(o.customer.phone)}</div></td>
            <td class="cell-sub">${o.items.map((i) => `${esc(i.name)} ×${i.qty}`).join(', ') || '—'}</td>
            <td class="num">${fmtMoney(orderTotal(o))}</td>
            <td>${pill(PAYMENT_STATUS[o.paymentStatus])}</td>
            <td>${pill(ORDER_STATUS[o.status])}</td>
            <td class="cell-sub">${o.carrier ? esc(o.carrier) + (o.trackingNumber ? `<br>${esc(o.trackingNumber)}` : '') : '—'}</td>
          </tr>`).join('')}
        </tbody>
      </table>`;
  }

  function openOrder(order) {
    const o = order || {
      status: 'nuevo', customer: { name: '', phone: '', email: '' },
      address: { street: '', city: '', state: '', zip: '', references: '' },
      items: [], shippingCost: 0, paymentMethod: 'Transferencia', paymentStatus: 'pendiente',
      carrier: '', trackingNumber: '', notes: '',
    };
    const items = o.items.length ? o.items.map((i) => ({ ...i })) : [{ productId: '', name: '', qty: 1, price: 0 }];

    const body = `
      <div class="grid-2">
        <label class="field">Estado del pedido<select class="input" name="status">${optionsMap(ORDER_STATUS, o.status)}</select></label>
        <label class="field">Estado del pago<select class="input" name="paymentStatus">${optionsMap(PAYMENT_STATUS, o.paymentStatus)}</select></label>
      </div>

      <fieldset>
        <legend>Cliente</legend>
        <label class="field">Nombre<input class="input" name="customerName" value="${esc(o.customer.name)}" required maxlength="120" autocomplete="off" /></label>
        <div class="grid-2">
          <label class="field">Teléfono / WhatsApp<input class="input" name="customerPhone" type="tel" value="${esc(o.customer.phone)}" maxlength="30" autocomplete="off" /></label>
          <label class="field">Correo<input class="input" name="customerEmail" type="email" value="${esc(o.customer.email)}" maxlength="120" autocomplete="off" /></label>
        </div>
      </fieldset>

      <fieldset>
        <legend>Productos</legend>
        <div class="items" id="items"></div>
        <datalist id="product-names">${state.products.map((p) => `<option value="${esc(p.name)}">`).join('')}</datalist>
        <div><button class="btn btn-quiet btn-small" type="button" id="add-item">Agregar producto</button></div>
        <div class="grid-2">
          <label class="field">Forma de pago<select class="input" name="paymentMethod">${options(PAYMENT_METHODS, o.paymentMethod)}</select></label>
          <label class="field">Costo de envío (MXN)<input class="input" name="shippingCost" type="number" min="0" step="0.01" value="${numValue(o.shippingCost)}" placeholder="0" id="shipping-cost" /></label>
        </div>
        <div class="totals" id="totals"></div>
      </fieldset>

      <fieldset>
        <legend>Entrega</legend>
        <label class="field">Calle y número<input class="input" name="street" value="${esc(o.address.street)}" maxlength="200" autocomplete="off" /></label>
        <div class="grid-3">
          <label class="field">Ciudad o municipio<input class="input" name="city" value="${esc(o.address.city)}" maxlength="80" autocomplete="off" /></label>
          <label class="field">Estado<input class="input" name="state" value="${esc(o.address.state)}" maxlength="80" autocomplete="off" /></label>
          <label class="field">C.P.<input class="input" name="zip" value="${esc(o.address.zip)}" maxlength="10" inputmode="numeric" autocomplete="off" /></label>
        </div>
        <label class="field">Referencias<input class="input" name="references" value="${esc(o.address.references)}" maxlength="300" placeholder="Entre calles, color de la casa…" autocomplete="off" /></label>
        <div class="grid-2">
          <label class="field">Paquetería<select class="input" name="carrier"><option value="">Sin asignar</option>${options(CARRIERS, o.carrier)}</select></label>
          <label class="field">Número de guía<input class="input" name="trackingNumber" value="${esc(o.trackingNumber)}" maxlength="80" autocomplete="off" /></label>
        </div>
        <div><button class="btn btn-quiet btn-small" type="button" id="send-tracking">Enviar seguimiento por WhatsApp</button></div>
      </fieldset>

      <label class="field">Notas internas<textarea class="input" name="notes" maxlength="2000">${esc(o.notes)}</textarea></label>`;

    const foot = `
      <button class="btn" type="submit">${order ? 'Guardar cambios' : 'Crear pedido'}</button>
      <button class="btn btn-quiet" type="button" data-close>Cancelar</button>
      <span class="spacer"></span>
      ${order ? '<button class="btn btn-danger" type="button" id="delete-order">Eliminar</button>' : ''}`;

    openDrawer(order ? `Pedido ${o.id}` : 'Nuevo pedido', body, foot, async (form) => {
      const payload = {
        status: form.get('status'), paymentStatus: form.get('paymentStatus'), paymentMethod: form.get('paymentMethod'),
        customer: { name: form.get('customerName'), phone: form.get('customerPhone'), email: form.get('customerEmail') },
        address: { street: form.get('street'), city: form.get('city'), state: form.get('state'), zip: form.get('zip'), references: form.get('references') },
        items: items.filter((i) => i.name.trim()),
        shippingCost: form.get('shippingCost'), carrier: form.get('carrier'), trackingNumber: form.get('trackingNumber'), notes: form.get('notes'),
      };
      if (!String(payload.customer.name).trim()) throw new Error('Escribe el nombre del cliente.');
      const saved = order ? await api('PUT', 'orders/' + order.id, payload) : await api('POST', 'orders', payload);
      const i = state.orders.findIndex((x) => x.id === saved.id);
      if (i === -1) state.orders.push(saved); else state.orders[i] = saved;
      closeDrawer();
      renderOrders();
      updateCounts();
      toast(order ? 'Pedido guardado' : `Pedido ${saved.id} creado`);
    });

    const itemsEl = $('#items');
    const totalsEl = $('#totals');

    function drawTotals() {
      const subtotal = items.reduce((s, i) => s + (Number(i.qty) || 0) * (Number(i.price) || 0), 0);
      const shipping = Number($('#shipping-cost').value) || 0;
      totalsEl.innerHTML = `<span class="muted">Productos ${fmtMoney(subtotal)}</span><span class="muted">Envío ${fmtMoney(shipping)}</span><strong>Total ${fmtMoney(subtotal + shipping)}</strong>`;
    }

    function drawItems() {
      itemsEl.innerHTML = items.map((item, i) => `
        <div class="item-row">
          <input class="input" data-i="${i}" data-k="name" list="product-names" value="${esc(item.name)}" placeholder="Producto" aria-label="Producto ${i + 1}" />
          <input class="input" data-i="${i}" data-k="qty" type="number" min="1" step="1" value="${item.qty}" aria-label="Cantidad" />
          <input class="input" data-i="${i}" data-k="price" type="number" min="0" step="0.01" value="${numValue(item.price)}" placeholder="0" aria-label="Precio unitario" />
          <button class="icon-btn" type="button" data-remove-item="${i}" aria-label="Quitar producto">✕</button>
        </div>`).join('');
      drawTotals();
    }

    itemsEl.addEventListener('input', (e) => {
      const { i, k } = e.target.dataset;
      if (i === undefined) return;
      const item = items[Number(i)];
      item[k] = k === 'name' ? e.target.value : Number(e.target.value);
      if (k === 'name') {
        // Picking a catalog product fills in its id and current price.
        const match = state.products.find((p) => p.name === e.target.value);
        item.productId = match ? match.id : '';
        if (match && match.price) {
          item.price = match.price;
          $(`[data-i="${i}"][data-k="price"]`, itemsEl).value = match.price;
        }
      }
      drawTotals();
    });
    itemsEl.addEventListener('click', (e) => {
      const b = e.target.closest('[data-remove-item]');
      if (!b) return;
      items.splice(Number(b.dataset.removeItem), 1);
      if (!items.length) items.push({ productId: '', name: '', qty: 1, price: 0 });
      drawItems();
    });
    $('#add-item').addEventListener('click', () => {
      items.push({ productId: '', name: '', qty: 1, price: 0 });
      drawItems();
      $$('[data-k="name"]', itemsEl).pop().focus();
    });
    $('#shipping-cost').addEventListener('input', drawTotals);
    drawItems();

    $('#send-tracking').addEventListener('click', () => {
      const form = $('#drawer-form');
      const phone = waDigits(form.customerPhone.value);
      if (phone.length < 10) return toast('Escribe el teléfono del cliente para enviarle el seguimiento.', true);
      const carrier = form.carrier.value;
      const tracking = form.trackingNumber.value.trim();
      const name = form.customerName.value.trim().split(' ')[0];
      const text = tracking
        ? `Hola ${name}, tu pedido de BOGA LAMPS ya va en camino con ${carrier || 'la paquetería'}. Tu número de guía es ${tracking}. ¡Gracias por tu compra!`
        : `Hola ${name}, te escribimos de BOGA LAMPS sobre tu pedido.`;
      window.open('https://wa.me/' + phone + '?text=' + encodeURIComponent(text), '_blank', 'noopener');
    });

    const del = $('#delete-order');
    if (del) del.addEventListener('click', async () => {
      if (!confirm(`¿Eliminar el pedido ${o.id}? Esta acción no se puede deshacer.`)) return;
      try {
        await api('DELETE', 'orders/' + order.id);
        state.orders = state.orders.filter((x) => x.id !== order.id);
        closeDrawer();
        renderOrders();
        updateCounts();
        toast('Pedido eliminado');
      } catch (err) { toast(err.message, true); }
    });
  }

  // ======================================================
  // Customers (built from orders)
  // ======================================================
  function customers() {
    const map = new Map();
    for (const o of state.orders) {
      const key = waDigits(o.customer.phone) || o.customer.email.toLowerCase() || o.customer.name.toLowerCase();
      if (!key) continue;
      const c = map.get(key) || { key, name: '', phone: '', email: '', orders: 0, spent: 0, last: '' };
      c.orders += 1;
      if (o.status !== 'cancelado') c.spent += orderTotal(o);
      if (o.createdAt > c.last) {
        c.last = o.createdAt;
        c.name = o.customer.name || c.name;
        c.phone = o.customer.phone || c.phone;
        c.email = o.customer.email || c.email;
      }
      map.set(key, c);
    }
    return [...map.values()].sort((a, b) => b.last.localeCompare(a.last));
  }

  function renderCustomers() {
    const all = customers();
    const repeat = all.filter((c) => c.orders > 1).length;
    view.innerHTML = `
      <div class="view-head">
        <div>
          <h1>Clientes</h1>
          <p>${plural(all.length, 'cliente', 'clientes')}, ${repeat === 1 ? '1 ha comprado' : repeat + ' han comprado'} más de una vez. La lista se arma con los pedidos que registras.</p>
        </div>
      </div>
      <div class="toolbar">
        <input class="search" type="search" id="customer-search" placeholder="Buscar por nombre, teléfono o correo" aria-label="Buscar clientes" value="${esc(state.customerQuery)}" />
      </div>
      <div class="panel"><div class="table-wrap" id="customer-list"></div></div>`;

    $('#customer-search').addEventListener('input', (e) => { state.customerQuery = e.target.value; drawCustomers(all); });
    bindRows($('#customer-list'), (key) => {
      const c = all.find((x) => x.key === key);
      state.orderQuery = c.phone || c.email || c.name;
      state.orderFilter = 'todos';
      location.hash = '#pedidos';
    });
    drawCustomers(all);
  }

  function drawCustomers(all) {
    const q = state.customerQuery.trim().toLowerCase();
    const list = all.filter((c) => !q || [c.name, c.phone, c.email].join(' ').toLowerCase().includes(q));
    const el = $('#customer-list');
    if (!all.length) {
      el.innerHTML = `<div class="empty"><strong>Aún no hay clientes</strong>Aparecen aquí en cuanto registras su primer pedido.<br><a class="btn" href="#pedidos">Ir a pedidos</a></div>`;
      return;
    }
    if (!list.length) {
      el.innerHTML = `<div class="empty"><strong>Sin resultados</strong>Ningún cliente coincide con la búsqueda.</div>`;
      return;
    }
    el.innerHTML = `
      <table>
        <thead><tr><th>Cliente</th><th>Teléfono</th><th>Correo</th><th class="num">Pedidos</th><th class="num">Total comprado</th><th>Último pedido</th><th></th></tr></thead>
        <tbody>${list.map((c) => `
          <tr data-id="${esc(c.key)}" tabindex="0" title="Ver sus pedidos">
            <td class="cell-title">${esc(c.name)}</td>
            <td>${esc(c.phone) || '—'}</td>
            <td class="muted">${esc(c.email) || '—'}</td>
            <td class="num">${c.orders}</td>
            <td class="num">${fmtMoney(c.spent)}</td>
            <td class="muted">${fmtDate(c.last)}</td>
            <td>${waDigits(c.phone).length >= 10 ? `<a class="btn btn-quiet btn-small" href="https://wa.me/${waDigits(c.phone)}" target="_blank" rel="noopener">WhatsApp</a>` : ''}</td>
          </tr>`).join('')}
        </tbody>
      </table>`;
  }

  // ======================================================
  // Settings
  // ======================================================
  function renderSettings() {
    const s = state.settings;
    view.innerHTML = `
      <div class="view-head"><div><h1>Ajustes</h1><p>Opciones que cambian lo que ve el público en el sitio.</p></div></div>
      <form class="panel settings" id="settings-form" novalidate>
        <label class="field">Número de WhatsApp del negocio
          <span class="hint">Con código de país y sin espacios. Para México: 52 y los 10 dígitos, por ejemplo 523312345678.</span>
          <input class="input" name="whatsappNumber" inputmode="numeric" value="${esc(s.whatsappNumber)}" maxlength="20" />
        </label>
        <label class="check"><input type="checkbox" name="showPrices" ${s.showPrices ? 'checked' : ''} />
          <span>Mostrar precios en el sitio<small>Si está desmarcado, los clientes preguntan el precio por WhatsApp. Los productos con precio 0 nunca muestran precio.</small></span>
        </label>
        <div><button class="btn" type="submit">Guardar ajustes</button></div>
        <div class="note">
          <strong>Cómo se publican tus cambios.</strong> Todo lo que guardas aquí se ve al instante en
          <a href="http://localhost:3000" target="_blank" rel="noopener">localhost:3000</a>, solo en esta computadora.
          Para que aparezca en internet hay que subir los cambios a GitHub. Los pedidos y los datos de clientes nunca se suben.
        </div>
      </form>`;

    $('#settings-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = new FormData(e.target);
      const digits = String(form.get('whatsappNumber')).replace(/\D/g, '');
      if (digits.length < 11) return toast('Escribe el número completo con código de país, por ejemplo 523312345678.', true);
      try {
        state.settings = await api('PUT', 'settings', { whatsappNumber: digits, showPrices: Boolean(form.get('showPrices')) });
        renderSettings();
        toast('Ajustes guardados');
      } catch (err) { toast(err.message, true); }
    });
  }

  // ======================================================
  // Router
  // ======================================================
  const views = { productos: renderProducts, pedidos: renderOrders, clientes: renderCustomers, ajustes: renderSettings };

  function updateCounts() {
    $('#count-productos').textContent = state.products.length;
    $('#count-pedidos').textContent = state.orders.filter((o) => ACTIVE_STATUSES.includes(o.status)).length;
    $('#count-clientes').textContent = customers().length;
  }

  function route() {
    const name = views[location.hash.slice(1)] ? location.hash.slice(1) : 'productos';
    $$('.nav a').forEach((a) => {
      if (a.dataset.view === name) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    if (drawer.classList.contains('open')) closeDrawer();
    views[name]();
  }

  async function init() {
    try {
      [state.products, state.orders, state.settings] = await Promise.all([api('GET', 'products'), api('GET', 'orders'), api('GET', 'settings')]);
    } catch (err) {
      view.innerHTML = `<div class="empty"><strong>No se pudo cargar la información</strong>${esc(err.message)}</div>`;
      return;
    }
    updateCounts();
    window.addEventListener('hashchange', route);
    route();
  }

  init();
})();

/* ==========================================================
   ReciclaERP · Almacén, ventas, caja chica y reportes
   Los datos viven en Supabase para que todas las cuentas vean
   lo mismo en tiempo real. El acceso depende del rol.
   ========================================================== */

const db = supabaseClient;

const RACKS = [1, 2, 3, 4, 5];
const NIVELES = [4, 3, 2, 1];         // de arriba hacia abajo
const SECCIONES = [1, 2, 3, 4];       // cada una con columna A y B
const LETRAS = ['A', 'B'];

const ROLES_ASIGNABLES = ['pendiente', 'administrador', 'gerente', 'ventas'];

/* ---------- estado en memoria ---------- */
let data = { jumbos: [], pedidos: [], materiales: [], gastos: [] };
let currentUser = null;
let currentProfile = null;
let rackActivo = 0; // 0 = "Todos"
let jumboEnDetalle = null;    // id del jumbo abierto en la ficha
let jumboEnUbicacion = null;  // id del jumbo que se está ubicando/moviendo
let canalRealtime = null;
let uiRestaurada = false;
let primeraCarga = true;

/* ---------- esqueleto de carga (mientras llegan los datos por primera vez) ---------- */
function renderEsqueletoBoard() {
  const board = document.getElementById('rack-board');
  if (!board) return;
  let html = `
    <div class="rack-title">
      <span class="skeleton" style="width:26px;height:26px;border-radius:8px;"></span>
      <div>
        <div class="skeleton" style="width:80px;height:15px;margin-bottom:6px;"></div>
        <div class="skeleton" style="width:150px;height:11px;"></div>
      </div>
    </div>
    <div class="seccion-headers"><div></div>${'<div class="skeleton" style="height:10px;margin:4px 24px;"></div>'.repeat(4)}</div>
  `;
  for (let n = 0; n < 4; n++) {
    html += `<div class="nivel-row"><div class="skeleton" style="height:13px;width:52px;"></div>${'<div class="cell skeleton-cell skeleton"></div>'.repeat(8)}</div>`;
  }
  board.innerHTML = html;
}

function renderEsqueletoTabla(tbodyId, filas, cols) {
  const tbody = document.getElementById(tbodyId);
  if (!tbody) return;
  tbody.innerHTML = Array.from({ length: filas }).map(() =>
    `<tr class="skeleton-row">${'<td><div class="skeleton"></div></td>'.repeat(cols)}</tr>`
  ).join('');
}


function miRol() { return currentProfile ? currentProfile.role : null; }
function puedeEditarAlmacen() { return ['administrador', 'gerente'].includes(miRol()); }

/* ---------- helpers de posición ---------- */
function posId(pos) {
  return `R${pos.rack}-N${pos.nivel}-S${pos.seccion}-${pos.letra}`;
}

function todasLasPosiciones() {
  const lista = [];
  RACKS.forEach(rack => {
    NIVELES.forEach(nivel => {
      SECCIONES.forEach(seccion => {
        LETRAS.forEach(letra => lista.push({ rack, nivel, seccion, letra }));
      });
    });
  });
  return lista;
}

/* numeración humana 1-160, consecutiva a lo largo de todo el almacén */
const NUMEROS_MAP = new Map();
todasLasPosiciones().forEach((p, i) => NUMEROS_MAP.set(posId(p), i + 1));
function numeroHumano(pos) {
  return NUMEROS_MAP.get(posId(pos));
}

function jumboEnPosicion(pos) {
  return data.jumbos.find(j => j.posicion && posId(j.posicion) === posId(pos));
}

function etiquetaPosicion(pos) {
  return `Rack ${pos.rack} · Nivel ${pos.nivel} · Sección ${pos.seccion}${pos.letra} · #${numeroHumano(pos)}`;
}

function codigoPosicion(pos) {
  return `R${pos.rack}-N${pos.nivel}-S${pos.seccion}${pos.letra} (#${numeroHumano(pos)})`;
}

function diasEnAlmacen(fechaIngreso) {
  const ingreso = new Date(fechaIngreso + 'T00:00:00');
  const hoy = new Date();
  hoy.setHours(0, 0, 0, 0);
  const ms = hoy - ingreso;
  return Math.max(0, Math.round(ms / (1000 * 60 * 60 * 24)));
}

function enDias(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

function diasHasta(fechaISO) {
  if (!fechaISO) return null;
  const objetivo = new Date(fechaISO + 'T00:00:00');
  const hoy = new Date(); hoy.setHours(0, 0, 0, 0);
  return Math.round((objetivo - hoy) / (1000 * 60 * 60 * 24));
}

function hoyISO() {
  const d = new Date();
  return d.toISOString().slice(0, 10);
}

function uid() {
  return 'j' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function colorMaterial(material) {
  const m = data.materiales.find(x => x.nombre === material);
  return m ? m.color : '#6b7280';
}

function formatoFechaHora(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString('es-MX') + ' · ' + d.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
}

function materialPorNombre(nombre) {
  return data.materiales.find(x => x.nombre === nombre);
}

/* ---------- folio automático ---------- */
function siguienteFolio() {
  const folios = [
    ...data.jumbos.map(j => j.folio),
    // también los ya vendidos, para que un folio nunca se repita
    ...data.pedidos.flatMap(p => (p.items || []).map(it => it.folio)),
  ];
  const nums = folios
    .map(f => { const m = f && String(f).match(/^Z(\d+)$/i); return m ? parseInt(m[1], 10) : null; })
    .filter(n => n !== null);
  const max = nums.length ? Math.max(...nums) : 0;
  return 'Z' + String(max + 1).padStart(5, '0');
}

/* ==========================================================
   SUPABASE: mapeo de filas <-> objetos de la interfaz
   ========================================================== */
function mapJumbo(r) {
  return {
    id: r.id, folio: r.folio, material: r.material, color: r.color,
    descripcion: r.descripcion || '', kilos: Number(r.kilos) || 0,
    fechaIngreso: r.fecha_ingreso,
    apartado: r.apartado, apartadoCliente: r.apartado_cliente || '',
    apartadoFecha: r.apartado_fecha || '', pedidoId: r.pedido_id || null,
    historial: r.historial || [],
    posicion: r.rack ? { rack: r.rack, nivel: r.nivel, seccion: r.seccion, letra: r.letra } : null,
  };
}
function mapPedido(r) {
  return {
    id: r.id, cliente: r.cliente, fecha: r.fecha,
    precioTotal: Number(r.precio_total) || 0, kilosTotal: Number(r.kilos_total) || 0,
    items: r.items || [], estado: r.estado, creadoPor: r.creado_por || '',
    fechaLimite: r.fecha_limite || null,
    vendidoAt: r.vendido_at || null, createdAt: r.created_at,
  };
}
function mapMaterial(r) {
  return { id: r.id, nombre: r.nombre, color: r.color, costoPorKg: Number(r.costo_por_kg) || 0, variantes: r.variantes || [] };
}
function mapGasto(r) {
  return {
    id: r.id, persona: r.persona, descripcion: r.descripcion,
    monto: Number(r.monto) || 0, fecha: r.fecha,
    categoria: r.categoria || 'General', registradoPor: r.registrado_por || '',
    createdAt: r.created_at,
  };
}

function nuevoEvento(texto) {
  return { fecha: new Date().toISOString(), texto, por: currentProfile ? currentProfile.email : '' };
}

async function cargarDatos() {
  const rol = miRol();
  const consultas = [
    db.from('materiales').select('*').order('nombre'),
    db.from('jumbos').select('*').order('created_at'),
    db.from('pedidos').select('*').order('created_at'),
  ];
  // los gastos de caja chica solo los ve administrador y gerente
  if (['administrador', 'gerente'].includes(rol)) {
    consultas.push(db.from('gastos').select('*').order('fecha', { ascending: false }));
  }

  const res = await Promise.all(consultas);
  const [mat, jum, ped, gas] = res;

  if (mat.error) console.error('materiales:', mat.error);
  if (jum.error) console.error('jumbos:', jum.error);
  if (ped.error) console.error('pedidos:', ped.error);

  data.materiales = (mat.data || []).map(mapMaterial);
  data.jumbos = (jum.data || []).map(mapJumbo);
  data.pedidos = (ped.data || []).map(mapPedido);
  data.gastos = gas && !gas.error ? (gas.data || []).map(mapGasto) : [];

  renderSelectMaterialOptions();
  renderTodo();

  // los pedidos que pasaron su fecha límite sin cerrarse se deshacen solos
  await caducarPedidosVencidos();
}

/* Deshace los pedidos cuya fecha límite ya pasó y libera sus jumbos. */
let caducandoPedidos = false;
async function caducarPedidosVencidos() {
  if (caducandoPedidos) return;
  const hoy = hoyISO();
  const vencidos = data.pedidos.filter(p =>
    p.estado === 'generado' && p.fechaLimite && p.fechaLimite < hoy
  );
  if (vencidos.length === 0) return;

  caducandoPedidos = true;
  try {
    for (const p of vencidos) {
      for (const it of (p.items || [])) {
        if (!it.id) continue;
        const j = data.jumbos.find(x => x.id === it.id);
        const historial = [...(j ? j.historial || [] : []), nuevoEvento(`Apartado liberado — venció la fecha límite del pedido de ${p.cliente}`)];
        await db.from('jumbos').update({
          apartado: false, apartado_cliente: '', apartado_fecha: null, pedido_id: null, historial,
        }).eq('id', it.id);
      }
      await db.from('pedidos').delete().eq('id', p.id);
    }
    const n = vencidos.length;
    showToast(`${n} ${n === 1 ? 'pedido venció' : 'pedidos vencieron'} y se liberaron sus jumbos`, 4000);
  } finally {
    caducandoPedidos = false;
  }

  // recargar sin volver a entrar en la caducidad
  const [mat, jum, ped] = await Promise.all([
    db.from('materiales').select('*').order('nombre'),
    db.from('jumbos').select('*').order('created_at'),
    db.from('pedidos').select('*').order('created_at'),
  ]);
  data.materiales = (mat.data || []).map(mapMaterial);
  data.jumbos = (jum.data || []).map(mapJumbo);
  data.pedidos = (ped.data || []).map(mapPedido);
  renderTodo();
}

function suscribirRealtime() {
  if (canalRealtime) return;
  canalRealtime = db.channel('reciclaerp-v2')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'jumbos' }, () => cargarDatos())
    .on('postgres_changes', { event: '*', schema: 'public', table: 'pedidos' }, () => cargarDatos())
    .on('postgres_changes', { event: '*', schema: 'public', table: 'materiales' }, () => cargarDatos())
    .on('postgres_changes', { event: '*', schema: 'public', table: 'gastos' }, () => cargarDatos())
    .subscribe();
}

/* ---------- toasts ---------- */
function showToast(mensaje, tipoOduracion = 'exito', duracion = 2400) {
  // se puede llamar showToast(msg), showToast(msg, 'error') o showToast(msg, 'error', 4000)
  let tipo = 'exito';
  if (typeof tipoOduracion === 'number') { duracion = tipoOduracion; }
  else if (typeof tipoOduracion === 'string') { tipo = tipoOduracion; }

  const cont = document.getElementById('toast-container');
  const t = document.createElement('div');
  t.className = 'toast is-' + tipo;
  t.textContent = mensaje;
  cont.appendChild(t);
  setTimeout(() => {
    t.style.animation = 'toastOut .2s ease forwards';
    setTimeout(() => t.remove(), 200);
  }, duracion);
}

/* ---------- confirmación propia (reemplaza el confirm() del navegador) ---------- */
function confirmarAccion(mensaje, { textoConfirmar = 'Confirmar', peligroso = false } = {}) {
  return new Promise(resolve => {
    const overlay = document.getElementById('confirm-overlay');
    const box = overlay.querySelector('.confirm-box');
    const btnAceptar = document.getElementById('confirm-aceptar');
    const btnCancelar = document.getElementById('confirm-cancelar');

    document.getElementById('confirm-mensaje').textContent = mensaje;
    btnAceptar.textContent = textoConfirmar;
    box.classList.toggle('is-peligroso', peligroso);

    function cerrar(resultado) {
      overlay.classList.remove('is-active');
      btnAceptar.removeEventListener('click', onAceptar);
      btnCancelar.removeEventListener('click', onCancelar);
      overlay.removeEventListener('click', onOverlay);
      document.removeEventListener('keydown', onTecla);
      resolve(resultado);
    }
    function onAceptar() { cerrar(true); }
    function onCancelar() { cerrar(false); }
    function onOverlay(e) { if (e.target === overlay) cerrar(false); }
    function onTecla(e) { if (e.key === 'Escape') cerrar(false); if (e.key === 'Enter') cerrar(true); }

    btnAceptar.addEventListener('click', onAceptar);
    btnCancelar.addEventListener('click', onCancelar);
    overlay.addEventListener('click', onOverlay);
    document.addEventListener('keydown', onTecla);

    overlay.classList.add('is-active');
  });
}

/* ---------- confeti al cerrar una venta ---------- */
function lanzarConfeti() {
  const cont = document.getElementById('confetti-container');
  const colores = ['#1c1c1a', '#3f9d5c', '#3b6fe0', '#e08a3c', '#8b5cf6'];
  for (let i = 0; i < 46; i++) {
    const pieza = document.createElement('div');
    pieza.className = 'confetti-pieza';
    pieza.style.left = Math.random() * 100 + 'vw';
    pieza.style.background = colores[i % colores.length];
    pieza.style.animationDelay = (Math.random() * 0.3) + 's';
    pieza.style.animationDuration = (1.1 + Math.random() * 0.9) + 's';
    cont.appendChild(pieza);
    setTimeout(() => pieza.remove(), 2400);
  }
}

/* ---------- copiar folio con check animado ---------- */
function copiarTexto(texto, btn) {
  navigator.clipboard.writeText(texto).then(() => {
    btn.classList.add('is-copiado');
    setTimeout(() => btn.classList.remove('is-copiado'), 1200);
  }).catch(() => showToast('No se pudo copiar', 'error'));
}

function iconoCopiar() {
  return `
    <span class="icono-copiar">
      <svg viewBox="0 0 24 24"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>
    </span>
    <span class="icono-check">
      <svg viewBox="0 0 24 24"><path d="M5 13l4 4L19 7"/></svg>
    </span>
  `;
}

/* ---------- contador animado para las estadísticas ---------- */
const prevStats = {};
function animarNumero(el, desde, hasta, duracion = 380) {
  if (desde === hasta) { el.textContent = hasta; return; }
  const inicio = performance.now();
  function paso(ahora) {
    const t = Math.min(1, (ahora - inicio) / duracion);
    const suavizado = 1 - Math.pow(1 - t, 3);
    el.textContent = Math.round(desde + (hasta - desde) * suavizado);
    if (t < 1) requestAnimationFrame(paso);
  }
  requestAnimationFrame(paso);
}

/* ==========================================================
   NAVEGACIÓN ENTRE SECCIONES
   Se recuerda en qué ventana estabas, para que al recargar la
   página (o volver desde otra app) no te regrese al inicio.
   ========================================================== */
const UI_KEY = 'reciclaerp_ui';

function guardarUbicacionUI() {
  try {
    const nav = document.querySelector('.nav-item.is-active');
    const sub = document.querySelector('.subtab[data-subview].is-active');
    const vsub = document.querySelector('.subtab[data-ventasview].is-active');
    localStorage.setItem(UI_KEY, JSON.stringify({
      seccion: nav ? nav.dataset.section : null,
      subview: sub ? sub.dataset.subview : null,
      ventasview: vsub ? vsub.dataset.ventasview : null,
      rack: rackActivo,
    }));
  } catch (e) { /* si el navegador lo bloquea, no pasa nada */ }
}

function restaurarUbicacionUI() {
  let guardado;
  try { guardado = JSON.parse(localStorage.getItem(UI_KEY) || 'null'); } catch (e) { return; }
  if (!guardado) return;

  if (guardado.seccion) {
    const nav = document.querySelector(`.nav-item[data-section="${guardado.seccion}"]`);
    if (nav && !nav.hidden) nav.click();
  }
  if (guardado.subview) {
    const sub = document.querySelector(`.subtab[data-subview="${guardado.subview}"]`);
    if (sub) sub.click();
  }
  if (guardado.ventasview) {
    const vsub = document.querySelector(`.subtab[data-ventasview="${guardado.ventasview}"]`);
    if (vsub) vsub.click();
  }
  if (typeof guardado.rack === 'number') {
    rackActivo = guardado.rack;
    renderRackTabs();
    renderBoard();
  }
}

document.querySelectorAll('.nav-item').forEach(btn => {
  btn.addEventListener('click', () => {
    salirDeModoUbicacion();
    document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('is-active'));
    document.querySelectorAll('.view').forEach(v => v.classList.remove('is-active'));
    btn.classList.add('is-active');
    document.getElementById(`view-${btn.dataset.section}`).classList.add('is-active');
    // el tablero puede quedar "congelado" si sus celdas se crearon mientras
    // esta vista estaba oculta (la animación de entrada no corre en display:none) —
    // lo repintamos fresco cada vez que se entra a esta sección.
    if (btn.dataset.section === 'racks') { renderBoard(); renderInventario(); }
    if (btn.dataset.section === 'roles') cargarYRenderizarRoles();
    guardarUbicacionUI();
  });
});

document.querySelectorAll('.subtab[data-subview]').forEach(btn => {
  btn.addEventListener('click', () => {
    salirDeModoUbicacion();
    document.querySelectorAll('.subtab[data-subview]').forEach(b => b.classList.remove('is-active'));
    document.querySelectorAll('.subview').forEach(v => v.classList.remove('is-active'));
    btn.classList.add('is-active');
    document.getElementById(`subview-${btn.dataset.subview}`).classList.add('is-active');
    if (btn.dataset.subview === 'board') renderBoard();
    guardarUbicacionUI();
  });
});

/* ==========================================================
   RENDER: pestañas de racks + estadísticas
   ========================================================== */
function renderRackTabs() {
  const cont = document.getElementById('rack-tabs');
  cont.innerHTML = '';

  const todos = document.createElement('button');
  todos.className = 'rack-tab' + (rackActivo === 0 ? ' is-active' : '');
  todos.textContent = 'Todos';
  todos.addEventListener('click', () => { rackActivo = 0; renderTodo(); guardarUbicacionUI(); });
  cont.appendChild(todos);

  RACKS.forEach(n => {
    const b = document.createElement('button');
    b.className = 'rack-tab' + (n === rackActivo ? ' is-active' : '');
    b.textContent = `Rack ${n}`;
    b.addEventListener('click', () => { rackActivo = n; renderTodo(); guardarUbicacionUI(); });
    cont.appendChild(b);
  });
}

function renderStats() {
  const cont = document.getElementById('rack-stats');
  const enVista = rackActivo === 0
    ? data.jumbos.filter(j => j.posicion)
    : data.jumbos.filter(j => j.posicion && j.posicion.rack === rackActivo);
  const ocupados = enVista.length;
  const apartados = enVista.filter(j => j.apartado).length;
  const totalSlots = rackActivo === 0 ? 160 : 32;
  const vacios = totalSlots - ocupados;
  const pendientes = data.jumbos.filter(j => !j.posicion).length;

  cont.innerHTML = '';
  const stats = [
    ['Ocupados', ocupados],
    ['Apartados', apartados],
    ['Vacíos', vacios],
    ['Pend. piso', pendientes],
  ];
  stats.forEach(([label, num]) => {
    const el = document.createElement('div');
    el.className = 'stat';
    const numEl = document.createElement('span');
    numEl.className = 'stat-num';
    el.appendChild(numEl);
    const labelEl = document.createElement('span');
    labelEl.className = 'stat-label';
    labelEl.textContent = label;
    el.appendChild(labelEl);
    cont.appendChild(el);
    animarNumero(numEl, prevStats[label] ?? num, num);
    prevStats[label] = num;
  });
}

/* ==========================================================
   RENDER: panel de pendientes por ubicar
   ========================================================== */
let pendientesAbierto = false;

const pendientesHeadBtn = document.getElementById('pendientes-head');
if (pendientesHeadBtn) {
  pendientesHeadBtn.addEventListener('click', () => {
    pendientesAbierto = !pendientesAbierto;
    document.getElementById('pendientes-list').hidden = !pendientesAbierto;
    document.getElementById('pendientes-panel').classList.toggle('is-open', pendientesAbierto);
  });
}

function renderPendientes() {
  const panel = document.getElementById('pendientes-panel');
  const list = document.getElementById('pendientes-list');
  const countEl = document.getElementById('pendientes-count');
  const pendientes = data.jumbos.filter(j => !j.posicion);

  countEl.textContent = pendientes.length;
  panel.hidden = pendientes.length === 0;
  list.hidden = !pendientesAbierto;
  panel.classList.toggle('is-open', pendientesAbierto);
  list.innerHTML = '';

  pendientes.forEach(j => {
    const card = document.createElement('div');
    card.className = 'pendiente-card';
    card.innerHTML = `
      <div class="pendiente-top">
        <span class="pendiente-folio">${j.folio}</span>
        <span class="badge" style="background:${colorMaterial(j.material)}; color:#fff; border:none;">${j.material}</span>
      </div>
      <span class="pendiente-kg">${j.kilos} kg · ${j.color}</span>
      <button class="pendiente-btn">Ubicar</button>
    `;
    card.querySelector('.pendiente-btn').addEventListener('click', () => iniciarUbicacion(j.id));
    list.appendChild(card);
  });
}

/* ==========================================================
   BÚSQUEDA Y FILTRO DEL TABLERO DE RACKS
   ========================================================== */
let boardBusqueda = '';
let boardFiltroMateriales = new Set();

const boardBuscarInput = document.getElementById('board-buscar');
if (boardBuscarInput) {
  boardBuscarInput.addEventListener('input', () => {
    boardBusqueda = boardBuscarInput.value.trim().toUpperCase();
    renderBoard();
  });
}

const btnBoardFiltro = document.getElementById('btn-board-filtro');
const boardFiltroDropdown = document.getElementById('board-filtro-dropdown');
if (btnBoardFiltro) {
  btnBoardFiltro.addEventListener('click', (e) => {
    e.stopPropagation();
    boardFiltroDropdown.hidden = !boardFiltroDropdown.hidden;
  });
  document.addEventListener('click', (e) => {
    if (!boardFiltroDropdown.hidden && !boardFiltroDropdown.contains(e.target) && e.target !== btnBoardFiltro) {
      boardFiltroDropdown.hidden = true;
    }
  });
}

function renderBoardFiltroChips() {
  if (!boardFiltroDropdown) return;
  boardFiltroDropdown.innerHTML = '';

  const chipsWrap = document.createElement('div');
  chipsWrap.className = 'board-filtro-chips';

  const todos = document.createElement('button');
  todos.type = 'button';
  todos.className = 'venta-chip' + (boardFiltroMateriales.size === 0 ? ' is-active' : '');
  todos.textContent = 'Todos';
  todos.addEventListener('click', () => {
    boardFiltroMateriales.clear();
    renderBoardFiltroChips();
    renderBoard();
  });
  chipsWrap.appendChild(todos);

  data.materiales.forEach(m => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'venta-chip' + (boardFiltroMateriales.has(m.nombre) ? ' is-active' : '');
    chip.textContent = m.nombre;
    if (boardFiltroMateriales.has(m.nombre)) { chip.style.background = m.color; chip.style.borderColor = m.color; }
    chip.addEventListener('click', () => {
      if (boardFiltroMateriales.has(m.nombre)) boardFiltroMateriales.delete(m.nombre);
      else boardFiltroMateriales.add(m.nombre);
      renderBoardFiltroChips();
      renderBoard();
    });
    chipsWrap.appendChild(chip);
  });

  boardFiltroDropdown.appendChild(chipsWrap);

  const limpiar = document.createElement('button');
  limpiar.type = 'button';
  limpiar.className = 'board-filtro-limpiar';
  limpiar.textContent = 'Limpiar filtro';
  limpiar.addEventListener('click', () => {
    boardFiltroMateriales.clear();
    boardFiltroDropdown.hidden = true;
    renderBoardFiltroChips();
    renderBoard();
  });
  boardFiltroDropdown.appendChild(limpiar);

  updateBtnFiltroLabel();
}

function updateBtnFiltroLabel() {
  if (!btnBoardFiltro) return;
  const n = boardFiltroMateriales.size;
  btnBoardFiltro.classList.toggle('is-active-filtro', n > 0);
  btnBoardFiltro.querySelector('.btn-filtro-label')?.remove();
  if (n > 0) {
    const span = document.createElement('span');
    span.className = 'btn-filtro-label';
    span.textContent = n;
    btnBoardFiltro.appendChild(span);
  }
}

function coincideBusquedaTexto(jumbo) {
  if (!boardBusqueda) return false;
  if (jumbo.folio && jumbo.folio.toUpperCase().includes(boardBusqueda)) return true;
  if (jumbo.color && jumbo.color.toUpperCase().includes(boardBusqueda)) return true;
  if (jumbo.material && jumbo.material.toUpperCase().includes(boardBusqueda)) return true;
  return false;
}

function coincideFiltroMaterial(jumbo) {
  if (boardFiltroMateriales.size === 0) return true;
  return jumbo && boardFiltroMateriales.has(jumbo.material);
}

/* ==========================================================
   RENDER: tablero del rack
   ========================================================== */
function renderBoard() {
  const board = document.getElementById('rack-board');
  board.innerHTML = '';

  if (rackActivo === 0) {
    RACKS.forEach((rackNum, i) => {
      renderRackBlock(board, rackNum);
      if (i < RACKS.length - 1) {
        const sep = document.createElement('div');
        sep.className = 'rack-block-sep';
        board.appendChild(sep);
      }
    });
  } else {
    renderRackBlock(board, rackActivo);
  }

  if (boardBusqueda) {
    const target = board.querySelector('.cell[data-match="1"]');
    if (target) target.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
  }
}

function renderRackBlock(board, rackNum) {
  // título
  const titulo = document.createElement('div');
  titulo.className = 'rack-title';
  const ocupados = data.jumbos.filter(j => j.posicion && j.posicion.rack === rackNum).length;
  titulo.innerHTML = `
    <span class="rack-title-badge">${rackNum}</span>
    <div><h3>Rack ${rackNum}</h3><span>${ocupados} / 32 espacios ocupados</span></div>
  `;
  board.appendChild(titulo);

  // encabezados de sección
  const headers = document.createElement('div');
  headers.className = 'seccion-headers';
  headers.innerHTML = '<div></div>';
  SECCIONES.forEach(s => {
    const h = document.createElement('div');
    h.className = 'seccion-header';
    h.textContent = `SEC ${s} A·B`;
    headers.appendChild(h);
  });
  board.appendChild(headers);

  // filas por nivel
  let indiceCelda = 0;
  NIVELES.forEach(nivel => {
    const row = document.createElement('div');
    row.className = 'nivel-row';

    const tag = document.createElement('div');
    tag.className = 'nivel-tag';
    tag.innerHTML = `Nivel ${nivel}<span></span>`;
    row.appendChild(tag);

    SECCIONES.forEach(seccion => {
      LETRAS.forEach(letra => {
        const pos = { rack: rackNum, nivel, seccion, letra };
        const celda = renderCelda(pos);
        const factor = jumboEnUbicacion ? 0.018 : 0.01;
        celda.style.setProperty('--delay', `${indiceCelda * factor}s`);
        indiceCelda++;
        row.appendChild(celda);
      });
    });

    board.appendChild(row);
  });
}

function renderCelda(pos) {
  const jumbo = jumboEnPosicion(pos);
  const cell = document.createElement('button');
  cell.type = 'button';

  const numHum = numeroHumano(pos);
  const numTag = `<span class="cell-num">#${numHum}</span>`;

  const matchNum = boardBusqueda && /^\d+$/.test(boardBusqueda) && Number(boardBusqueda) === numHum;
  const matchTexto = jumbo && coincideBusquedaTexto(jumbo);
  const matchesBusqueda = !boardBusqueda || matchNum || matchTexto;
  const matchesFiltro = jumbo ? coincideFiltroMaterial(jumbo) : true;
  const hayFiltroActivo = !!boardBusqueda || boardFiltroMateriales.size > 0;
  const atenuada = hayFiltroActivo && !(matchesBusqueda && matchesFiltro);

  if (!jumbo) {
    // durante el modo "ubicar", los huecos vacíos se resaltan y asignan con un clic
    if (jumboEnUbicacion) {
      cell.className = 'cell is-empty is-target';
      cell.innerHTML = `<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>${numTag}`;
      cell.title = `Ubicar aquí: ${etiquetaPosicion(pos)}`;
      cell.addEventListener('click', () => confirmarUbicacion(pos));
      return cell;
    }
    cell.className = 'cell is-empty' + (atenuada ? ' is-dim' : '');
    cell.innerHTML = `<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>${numTag}`;
    cell.title = etiquetaPosicion(pos);
    if (boardBusqueda && matchNum) cell.dataset.match = '1';
    cell.addEventListener('click', () => abrirFormulario(pos));
    return cell;
  }

  cell.className = 'cell is-full' + (jumbo.apartado ? ' is-apartado' : '') + (atenuada ? ' is-dim' : '');
  cell.style.background = colorMaterial(jumbo.material);
  cell.innerHTML = `
    ${numTag}
    ${jumbo.apartado ? `<span class="apartado-badge">APARTADO</span>` : ''}
    <span class="cell-folio">${jumbo.folio}</span>
    <span class="cell-material">${jumbo.material} · ${jumbo.color}</span>
    <span class="cell-kg">${jumbo.kilos}kg</span>
    ${jumbo.apartado ? `<div class="cell-apartado-strip">${jumbo.apartadoCliente || 'Sin nombre'}</div>` : ''}
  `;
  if (boardBusqueda && (matchNum || matchTexto)) cell.dataset.match = '1';
  if (jumboEnUbicacion) {
    cell.disabled = true;
    cell.style.opacity = '.45';
  } else {
    cell.addEventListener('click', () => abrirDetalle(jumbo.id));
  }
  return cell;
}

/* ==========================================================
   RENDER: tabla de inventario (con búsqueda, orden y exportación)
   ========================================================== */
let invBusqueda = '';
let invOrden = 'folio-asc';

const invBuscarInput = document.getElementById('inv-buscar');
if (invBuscarInput) {
  invBuscarInput.addEventListener('input', () => {
    invBusqueda = invBuscarInput.value.trim().toUpperCase();
    renderInventario();
  });
}

const invOrdenSelect = document.getElementById('inv-orden');
if (invOrdenSelect) {
  invOrdenSelect.addEventListener('change', () => {
    invOrden = invOrdenSelect.value;
    renderInventario();
  });
}

function inventarioFiltradoOrdenado() {
  let lista = data.jumbos.filter(j => {
    if (!invBusqueda) return true;
    return j.folio.toUpperCase().includes(invBusqueda)
      || j.material.toUpperCase().includes(invBusqueda)
      || j.color.toUpperCase().includes(invBusqueda)
      || String(j.kilos).includes(invBusqueda);
  });

  lista = [...lista].sort((a, b) => {
    switch (invOrden) {
      case 'folio-desc': return b.folio.localeCompare(a.folio);
      case 'kilos-desc': return b.kilos - a.kilos;
      case 'kilos-asc': return a.kilos - b.kilos;
      case 'material-asc': return a.material.localeCompare(b.material) || a.folio.localeCompare(b.folio);
      case 'dias-desc': return diasEnAlmacen(b.fechaIngreso) - diasEnAlmacen(a.fechaIngreso);
      case 'dias-asc': return diasEnAlmacen(a.fechaIngreso) - diasEnAlmacen(b.fechaIngreso);
      case 'folio-asc':
      default: return a.folio.localeCompare(b.folio);
    }
  });

  return lista;
}

function renderInventario() {
  const tbody = document.getElementById('inv-tbody');
  const filas = inventarioFiltradoOrdenado();

  if (data.jumbos.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" class="inv-empty">Todavía no hay jumbos registrados.</td></tr>`;
    return;
  }
  if (filas.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" class="inv-empty">Sin resultados para esa búsqueda.</td></tr>`;
    return;
  }

  tbody.innerHTML = '';
  filas.forEach(j => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="inv-folio"><span class="inv-folio-texto">${j.folio}</span><button type="button" class="btn-copiar" title="Copiar folio">${iconoCopiar()}</button></td>
      <td>${j.material} · ${j.color}</td>
      <td>${j.kilos} kg</td>
      <td class="inv-ubicacion ${j.posicion ? '' : 'sin-ubicar'}">${j.posicion ? codigoPosicion(j.posicion) : 'Sin ubicar'}</td>
      <td>${diasEnAlmacen(j.fechaIngreso)}d</td>
      <td><span class="status-pill ${j.apartado ? 'apartado' : 'disponible'}">${j.apartado ? 'Apartado' : 'Disponible'}</span></td>
    `;
    tr.style.cursor = 'pointer';
    tr.addEventListener('click', () => abrirDetalle(j.id));
    const btnCopiar = tr.querySelector('.btn-copiar');
    btnCopiar.addEventListener('click', e => { e.stopPropagation(); copiarTexto(j.folio, btnCopiar); });
    tbody.appendChild(tr);
  });
}

function exportarInventarioCSV() {
  const filas = inventarioFiltradoOrdenado();
  const encabezados = ['Folio', 'Material', 'Variante', 'Kilos', 'Rack', 'Nivel', 'Sección', 'Posición #', 'Estatus', 'Cliente apartado', 'Fecha límite apartado', 'Fecha de ingreso', 'Días en almacén', 'Descripción'];
  const escapar = v => `"${String(v ?? '').replace(/"/g, '""')}"`;

  const lineas = [encabezados.map(escapar).join(',')];
  filas.forEach(j => {
    lineas.push([
      j.folio,
      j.material,
      j.color,
      j.kilos,
      j.posicion ? j.posicion.rack : '',
      j.posicion ? j.posicion.nivel : '',
      j.posicion ? `${j.posicion.seccion}${j.posicion.letra}` : '',
      j.posicion ? numeroHumano(j.posicion) : '',
      j.apartado ? 'Apartado' : 'Disponible',
      j.apartadoCliente || '',
      j.apartadoFecha || '',
      j.fechaIngreso,
      diasEnAlmacen(j.fechaIngreso),
      (j.descripcion || '').replace(/[\r\n]+/g, ' '),
    ].map(escapar).join(','));
  });

  const csv = '\uFEFF' + lineas.join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `reciclaerp_inventario_${hoyISO()}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  showToast('CSV generado');
}

const btnExportarInv = document.getElementById('btn-exportar-inv');
if (btnExportarInv) btnExportarInv.addEventListener('click', exportarInventarioCSV);

function renderTodo() {
  renderRackTabs();
  renderStats();
  renderPendientes();
  renderBoard();
  renderBoardFiltroChips();
  renderInventario();
  renderVentaChips();
  renderVentaLista();
  renderResumenVenta();
  renderPedidos();
  renderHistorial();
  renderMateriales();
  renderCaja();
  renderReportes();
}


/* ==========================================================
   OVERLAY / DRAWERS genéricos
   ========================================================== */
const overlay = document.getElementById('overlay');
const drawers = {
  form: document.getElementById('drawer-form'),
  detalle: document.getElementById('drawer-detalle'),
  apartar: document.getElementById('drawer-apartar'),
  material: document.getElementById('drawer-material'),
  historial: document.getElementById('drawer-historial'),
  gasto: document.getElementById('drawer-gasto'),
  pedido: document.getElementById('drawer-pedido'),
};

function abrirDrawer(nombre) {
  overlay.classList.add('is-active');
  drawers[nombre].classList.add('is-active');
}

function cerrarDrawers() {
  overlay.classList.remove('is-active');
  Object.values(drawers).forEach(d => d.classList.remove('is-active'));
  jumboEnDetalle = null;
}

overlay.addEventListener('click', cerrarDrawers);
document.querySelectorAll('[data-close-drawer]').forEach(b => b.addEventListener('click', cerrarDrawers));
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { cerrarDrawers(); salirDeModoUbicacion(); }
});

/* ==========================================================
   FORMULARIO: registrar / editar jumbo
   ========================================================== */
const form = document.getElementById('jumbo-form');
const selectMaterial = document.getElementById('f-material');
const selectVariante = document.getElementById('f-variante');
const inputFolio = document.getElementById('f-folio');
const btnFolioLock = document.getElementById('btn-folio-lock');

function renderSelectMaterialOptions() {
  const actual = selectMaterial.value;
  selectMaterial.innerHTML = '';
  data.materiales.forEach(m => {
    const opt = document.createElement('option');
    opt.value = m.nombre; opt.textContent = m.nombre;
    selectMaterial.appendChild(opt);
  });
  if (data.materiales.some(m => m.nombre === actual)) selectMaterial.value = actual;
  actualizarVariantesSelect();
}

function actualizarVariantesSelect(valorActual) {
  const mat = materialPorNombre(selectMaterial.value);
  selectVariante.innerHTML = '';
  (mat ? mat.variantes : []).forEach(v => {
    const opt = document.createElement('option');
    opt.value = v; opt.textContent = v;
    selectVariante.appendChild(opt);
  });
  if (valorActual) {
    if (mat && !mat.variantes.includes(valorActual)) {
      const opt = document.createElement('option');
      opt.value = valorActual; opt.textContent = valorActual + ' (anterior)';
      selectVariante.appendChild(opt);
    }
    selectVariante.value = valorActual;
  }
}

selectMaterial.addEventListener('change', () => actualizarVariantesSelect());

// folio: solo mayúsculas y números, sin espacios ni símbolos
inputFolio.addEventListener('input', () => {
  const cursor = inputFolio.selectionStart;
  const antes = inputFolio.value;
  const limpio = antes.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (limpio !== antes) {
    const diferencia = antes.length - limpio.length;
    inputFolio.value = limpio;
    const nuevaPos = Math.max(0, cursor - diferencia);
    inputFolio.setSelectionRange(nuevaPos, nuevaPos);
  }
});

function bloquearFolio(bloqueado) {
  inputFolio.disabled = bloqueado;
  btnFolioLock.classList.toggle('is-unlocked', !bloqueado);
  btnFolioLock.title = bloqueado ? 'Desbloquear para editar el folio manualmente' : 'Bloquear folio (usar autogenerado)';
}

btnFolioLock.addEventListener('click', () => {
  bloquearFolio(!inputFolio.disabled);
  if (!inputFolio.disabled) inputFolio.focus();
});

function abrirFormulario(pos = null, jumboExistente = null) {
  form.reset();
  renderSelectMaterialOptions();
  document.getElementById('f-id').value = jumboExistente ? jumboExistente.id : '';
  document.getElementById('f-fecha').value = jumboExistente ? jumboExistente.fechaIngreso : hoyISO();

  const sub = document.getElementById('form-position-sub');
  const posFinal = jumboExistente ? jumboExistente.posicion : pos;

  if (posFinal) {
    document.getElementById('f-rack').value = posFinal.rack;
    document.getElementById('f-nivel').value = posFinal.nivel;
    document.getElementById('f-seccion').value = posFinal.seccion;
    document.getElementById('f-letra').value = posFinal.letra;
    sub.hidden = false;
    sub.textContent = `Ubicación: ${etiquetaPosicion(posFinal)}`;
  } else {
    document.getElementById('f-rack').value = '';
    document.getElementById('f-nivel').value = '';
    document.getElementById('f-seccion').value = '';
    document.getElementById('f-letra').value = '';
    sub.hidden = true;
  }

  if (jumboExistente) {
    document.getElementById('form-title').textContent = 'Editar datos del cargamento';
    inputFolio.value = jumboExistente.folio;
    bloquearFolio(true);
    selectMaterial.value = jumboExistente.material;
    actualizarVariantesSelect(jumboExistente.color);
    document.getElementById('f-descripcion').value = jumboExistente.descripcion || '';
    document.getElementById('f-kilos').value = jumboExistente.kilos;
    form.querySelector('button[type="submit"]').textContent = 'Guardar cambios';
  } else {
    document.getElementById('form-title').textContent = 'Registrar nuevo cargamento';
    inputFolio.value = siguienteFolio();
    bloquearFolio(true);
    actualizarVariantesSelect();
    form.querySelector('button[type="submit"]').textContent = 'Registrar cargamento';
  }

  abrirDrawer('form');
}

document.getElementById('btn-nuevo-jumbo').addEventListener('click', () => abrirFormulario(null));

form.addEventListener('submit', async e => {
  e.preventDefault();

  const id = document.getElementById('f-id').value;
  const rack = document.getElementById('f-rack').value;
  const posicion = rack ? {
    rack: Number(rack),
    nivel: Number(document.getElementById('f-nivel').value),
    seccion: Number(document.getElementById('f-seccion').value),
    letra: document.getElementById('f-letra').value,
  } : null;

  const fila = {
    folio: document.getElementById('f-folio').value.trim(),
    material: selectMaterial.value,
    color: document.getElementById('f-variante').value,
    descripcion: document.getElementById('f-descripcion').value.trim(),
    kilos: Number(document.getElementById('f-kilos').value) || 0,
    fecha_ingreso: document.getElementById('f-fecha').value,
    rack: posicion ? posicion.rack : null,
    nivel: posicion ? posicion.nivel : null,
    seccion: posicion ? posicion.seccion : null,
    letra: posicion ? posicion.letra : null,
  };

  let error;
  if (id) {
    const previo = data.jumbos.find(x => x.id === id);
    const cambios = [];
    if (previo) {
      if (previo.folio !== fila.folio) cambios.push(`Folio: ${previo.folio} → ${fila.folio}`);
      if (previo.material !== fila.material) cambios.push(`Material: ${previo.material} → ${fila.material}`);
      if (previo.color !== fila.color) cambios.push(`Variante: ${previo.color} → ${fila.color}`);
      if (previo.kilos !== fila.kilos) cambios.push(`Kilos: ${previo.kilos} → ${fila.kilos}`);
      if (previo.fechaIngreso !== fila.fecha_ingreso) cambios.push(`Fecha de ingreso: ${previo.fechaIngreso} → ${fila.fecha_ingreso}`);
    }
    const historial = [...(previo ? previo.historial : [])];
    if (cambios.length) historial.push(nuevoEvento('Datos editados — ' + cambios.join(' · ')));
    ({ error } = await db.from('jumbos').update({ ...fila, historial }).eq('id', id));
  } else {
    fila.historial = [nuevoEvento(posicion ? `Cargamento registrado y ubicado en ${codigoPosicion(posicion)}` : 'Cargamento registrado (pendiente por ubicar)')];
    ({ error } = await db.from('jumbos').insert([fila]));
  }

  if (error) { showToast('No se pudo guardar: ' + error.message, 'error'); return; }

  cerrarDrawers();
  await cargarDatos();
  showToast(id ? 'Cambios guardados' : 'Cargamento registrado');
});

/* ==========================================================
   FICHA DEL JUMBO
   ========================================================== */
function abrirDetalle(id) {
  const j = data.jumbos.find(x => x.id === id);
  if (!j) return;
  jumboEnDetalle = id;

  document.getElementById('det-material-bar').style.background = colorMaterial(j.material);
  document.getElementById('det-folio').textContent = j.folio;
  const btnCopiarFolio = document.getElementById('det-copiar-folio');
  btnCopiarFolio.innerHTML = iconoCopiar();
  btnCopiarFolio.classList.remove('is-copiado');
  btnCopiarFolio.onclick = () => copiarTexto(j.folio, btnCopiarFolio);
  document.getElementById('det-dias').textContent = diasEnAlmacen(j.fechaIngreso);
  document.getElementById('det-fecha').textContent = j.fechaIngreso;
  document.getElementById('det-ubicacion').textContent = j.posicion ? etiquetaPosicion(j.posicion) : 'Pendiente por ubicar';
  document.getElementById('det-ubicacion-corta').textContent = j.posicion
    ? `${etiquetaPosicion(j.posicion)} · ${diasEnAlmacen(j.fechaIngreso)} días en almacén`
    : 'Pendiente por ubicar';

  const badges = document.getElementById('det-badges');
  badges.innerHTML = `
    <span class="badge badge-color" style="background:${colorMaterial(j.material)}">${j.material}</span>
    <span class="badge">${j.color}</span>
    <span class="badge">${j.kilos} kg</span>
  `;

  const notas = document.getElementById('det-notas');
  if (j.descripcion) { notas.hidden = false; notas.textContent = j.descripcion; notas.className = 'det-notas'; }
  else { notas.hidden = true; }

  renderAccionesFicha(j);
  abrirDrawer('detalle');
}

function renderAccionesFicha(j) {
  const cont = document.getElementById('det-actions');
  cont.innerHTML = '';

  // caja de info de apartado (si aplica) — se inserta antes de las notas ya renderizadas
  const notas = document.getElementById('det-notas');
  const boxExistente = notas.parentElement.querySelector('.det-apartado-box');
  if (boxExistente) boxExistente.remove();
  if (j.apartado) {
    const box = document.createElement('div');
    box.className = 'det-apartado-box';
    box.innerHTML = `<strong>APARTADO: ${j.apartadoCliente || '—'}</strong><span>Límite: ${j.apartadoFecha || '—'}</span>`;
    notas.insertAdjacentElement('afterend', box);
  }

  const btnMover = document.createElement('button');
  btnMover.className = 'btn btn-dark btn-block';
  btnMover.innerHTML = `<svg viewBox="0 0 24 24" class="btn-icon"><path d="M7 8l-4 4 4 4M17 8l4 4-4 4M3 12h18"/></svg> Mover`;
  btnMover.addEventListener('click', () => { const id = j.id; cerrarDrawers(); iniciarUbicacion(id); });
  cont.appendChild(btnMover);

  const btnHistorial = document.createElement('button');
  btnHistorial.className = 'btn btn-outline btn-block';
  btnHistorial.innerHTML = `<svg viewBox="0 0 24 24" class="btn-icon"><path d="M3 12a9 9 0 1 0 3-6.7M3 4v5h5"/><path d="M12 7v5l3 3"/></svg> Ver historial`;
  btnHistorial.addEventListener('click', () => abrirHistorialJumbo(j.id));
  cont.appendChild(btnHistorial);

  const row = document.createElement('div');
  row.className = 'det-actions-row';

  if (j.apartado) {
    const btnEditarApartado = document.createElement('button');
    btnEditarApartado.className = 'btn btn-outline';
    btnEditarApartado.textContent = j.pedidoId ? 'Ver pedido' : 'Editar apartado';
    btnEditarApartado.addEventListener('click', () => {
      if (j.pedidoId) {
        const p = data.pedidos.find(x => x.id === j.pedidoId);
        if (p) { cerrarDrawers(); abrirDetallePedido(p); return; }
      }
      abrirApartar(j.id);
    });

    const btnLiberar = document.createElement('button');
    btnLiberar.className = 'btn btn-outline';
    btnLiberar.textContent = 'Liberar apartado';
    btnLiberar.addEventListener('click', async () => {
      if (j.pedidoId) {
        showToast('Este jumbo pertenece a un pedido — deshazlo desde Ventas');
        return;
      }
      const historial = [...(j.historial || []), nuevoEvento('Apartado liberado')];
      const { error } = await db.from('jumbos')
        .update({ apartado: false, apartado_cliente: '', apartado_fecha: null, pedido_id: null, historial })
        .eq('id', j.id);
      if (error) { showToast('No se pudo liberar: ' + error.message, 'error'); return; }
      await cargarDatos();
      abrirDetalle(j.id);
      showToast('Apartado liberado');
    });

    row.appendChild(btnEditarApartado);
    row.appendChild(btnLiberar);
  } else {
    const btnEditarDatos = document.createElement('button');
    btnEditarDatos.className = 'btn btn-outline';
    btnEditarDatos.textContent = 'Editar datos';
    btnEditarDatos.addEventListener('click', () => { cerrarDrawers(); abrirFormulario(null, j); });

    const btnVerPedidos = document.createElement('button');
    btnVerPedidos.className = 'btn btn-outline';
    btnVerPedidos.textContent = 'Ir a ventas';
    btnVerPedidos.title = 'Los apartados se generan desde la ventana de Ventas';
    btnVerPedidos.addEventListener('click', () => {
      cerrarDrawers();
      const nav = document.querySelector('.nav-item[data-section="ventas"]');
      if (nav && !nav.hidden) nav.click();
    });

    row.appendChild(btnEditarDatos);
    row.appendChild(btnVerPedidos);
  }
  cont.appendChild(row);

  const btnVender = document.createElement('button');
  btnVender.className = 'btn btn-danger btn-block';
  btnVender.textContent = 'Vender / Bajar';
  btnVender.addEventListener('click', async () => {
    const ok = await confirmarAccion(`¿Dar de baja el jumbo ${j.folio}? Esta acción lo quita del almacén.`, { textoConfirmar: 'Dar de baja', peligroso: true });
    if (!ok) return;
    const { error } = await db.from('jumbos').delete().eq('id', j.id);
    if (error) { showToast('No se pudo dar de baja: ' + error.message, 'error'); return; }
    cerrarDrawers();
    await cargarDatos();
    showToast('Jumbo dado de baja');
  });
  cont.appendChild(btnVender);

  if (j.apartado) {
    const btnEditarDatos2 = document.createElement('button');
    btnEditarDatos2.className = 'btn btn-outline btn-block';
    btnEditarDatos2.textContent = 'Editar datos';
    btnEditarDatos2.addEventListener('click', () => { cerrarDrawers(); abrirFormulario(null, j); });
    cont.appendChild(btnEditarDatos2);
  }
}

/* ==========================================================
   APARTAR
   ========================================================== */
let jumboParaApartar = null;
const apartarForm = document.getElementById('apartar-form');

function abrirApartar(id) {
  const j = data.jumbos.find(x => x.id === id);
  if (!j) return;
  jumboParaApartar = id;
  document.getElementById('apartar-title').textContent = `Apartar ${j.folio}`;
  document.getElementById('ap-cliente').value = j.apartadoCliente || '';
  document.getElementById('ap-fecha').value = j.apartadoFecha || '';
  abrirDrawer('apartar');
}

function abrirHistorialJumbo(id) {
  const j = data.jumbos.find(x => x.id === id);
  if (!j) return;
  document.getElementById('historial-folio-sub').textContent = `${j.folio} · ${j.material} · ${j.color}`;
  const cont = document.getElementById('historial-jumbo-body');
  const eventos = [...(j.historial || [])].reverse();

  if (eventos.length === 0) {
    cont.innerHTML = `<div class="inv-empty">Sin eventos registrados todavía.</div>`;
  } else {
    cont.innerHTML = `<div class="historial-timeline">${eventos.map(ev => `
      <div class="historial-item">
        <span class="historial-dot"></span>
        <div class="historial-item-body">
          <span class="historial-fecha">${formatoFechaHora(ev.fecha)}</span>
          <span class="historial-texto">${ev.texto}</span>
        </div>
      </div>
    `).join('')}</div>`;
  }
  abrirDrawer('historial');
}

apartarForm.addEventListener('submit', async e => {
  e.preventDefault();
  const j = data.jumbos.find(x => x.id === jumboParaApartar);
  if (!j) return;
  const cliente = document.getElementById('ap-cliente').value.trim();
  const fecha = document.getElementById('ap-fecha').value;
  const historial = [...(j.historial || []), nuevoEvento(`Apartado para ${cliente || 'cliente sin nombre'}${fecha ? ' · límite ' + fecha : ''}`)];

  const { error } = await db.from('jumbos')
    .update({ apartado: true, apartado_cliente: cliente, apartado_fecha: fecha || null, historial })
    .eq('id', j.id);
  if (error) { showToast('No se pudo apartar: ' + error.message, 'error'); return; }

  cerrarDrawers();
  await cargarDatos();
  showToast('Apartado guardado');
});

/* ==========================================================
   UBICAR / MOVER — modo de asignación con clic directo
   ========================================================== */
function iniciarUbicacion(id) {
  const j = data.jumbos.find(x => x.id === id);
  if (!j) return;
  jumboEnUbicacion = id;
  cerrarDrawers();

  if (j.posicion) rackActivo = j.posicion.rack;
  renderTodo();

  document.getElementById('rack-board').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function salirDeModoUbicacion() {
  if (!jumboEnUbicacion) return;
  jumboEnUbicacion = null;
  renderTodo();
}

async function confirmarUbicacion(pos) {
  const j = data.jumbos.find(x => x.id === jumboEnUbicacion);
  if (!j) return;
  jumboEnUbicacion = null;
  const yaTenia = !!j.posicion;
  const historial = [...(j.historial || []), nuevoEvento(yaTenia ? `Movido a ${codigoPosicion(pos)}` : `Ubicado en ${codigoPosicion(pos)}`)];

  const { error } = await db.from('jumbos')
    .update({ rack: pos.rack, nivel: pos.nivel, seccion: pos.seccion, letra: pos.letra, historial })
    .eq('id', j.id);
  if (error) { showToast('No se pudo ubicar: ' + error.message, 'error'); renderTodo(); return; }

  rackActivo = pos.rack;
  await cargarDatos();
  showToast(`Ubicado en ${codigoPosicion(pos)}`);
}


/* ==========================================================
   VENTAS — armar pedido, apartar y cerrar la venta
   ========================================================== */
let ventaBusqueda = '';
let ventaFiltroMaterial = null;
let ventaSeleccion = new Set();

const ventaBuscarInput = document.getElementById('venta-buscar');
if (ventaBuscarInput) {
  ventaBuscarInput.addEventListener('input', () => {
    ventaBusqueda = ventaBuscarInput.value.trim().toUpperCase();
    renderVentaLista();
  });
}

document.querySelectorAll('.subtab[data-ventasview]').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.subtab[data-ventasview]').forEach(b => b.classList.remove('is-active'));
    document.querySelectorAll('.ventas-subview').forEach(v => v.classList.remove('is-active'));
    btn.classList.add('is-active');
    document.getElementById(`ventasview-${btn.dataset.ventasview}`).classList.add('is-active');
    guardarUbicacionUI();
  });
});

function renderVentaChips() {
  const cont = document.getElementById('venta-chips-material');
  if (!cont) return;
  cont.innerHTML = '';

  const todos = document.createElement('button');
  todos.className = 'venta-chip' + (ventaFiltroMaterial === null ? ' is-active' : '');
  todos.textContent = 'Todos';
  todos.addEventListener('click', () => { ventaFiltroMaterial = null; renderVentaChips(); renderVentaLista(); });
  cont.appendChild(todos);

  data.materiales.forEach(m => {
    const b = document.createElement('button');
    b.className = 'venta-chip' + (ventaFiltroMaterial === m.nombre ? ' is-active' : '');
    b.textContent = m.nombre;
    if (ventaFiltroMaterial === m.nombre) { b.style.background = m.color; b.style.borderColor = m.color; b.style.color = '#fff'; }
    b.addEventListener('click', () => { ventaFiltroMaterial = m.nombre; renderVentaChips(); renderVentaLista(); });
    cont.appendChild(b);
  });
}

function renderVentaLista() {
  const cont = document.getElementById('venta-lista');
  if (!cont) return;

  // solo se puede vender lo que NO está ya apartado en otro pedido
  const disponibles = data.jumbos
    .filter(j => !j.apartado)
    .filter(j => !ventaFiltroMaterial || j.material === ventaFiltroMaterial)
    .filter(j => {
      if (!ventaBusqueda) return true;
      return (j.folio || '').toUpperCase().includes(ventaBusqueda)
        || (j.material || '').toUpperCase().includes(ventaBusqueda)
        || (j.color || '').toUpperCase().includes(ventaBusqueda);
    });

  cont.innerHTML = '';

  if (disponibles.length === 0) {
    cont.innerHTML = `<div class="venta-lista-empty">No hay jumbos disponibles con esa búsqueda.</div>`;
    return;
  }

  disponibles.forEach(j => {
    const row = document.createElement('div');
    row.className = 'venta-row' + (ventaSeleccion.has(j.id) ? ' is-selected' : '');
    row.innerHTML = `
      <span class="venta-check"><svg viewBox="0 0 24 24"><path d="M5 13l4 4L19 7"/></svg></span>
      <div class="venta-row-main">
        <span class="venta-row-folio">${j.folio}</span>
        <span class="venta-row-mat" style="background:${colorMaterial(j.material)}">${j.material}</span>
        <span class="venta-row-color">${j.color}${j.posicion ? ' · ' + codigoPosicion(j.posicion) : ' · Sin ubicar'}</span>
        <span class="venta-row-kg">${j.kilos} kg</span>
      </div>
    `;
    row.addEventListener('click', () => {
      if (ventaSeleccion.has(j.id)) ventaSeleccion.delete(j.id);
      else ventaSeleccion.add(j.id);
      renderVentaLista();
      renderResumenVenta();
    });
    cont.appendChild(row);
  });
}

function renderResumenVenta() {
  const vacio = document.getElementById('resumen-vacio');
  const contenido = document.getElementById('resumen-contenido');
  if (!vacio) return;

  const seleccionados = data.jumbos.filter(j => ventaSeleccion.has(j.id));

  if (seleccionados.length === 0) {
    vacio.hidden = false;
    contenido.hidden = true;
    return;
  }
  vacio.hidden = true;
  contenido.hidden = false;

  const itemsCont = document.getElementById('resumen-items');
  itemsCont.innerHTML = '';
  seleccionados.forEach(j => {
    const el = document.createElement('div');
    el.className = 'resumen-item';
    el.innerHTML = `
      <span class="resumen-item-folio">${j.folio}</span>
      <span class="resumen-item-kg">${j.kilos} kg</span>
      <button type="button" class="resumen-item-quitar">×</button>
    `;
    el.querySelector('.resumen-item-quitar').addEventListener('click', () => {
      ventaSeleccion.delete(j.id);
      renderVentaLista();
      renderResumenVenta();
    });
    itemsCont.appendChild(el);
  });

  const kgTotal = seleccionados.reduce((sum, j) => sum + j.kilos, 0);
  document.getElementById('resumen-kg-total').textContent = `${kgTotal.toLocaleString('es-MX')} kg`;

  const porMaterial = {};
  seleccionados.forEach(j => { porMaterial[j.material] = (porMaterial[j.material] || 0) + j.kilos; });
  const matsCont = document.getElementById('resumen-materiales');
  matsCont.innerHTML = '';
  Object.entries(porMaterial).forEach(([mat, kg]) => {
    const chip = document.createElement('span');
    chip.className = 'resumen-mat-chip';
    chip.style.background = colorMaterial(mat);
    chip.textContent = `${mat} · ${kg}kg`;
    matsCont.appendChild(chip);
  });
}

/* ---------- generar pedido: aparta los jumbos automáticamente ---------- */
const ventaForm = document.getElementById('venta-form');
if (ventaForm) {
  const fechaInput = document.getElementById('venta-fecha');
  fechaInput.value = hoyISO();
  const limiteInput = document.getElementById('venta-limite');
  if (limiteInput) limiteInput.value = enDias(7);

  ventaForm.addEventListener('submit', async e => {
    e.preventDefault();
    const seleccionados = data.jumbos.filter(j => ventaSeleccion.has(j.id));
    if (seleccionados.length === 0) return;

    const cliente = document.getElementById('venta-cliente').value.trim();

    const pedidoRow = {
      cliente,
      fecha: document.getElementById('venta-fecha').value,
      precio_total: Number(document.getElementById('venta-precio').value) || 0,
      kilos_total: seleccionados.reduce((sum, j) => sum + j.kilos, 0),
      items: seleccionados.map(j => ({
        id: j.id, folio: j.folio, material: j.material, color: j.color, kilos: j.kilos,
        ubicacion: j.posicion ? codigoPosicion(j.posicion) : 'Sin ubicar',
      })),
      estado: 'generado',
      fecha_limite: document.getElementById('venta-limite').value,
      creado_por: currentProfile ? currentProfile.email : '',
    };

    const { data: creado, error } = await db.from('pedidos').insert([pedidoRow]).select().single();
    if (error) { showToast('No se pudo generar el pedido: ' + error.message, 'error'); return; }

    // apartar cada jumbo del pedido
    for (const j of seleccionados) {
      const historial = [...(j.historial || []), nuevoEvento(`Apartado por pedido de ${cliente || 'cliente sin nombre'}`)];
      await db.from('jumbos').update({
        apartado: true,
        apartado_cliente: cliente,
        apartado_fecha: pedidoRow.fecha,
        pedido_id: creado.id,
        historial,
      }).eq('id', j.id);
    }

    ventaSeleccion.clear();
    ventaForm.reset();
    fechaInput.value = hoyISO();
    if (limiteInput) limiteInput.value = enDias(7);

    await cargarDatos();
    showToast('Pedido generado y jumbos apartados');

    // saltar a la pestaña de pedidos
    const tabPedidos = document.querySelector('[data-ventasview="pedidos"]');
    if (tabPedidos) tabPedidos.click();
  });
}

/* ---------- pedidos generados ---------- */
function renderPedidos() {
  const cont = document.getElementById('pedidos-grid');
  if (!cont) return;

  const abiertos = data.pedidos.filter(p => p.estado === 'generado');

  const badge = document.getElementById('pedidos-abiertos-count');
  if (badge) {
    badge.textContent = abiertos.length;
    badge.hidden = abiertos.length === 0;
  }

  cont.innerHTML = '';
  if (abiertos.length === 0) {
    cont.innerHTML = `<div class="pedidos-vacio">No hay pedidos pendientes. Arma uno en la pestaña "Armar pedido".</div>`;
    return;
  }

  [...abiertos].reverse().forEach(p => {
    const card = document.createElement('div');
    card.className = 'pedido-card';
    const chips = p.items.slice(0, 8).map(it => `<span class="pedido-folio-chip">${it.folio}</span>`).join('');
    const extra = p.items.length > 8 ? `<span class="pedido-folio-chip">+${p.items.length - 8}</span>` : '';

    const dias = diasHasta(p.fechaLimite);
    let avisoLimite = '';
    if (dias !== null) {
      const clase = dias <= 1 ? 'urgente' : dias <= 3 ? 'pronto' : '';
      const texto = dias === 0 ? 'Vence hoy'
        : dias === 1 ? 'Vence mañana'
        : dias < 0 ? 'Vencido'
        : `Vence en ${dias} días`;
      avisoLimite = `<div class="pedido-limite ${clase}">${texto} · ${p.fechaLimite}</div>`;
    }

    card.innerHTML = `
      <div class="pedido-card-head">
        <div>
          <div class="pedido-cliente">${p.cliente}</div>
          <div class="pedido-fecha">${p.fecha}${p.creadoPor ? ' · ' + p.creadoPor : ''}</div>
        </div>
        <span class="pedido-estado">APARTADO</span>
      </div>
      <div class="pedido-resumen">
        <div class="pedido-dato"><span class="pedido-dato-num">${p.items.length}</span><span class="pedido-dato-label">jumbos</span></div>
        <div class="pedido-dato"><span class="pedido-dato-num">${p.kilosTotal.toLocaleString('es-MX')}</span><span class="pedido-dato-label">kilos</span></div>
        <div class="pedido-dato"><span class="pedido-dato-num">$${p.precioTotal.toLocaleString('es-MX')}</span><span class="pedido-dato-label">total</span></div>
      </div>
      ${avisoLimite}
      <div class="pedido-folios">${chips}${extra}</div>
      <div class="pedido-acciones">
        <button type="button" class="btn btn-outline btn-deshacer">Deshacer</button>
        <button type="button" class="btn btn-dark btn-vendido">Pedido vendido</button>
      </div>
      <button type="button" class="btn btn-outline btn-block btn-ver-pedido">Editar pedido</button>
    `;

    card.querySelector('.btn-deshacer').addEventListener('click', () => deshacerPedido(p));
    card.querySelector('.btn-vendido').addEventListener('click', () => marcarPedidoVendido(p));
    card.querySelector('.btn-ver-pedido').addEventListener('click', () => abrirDetallePedido(p));
    cont.appendChild(card);
  });
}

async function deshacerPedido(p) {
  const ok = await confirmarAccion(`¿Deshacer el pedido de ${p.cliente}? Los ${p.items.length} jumbos se liberan y vuelven a estar disponibles.`, { textoConfirmar: 'Deshacer pedido' });
  if (!ok) return;

  const ids = p.items.map(it => it.id).filter(Boolean);
  for (const id of ids) {
    const j = data.jumbos.find(x => x.id === id);
    const historial = [...(j ? j.historial || [] : []), nuevoEvento('Apartado liberado (pedido deshecho)')];
    await db.from('jumbos').update({
      apartado: false, apartado_cliente: '', apartado_fecha: null, pedido_id: null, historial,
    }).eq('id', id);
  }

  const { error } = await db.from('pedidos').delete().eq('id', p.id);
  if (error) { showToast('No se pudo deshacer: ' + error.message, 'error'); return; }

  cerrarDrawers();
  await cargarDatos();
  showToast('Pedido deshecho y jumbos liberados');
}

async function marcarPedidoVendido(p) {
  if (!p.precioTotal || p.precioTotal <= 0) {
    showToast('Ponle un precio antes de marcar el pedido como vendido');
    abrirDetallePedido(p);
    return;
  }
  const ok = await confirmarAccion(`¿Marcar como vendido el pedido de ${p.cliente}? Los ${p.items.length} jumbos salen del almacén.`, { textoConfirmar: 'Marcar vendido' });
  if (!ok) return;

  const { error } = await db.from('pedidos')
    .update({ estado: 'vendido', vendido_at: new Date().toISOString() })
    .eq('id', p.id);
  if (error) { showToast('No se pudo cerrar la venta: ' + error.message, 'error'); return; }

  const ids = p.items.map(it => it.id).filter(Boolean);
  if (ids.length) await db.from('jumbos').delete().in('id', ids);

  cerrarDrawers();
  await cargarDatos();
  showToast('Pedido vendido');
  lanzarConfeti();

  const tabHistorial = document.querySelector('[data-ventasview="historial"]');
  if (tabHistorial) tabHistorial.click();
}

function abrirDetallePedido(p) {
  document.getElementById('pedido-title').textContent = p.cliente;
  document.getElementById('pedido-sub').textContent =
    `${p.fecha} · ${p.items.length} jumbos · ${p.kilosTotal.toLocaleString('es-MX')} kg` +
    (p.estado === 'vendido' ? ' · VENDIDO' : ' · APARTADO');

  const body = document.getElementById('pedido-body');

  if (p.estado === 'vendido') {
    const filas = p.items.map(it => `
      <tr>
        <td class="inv-folio">${it.folio}</td>
        <td>${it.material} · ${it.color}</td>
        <td>${it.kilos} kg</td>
        <td class="inv-ubicacion">${it.ubicacion || '—'}</td>
      </tr>
    `).join('');

    body.innerHTML = `
      <div class="det-grid">
        <div><p class="det-label">Kilos totales</p><p class="det-value">${p.kilosTotal.toLocaleString('es-MX')} kg</p></div>
        <div><p class="det-label">Precio total</p><p class="det-value">$${p.precioTotal.toLocaleString('es-MX')}</p></div>
      </div>
      <div class="inv-table-wrap inv-table-plain">
        <table class="inv-table">
          <thead><tr><th>Folio</th><th>Material</th><th>Kilos</th><th>Ubicación</th></tr></thead>
          <tbody>${filas}</tbody>
        </table>
      </div>
      <div class="det-actions">
        <button type="button" class="btn btn-dark btn-block" id="ep-ver-factura">Ver factura</button>
      </div>
    `;
    document.getElementById('ep-ver-factura').addEventListener('click', () => imprimirFactura(p));
    abrirDrawer('pedido');
    return;
  }

  // ---- pedido "generado": editable ----
  body.innerHTML = `
    <div class="field-row">
      <div class="field">
        <label for="ep-precio">Precio total ($)</label>
        <input type="number" id="ep-precio" min="0" step="1" value="${p.precioTotal || ''}" placeholder="0">
      </div>
      <div class="field">
        <label for="ep-limite">Fecha límite de pago</label>
        <input type="date" id="ep-limite" value="${p.fechaLimite || ''}">
      </div>
    </div>

    <div class="pedido-edit-items" id="pedido-edit-items"></div>

    <div class="field">
      <label>Agregar jumbo al pedido</label>
      <input type="text" id="ep-buscar" class="venta-buscar" placeholder="Buscar por folio, material o variante...">
      <div class="venta-lista-wrap ep-resultados-wrap">
        <div class="venta-lista" id="ep-resultados"></div>
      </div>
    </div>

    <div class="det-actions">
      <button type="button" class="btn btn-dark btn-block" id="ep-vendido">Pedido vendido</button>
      <div class="det-actions-row">
        <button type="button" class="btn btn-outline" id="ep-guardar">Guardar cambios</button>
        <button type="button" class="btn btn-outline" id="ep-deshacer">Deshacer pedido</button>
      </div>
    </div>
  `;

  renderPedidoEditItems(p);
  renderPedidoEditBuscador(p);

  document.getElementById('ep-guardar').addEventListener('click', () => guardarPrecioPedido(p));
  document.getElementById('ep-vendido').addEventListener('click', () => marcarPedidoVendido({ ...p, precioTotal: Number(document.getElementById('ep-precio').value) || p.precioTotal }));
  document.getElementById('ep-deshacer').addEventListener('click', () => deshacerPedido(p));

  abrirDrawer('pedido');
}

function renderPedidoEditItems(p) {
  const cont = document.getElementById('pedido-edit-items');
  if (!cont) return;
  cont.innerHTML = p.items.map(it => `
    <div class="resumen-item" data-item-id="${it.id}">
      <span class="resumen-item-folio">${it.folio}</span>
      <span class="resumen-item-kg">${it.kilos} kg</span>
      <button type="button" class="resumen-item-quitar" title="Quitar del pedido">×</button>
    </div>
  `).join('');
  cont.querySelectorAll('.resumen-item-quitar').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.closest('.resumen-item').dataset.itemId;
      quitarItemDePedido(p, id);
    });
  });
}

function renderPedidoEditBuscador(p) {
  const input = document.getElementById('ep-buscar');
  const cont = document.getElementById('ep-resultados');
  if (!input || !cont) return;

  function pintar() {
    const q = input.value.trim().toUpperCase();
    const yaEnPedido = new Set(p.items.map(it => it.id));
    const disponibles = data.jumbos
      .filter(j => !j.apartado && !yaEnPedido.has(j.id))
      .filter(j => !q || (j.folio || '').toUpperCase().includes(q) || (j.material || '').toUpperCase().includes(q) || (j.color || '').toUpperCase().includes(q))
      .slice(0, 30);

    if (!q) { cont.innerHTML = ''; return; }

    if (disponibles.length === 0) {
      cont.innerHTML = `<div class="venta-lista-empty">Sin resultados.</div>`;
      return;
    }
    cont.innerHTML = '';
    disponibles.forEach(j => {
      const row = document.createElement('div');
      row.className = 'venta-row';
      row.innerHTML = `
        <div class="venta-row-main">
          <span class="venta-row-folio">${j.folio}</span>
          <span class="venta-row-mat" style="background:${colorMaterial(j.material)}">${j.material}</span>
          <span class="venta-row-color">${j.color}</span>
          <span class="venta-row-kg">${j.kilos} kg</span>
        </div>
      `;
      row.addEventListener('click', () => agregarItemAPedido(p, j));
      cont.appendChild(row);
    });
  }

  input.addEventListener('input', pintar);
}

async function quitarItemDePedido(p, itemId) {
  const j = data.jumbos.find(x => x.id === itemId);
  if (j) {
    const historial = [...(j.historial || []), nuevoEvento('Quitado del pedido')];
    await db.from('jumbos').update({
      apartado: false, apartado_cliente: '', apartado_fecha: null, pedido_id: null, historial,
    }).eq('id', itemId);
  }

  const nuevosItems = p.items.filter(it => it.id !== itemId);

  if (nuevosItems.length === 0) {
    await db.from('pedidos').delete().eq('id', p.id);
    cerrarDrawers();
    await cargarDatos();
    showToast('Pedido eliminado (ya no tenía jumbos)');
    return;
  }

  const kilosTotal = nuevosItems.reduce((s, it) => s + Number(it.kilos || 0), 0);
  await db.from('pedidos').update({ items: nuevosItems, kilos_total: kilosTotal }).eq('id', p.id);

  await cargarDatos();
  const actualizado = data.pedidos.find(x => x.id === p.id);
  if (actualizado) abrirDetallePedido(actualizado);
  showToast('Jumbo quitado del pedido');
}

async function agregarItemAPedido(p, j) {
  const historial = [...(j.historial || []), nuevoEvento(`Apartado por pedido de ${p.cliente || 'cliente sin nombre'}`)];
  await db.from('jumbos').update({
    apartado: true, apartado_cliente: p.cliente, apartado_fecha: p.fecha, pedido_id: p.id, historial,
  }).eq('id', j.id);

  const nuevoItem = { id: j.id, folio: j.folio, material: j.material, color: j.color, kilos: j.kilos, ubicacion: j.posicion ? codigoPosicion(j.posicion) : 'Sin ubicar' };
  const nuevosItems = [...p.items, nuevoItem];
  const kilosTotal = nuevosItems.reduce((s, it) => s + Number(it.kilos || 0), 0);

  await db.from('pedidos').update({ items: nuevosItems, kilos_total: kilosTotal }).eq('id', p.id);

  await cargarDatos();
  const actualizado = data.pedidos.find(x => x.id === p.id);
  if (actualizado) abrirDetallePedido(actualizado);
  showToast(`${j.folio} agregado al pedido`);
}

async function guardarPrecioPedido(p) {
  const precio = Number(document.getElementById('ep-precio').value) || 0;
  const limite = document.getElementById('ep-limite').value || null;
  const { error } = await db.from('pedidos')
    .update({ precio_total: precio, fecha_limite: limite })
    .eq('id', p.id);
  if (error) { showToast('No se pudo guardar: ' + error.message, 'error'); return; }
  await cargarDatos();
  showToast('Pedido actualizado');
}

function renderHistorial() {
  const tbody = document.getElementById('historial-tbody');
  if (!tbody) return;
  tbody.innerHTML = '';

  const vendidos = data.pedidos.filter(p => p.estado === 'vendido');

  if (vendidos.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" class="inv-empty">Todavía no hay ventas cerradas.</td></tr>`;
    return;
  }

  [...vendidos].reverse().forEach(p => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${p.cliente}</td>
      <td>${p.fecha}</td>
      <td>${p.items.length}</td>
      <td>${p.kilosTotal.toLocaleString('es-MX')} kg</td>
      <td>$${p.precioTotal.toLocaleString('es-MX')}</td>
      <td><button class="btn-factura">Ver factura</button></td>
    `;
    tr.querySelector('.btn-factura').addEventListener('click', e => { e.stopPropagation(); imprimirFactura(p); });
    tr.style.cursor = 'pointer';
    tr.addEventListener('click', () => abrirDetallePedido(p));
    tbody.appendChild(tr);
  });
}

function imprimirFactura(pedido) {
  const filas = pedido.items.map(it => `
    <tr>
      <td>${it.folio}</td>
      <td>${it.material}</td>
      <td>${it.color}</td>
      <td>${it.kilos} kg</td>
    </tr>
  `).join('');

  document.getElementById('invoice-print').innerHTML = `
    <h1>ReciclaERP</h1>
    <p class="inv-meta">Factura de venta · ${pedido.fecha}</p>
    <div class="inv-parties">
      <div><strong>Comprador</strong>${pedido.cliente}</div>
      <div><strong>Folios incluidos</strong>${pedido.items.length}</div>
      <div><strong>Kilos totales</strong>${pedido.kilosTotal.toLocaleString('es-MX')} kg</div>
    </div>
    <table>
      <thead>
        <tr><th>Folio</th><th>Material</th><th>Variante</th><th>Kilos</th></tr>
      </thead>
      <tbody>${filas}</tbody>
    </table>
    <div class="inv-totales">
      <span>Total</span>
      <strong>$${pedido.precioTotal.toLocaleString('es-MX')}</strong>
    </div>
  `;
  window.print();
}

/* ==========================================================
   MATERIALES: catálogo (materiales + variantes)
   ========================================================== */
let materialEnEdicion = null; // id o null (nuevo)
let variantesTemp = [];

function renderMateriales() {
  const cont = document.getElementById('materiales-grid');
  if (!cont) return;
  cont.innerHTML = '';

  if (data.materiales.length === 0) {
    cont.innerHTML = `<div class="inv-empty">Todavía no hay materiales registrados.</div>`;
    return;
  }

  data.materiales.forEach(m => {
    const card = document.createElement('div');
    card.className = 'material-card';
    card.innerHTML = `
      <div class="material-card-head">
        <span class="material-swatch" style="background:${m.color}"></span>
        <h3>${m.nombre}</h3>
      </div>
      <span class="material-costo">Costo: $${(m.costoPorKg || 0).toLocaleString('es-MX')} / kg</span>
      <div class="material-variantes">
        ${m.variantes.length ? m.variantes.map(v => `<span class="material-variante-tag">${v}</span>`).join('') : '<span class="material-variante-tag">Sin variantes</span>'}
      </div>
      <div class="material-card-actions">
        <button type="button" class="btn btn-outline btn-sm btn-editar-material">Editar</button>
        <button type="button" class="btn btn-outline btn-sm btn-eliminar-material">Eliminar</button>
      </div>
    `;
    card.querySelector('.btn-editar-material').addEventListener('click', () => abrirMaterialForm(m));
    card.querySelector('.btn-eliminar-material').addEventListener('click', async () => {
      const enUso = data.jumbos.some(j => j.material === m.nombre);
      const msg = enUso
        ? `Hay jumbos registrados con "${m.nombre}". ¿Eliminarlo del catálogo de todas formas?`
        : `¿Eliminar el material "${m.nombre}"?`;
      if (!(await confirmarAccion(msg, { textoConfirmar: 'Eliminar', peligroso: true }))) return;
      const { error } = await db.from('materiales').delete().eq('id', m.id);
      if (error) { showToast('No se pudo eliminar: ' + error.message, 'error'); return; }
      await cargarDatos();
      showToast('Material eliminado');
    });
    cont.appendChild(card);
  });
}

const matForm = document.getElementById('material-form');
const matVarianteInput = document.getElementById('mat-variante-input');
const matVarianteAddBtn = document.getElementById('mat-variante-add');

function renderVariantesTempList() {
  const cont = document.getElementById('mat-variantes-list');
  cont.innerHTML = '';
  if (variantesTemp.length === 0) {
    cont.innerHTML = `<span class="mat-variantes-vacio">Agrega al menos una variante (ej. Natural, Negro, Mixto)</span>`;
  }
  variantesTemp.forEach((v, i) => {
    const chip = document.createElement('span');
    chip.className = 'mat-variante-chip';
    chip.innerHTML = `${v} <button type="button">×</button>`;
    chip.querySelector('button').addEventListener('click', () => {
      variantesTemp.splice(i, 1);
      renderVariantesTempList();
    });
    cont.appendChild(chip);
  });
}

if (matVarianteAddBtn) {
  matVarianteAddBtn.addEventListener('click', () => {
    const val = matVarianteInput.value.trim();
    if (!val) return;
    if (variantesTemp.some(v => v.toLowerCase() === val.toLowerCase())) { matVarianteInput.value = ''; return; }
    variantesTemp.push(val);
    matVarianteInput.value = '';
    renderVariantesTempList();
    matVarianteInput.focus();
  });
  matVarianteInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); matVarianteAddBtn.click(); }
  });
}

function abrirMaterialForm(material = null) {
  if (matForm) matForm.reset();
  materialEnEdicion = material ? material.id : null;
  variantesTemp = material ? [...material.variantes] : [];

  document.getElementById('mat-drawer-title').textContent = material ? 'Editar material' : 'Nuevo material';
  document.getElementById('mat-nombre').value = material ? material.nombre : '';
  document.getElementById('mat-color').value = material ? material.color : '#6b7280';
  document.getElementById('mat-costo').value = material ? (material.costoPorKg || 0) : '';

  renderVariantesTempList();
  abrirDrawer('material');
}

const btnNuevoMaterial = document.getElementById('btn-nuevo-material');
if (btnNuevoMaterial) btnNuevoMaterial.addEventListener('click', () => abrirMaterialForm(null));

if (matForm) {
  matForm.addEventListener('submit', async e => {
    e.preventDefault();
    const nombre = document.getElementById('mat-nombre').value.trim();
    const color = document.getElementById('mat-color').value;
    const costoPorKg = Number(document.getElementById('mat-costo').value) || 0;

    if (variantesTemp.length === 0) { showToast('Agrega al menos una variante'); return; }

    let error;
    if (materialEnEdicion) {
      const m = data.materiales.find(x => x.id === materialEnEdicion);
      const nombreAnterior = m ? m.nombre : null;
      ({ error } = await db.from('materiales')
        .update({ nombre, color, costo_por_kg: costoPorKg, variantes: variantesTemp })
        .eq('id', materialEnEdicion));
      // si cambió el nombre, actualizamos los jumbos que lo usaban
      if (!error && nombreAnterior && nombreAnterior !== nombre) {
        await db.from('jumbos').update({ material: nombre }).eq('material', nombreAnterior);
      }
    } else {
      ({ error } = await db.from('materiales')
        .insert([{ nombre, color, costo_por_kg: costoPorKg, variantes: variantesTemp }]));
    }

    if (error) { showToast('No se pudo guardar el material: ' + error.message, 'error'); return; }

    cerrarDrawers();
    await cargarDatos();
    showToast(materialEnEdicion ? 'Material actualizado' : 'Material creado');
  });
}

/* ==========================================================
   CAJA CHICA
   ========================================================== */
let cajaPeriodo = 'dia';
let gastoBusqueda = '';
let gastoEnEdicion = null;

const CATEGORIAS_GASTO = ['Combustible', 'Mantenimiento', 'Insumos', 'Alimentos', 'Transporte', 'Herramienta', 'Papelería', 'General'];

function inicioDelDia(d = new Date()) { const x = new Date(d); x.setHours(0,0,0,0); return x; }
function inicioDeLaSemana() {
  const x = inicioDelDia();
  const dia = x.getDay();              // 0 = domingo
  const desplazamiento = dia === 0 ? 6 : dia - 1;   // la semana arranca en lunes
  x.setDate(x.getDate() - desplazamiento);
  return x;
}
function inicioDelMes() { const x = inicioDelDia(); x.setDate(1); return x; }

function fechaDeGasto(g) { return new Date(g.fecha + 'T00:00:00'); }

function gastosDelPeriodo(periodo) {
  if (periodo === 'todo') return [...data.gastos];
  const desde = periodo === 'dia' ? inicioDelDia() : periodo === 'semana' ? inicioDeLaSemana() : inicioDelMes();
  return data.gastos.filter(g => fechaDeGasto(g) >= desde);
}

function sumaGastos(lista) { return lista.reduce((s, g) => s + g.monto, 0); }
function dinero(n) { return '$' + Number(n || 0).toLocaleString('es-MX', { maximumFractionDigits: 2 }); }

function renderCajaKPIs() {
  if (!document.getElementById('kpi-dia')) return;
  [['dia', 'kpi-dia'], ['semana', 'kpi-semana'], ['mes', 'kpi-mes'], ['todo', 'kpi-todo']].forEach(([p, id]) => {
    const lista = gastosDelPeriodo(p);
    document.getElementById(id).textContent = dinero(sumaGastos(lista));
    document.getElementById(id + '-sub').textContent = `${lista.length} ${lista.length === 1 ? 'gasto' : 'gastos'}`;
  });
  document.querySelectorAll('[data-periodo]').forEach(b => {
    b.classList.toggle('is-active', b.dataset.periodo === cajaPeriodo);
  });
  const lbl = document.getElementById('cat-periodo-label');
  if (lbl) {
    const nombres = { dia: '(hoy)', semana: '(esta semana)', mes: '(este mes)', todo: '(histórico)' };
    lbl.textContent = nombres[cajaPeriodo];
  }
}

document.querySelectorAll('[data-periodo]').forEach(btn => {
  btn.addEventListener('click', () => { cajaPeriodo = btn.dataset.periodo; renderCaja(); });
});

const gastoBuscarInput = document.getElementById('gasto-buscar');
if (gastoBuscarInput) {
  gastoBuscarInput.addEventListener('input', () => {
    gastoBusqueda = gastoBuscarInput.value.trim().toLowerCase();
    renderGastosTabla();
  });
}

function gastosFiltrados() {
  return gastosDelPeriodo(cajaPeriodo)
    .filter(g => {
      if (!gastoBusqueda) return true;
      return (g.persona || '').toLowerCase().includes(gastoBusqueda)
        || (g.descripcion || '').toLowerCase().includes(gastoBusqueda)
        || (g.categoria || '').toLowerCase().includes(gastoBusqueda);
    })
    .sort((a, b) => (a.fecha < b.fecha ? 1 : a.fecha > b.fecha ? -1 : 0));
}

function renderGastosTabla() {
  const tbody = document.getElementById('gastos-tbody');
  if (!tbody) return;
  const filas = gastosFiltrados();
  tbody.innerHTML = '';

  if (filas.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" class="inv-empty">No hay gastos registrados en este periodo.</td></tr>`;
    return;
  }

  filas.forEach(g => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${g.fecha}</td>
      <td>${g.persona}</td>
      <td>${g.descripcion}</td>
      <td><span class="rol-badge">${g.categoria}</span></td>
      <td class="gasto-monto">${dinero(g.monto)}</td>
      <td><div class="fila-acciones"></div></td>
    `;
    const acciones = tr.lastElementChild.firstElementChild;
    const bEd = document.createElement('button');
    bEd.className = 'btn-fila'; bEd.textContent = 'Editar';
    bEd.addEventListener('click', () => abrirGastoForm(g));
    const bDel = document.createElement('button');
    bDel.className = 'btn-fila danger'; bDel.textContent = 'Eliminar';
    bDel.addEventListener('click', async () => {
      if (!(await confirmarAccion(`¿Eliminar el gasto de ${dinero(g.monto)} (${g.descripcion})?`, { textoConfirmar: 'Eliminar', peligroso: true }))) return;
      const { error } = await db.from('gastos').delete().eq('id', g.id);
      if (error) { showToast('No se pudo eliminar: ' + error.message, 'error'); return; }
      await cargarDatos();
      showToast('Gasto eliminado');
    });
    acciones.appendChild(bEd);
    acciones.appendChild(bDel);
    tbody.appendChild(tr);
  });
}

function renderGastosChart() {
  const cont = document.getElementById('gastos-chart');
  if (!cont) return;

  const dias = [];
  for (let i = 13; i >= 0; i--) {
    const d = inicioDelDia();
    d.setDate(d.getDate() - i);
    const iso = d.toISOString().slice(0, 10);
    const total = data.gastos.filter(g => g.fecha === iso).reduce((s, g) => s + g.monto, 0);
    dias.push({ iso, total, etiqueta: `${d.getDate()}/${d.getMonth() + 1}` });
  }

  const max = Math.max(...dias.map(d => d.total), 1);
  if (dias.every(d => d.total === 0)) {
    cont.innerHTML = `<div class="chart-vacio">Sin gastos en los últimos 14 días</div>`;
    return;
  }

  cont.innerHTML = dias.map((d, i) => `
    <div class="chart-col">
      <span class="chart-tip">${d.etiqueta} · ${dinero(d.total)}</span>
      <div class="chart-bar" style="height:${Math.max(2, (d.total / max) * 100)}%; --delay:${i * 0.03}s"></div>
      <span class="chart-label">${i % 2 === 0 ? d.etiqueta : ''}</span>
    </div>
  `).join('');
}


/* dispara la transición de las barras: hay que dejar pintar el ancho 0
   primero, si no el navegador no anima el cambio */
function animarBarras(raiz) {
  const barras = (raiz || document).querySelectorAll('.cat-barra-fill[data-width]');
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      barras.forEach(b => { b.style.width = b.dataset.width + '%'; });
    });
  });
}

function renderGastosCategorias() {
  const cont = document.getElementById('gastos-categorias');
  if (!cont) return;

  const lista = gastosDelPeriodo(cajaPeriodo);
  const porCat = {};
  lista.forEach(g => { porCat[g.categoria] = (porCat[g.categoria] || 0) + g.monto; });
  const entradas = Object.entries(porCat).sort((a, b) => b[1] - a[1]);

  if (entradas.length === 0) {
    cont.innerHTML = `<div class="cat-vacio">Sin gastos en este periodo.</div>`;
    return;
  }

  const total = entradas.reduce((s, [, v]) => s + v, 0);
  cont.innerHTML = entradas.map(([cat, monto]) => `
    <div class="cat-row">
      <div class="cat-row-top">
        <span class="cat-nombre">${cat}</span>
        <span class="cat-valor">${dinero(monto)} · ${Math.round((monto / total) * 100)}%</span>
      </div>
      <div class="cat-barra"><div class="cat-barra-fill" data-width="${(monto / total) * 100}"></div></div>
    </div>
  `).join('');
  animarBarras(cont);
}

function renderCaja() {
  renderCajaKPIs();
  renderGastosTabla();
  renderGastosChart();
  renderGastosCategorias();
}

/* ---------- formulario de gasto ---------- */
const gastoForm = document.getElementById('gasto-form');

function abrirGastoForm(gasto = null) {
  if (!gastoForm) return;
  gastoForm.reset();
  gastoEnEdicion = gasto ? gasto.id : null;
  document.getElementById('gasto-title').textContent = gasto ? 'Editar gasto' : 'Registrar gasto';
  document.getElementById('g-id').value = gasto ? gasto.id : '';
  document.getElementById('g-persona').value = gasto ? gasto.persona : '';
  document.getElementById('g-descripcion').value = gasto ? gasto.descripcion : '';
  document.getElementById('g-monto').value = gasto ? gasto.monto : '';
  document.getElementById('g-fecha').value = gasto ? gasto.fecha : hoyISO();
  document.getElementById('g-categoria').value = gasto ? gasto.categoria : 'General';

  // atajos: personas que ya han registrado gastos antes
  const quick = document.getElementById('gasto-quick');
  const personas = [...new Set(data.gastos.map(g => g.persona))].slice(0, 6);
  quick.innerHTML = '';
  if (!gasto && personas.length) {
    personas.forEach(p => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'gasto-quick-chip';
      chip.textContent = p;
      chip.addEventListener('click', () => { document.getElementById('g-persona').value = p; });
      quick.appendChild(chip);
    });
  }

  abrirDrawer('gasto');
}

const btnNuevoGasto = document.getElementById('btn-nuevo-gasto');
if (btnNuevoGasto) btnNuevoGasto.addEventListener('click', () => abrirGastoForm(null));

if (gastoForm) {
  gastoForm.addEventListener('submit', async e => {
    e.preventDefault();
    const fila = {
      persona: document.getElementById('g-persona').value.trim(),
      descripcion: document.getElementById('g-descripcion').value.trim(),
      monto: Number(document.getElementById('g-monto').value) || 0,
      fecha: document.getElementById('g-fecha').value,
      categoria: document.getElementById('g-categoria').value,
      registrado_por: currentProfile ? currentProfile.email : '',
    };

    let error;
    if (gastoEnEdicion) {
      ({ error } = await db.from('gastos').update(fila).eq('id', gastoEnEdicion));
    } else {
      ({ error } = await db.from('gastos').insert([fila]));
    }
    if (error) { showToast('No se pudo guardar: ' + error.message, 'error'); return; }

    cerrarDrawers();
    await cargarDatos();
    showToast(gastoEnEdicion ? 'Gasto actualizado' : 'Gasto registrado');
  });
}

const btnExportarGastos = document.getElementById('btn-exportar-gastos');
if (btnExportarGastos) {
  btnExportarGastos.addEventListener('click', () => {
    const filas = gastosFiltrados();
    if (filas.length === 0) { showToast('No hay gastos que exportar'); return; }
    const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lineas = [['Fecha', 'Persona', 'Descripción', 'Categoría', 'Monto', 'Registrado por'].map(esc).join(',')];
    filas.forEach(g => lineas.push([g.fecha, g.persona, (g.descripcion||'').replace(/[\r\n]+/g,' '), g.categoria, g.monto, g.registradoPor].map(esc).join(',')));
    descargarCSV(lineas.join('\r\n'), `caja-chica-${hoyISO()}.csv`);
    showToast('CSV descargado');
  });
}

function descargarCSV(contenido, nombre) {
  const blob = new Blob(['\uFEFF' + contenido], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = nombre;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/* ==========================================================
   REPORTES
   ========================================================== */
const repPeriodoSelect = document.getElementById('rep-periodo');
if (repPeriodoSelect) repPeriodoSelect.addEventListener('change', renderReportes);

function pedidosVendidos() { return data.pedidos.filter(p => p.estado === 'vendido'); }

function rangoReporte() {
  const dias = Number(repPeriodoSelect ? repPeriodoSelect.value : 30);
  if (dias === 0) return { desde: null, dias: 0 };
  const desde = inicioDelDia();
  desde.setDate(desde.getDate() - (dias - 1));
  return { desde, dias };
}

function ventasEnRango(desde, hasta) {
  return pedidosVendidos().filter(p => {
    const f = new Date(p.fecha + 'T00:00:00');
    if (desde && f < desde) return false;
    if (hasta && f > hasta) return false;
    return true;
  });
}

function renderRepKPIs() {
  const cont = document.getElementById('rep-kpis');
  if (!cont) return;
  const { desde, dias } = rangoReporte();

  const actuales = ventasEnRango(desde, null);
  const kilos = actuales.reduce((s, p) => s + p.kilosTotal, 0);
  const dinero_ = actuales.reduce((s, p) => s + p.precioTotal, 0);
  const clientes = new Set(actuales.map(p => p.cliente.toLowerCase())).size;

  // periodo anterior de la misma duración, para comparar
  let comparativa = null;
  if (dias > 0) {
    const desdeAnt = new Date(desde); desdeAnt.setDate(desdeAnt.getDate() - dias);
    const hastaAnt = new Date(desde); hastaAnt.setDate(hastaAnt.getDate() - 1);
    const previas = ventasEnRango(desdeAnt, hastaAnt);
    comparativa = {
      kilos: previas.reduce((s, p) => s + p.kilosTotal, 0),
      dinero: previas.reduce((s, p) => s + p.precioTotal, 0),
      pedidos: previas.length,
    };
  }

  const inventarioKg = data.jumbos.reduce((s, j) => s + j.kilos, 0);
  const ocupados = data.jumbos.filter(j => j.posicion).length;
  const apartados = data.jumbos.filter(j => j.apartado).length;

  function delta(actual, previo) {
    if (comparativa === null || previo === 0) return '';
    const pct = Math.round(((actual - previo) / previo) * 100);
    const clase = pct >= 0 ? 'up' : 'down';
    return `<span class="kpi-delta ${clase}">${pct >= 0 ? '▲' : '▼'} ${Math.abs(pct)}% vs periodo anterior</span>`;
  }

  const tarjetas = [
    { label: 'Kilos vendidos', valor: kilos.toLocaleString('es-MX') + ' kg', extra: delta(kilos, comparativa ? comparativa.kilos : 0) },
    { label: 'Ingresos', valor: dinero(dinero_), extra: delta(dinero_, comparativa ? comparativa.dinero : 0) },
    { label: 'Pedidos vendidos', valor: actuales.length, extra: delta(actuales.length, comparativa ? comparativa.pedidos : 0) },
    { label: 'Clientes distintos', valor: clientes, extra: '<span class="kpi-sub">en el periodo</span>' },
    { label: 'Inventario actual', valor: inventarioKg.toLocaleString('es-MX') + ' kg', extra: `<span class="kpi-sub">${data.jumbos.length} jumbos</span>` },
    { label: 'Espacios ocupados', valor: `${ocupados} / 160`, extra: `<span class="kpi-sub">${apartados} apartados</span>` },
  ];

  cont.innerHTML = tarjetas.map(t => `
    <div class="kpi-card">
      <span class="kpi-label">${t.label}</span>
      <span class="kpi-valor">${t.valor}</span>
      ${t.extra}
    </div>
  `).join('');
}

function bucketsDeReporte() {
  const { desde, dias } = rangoReporte();
  const vendidos = pedidosVendidos();

  // agrupación: por día si el rango es corto, por mes si es largo
  if (dias > 0 && dias <= 31) {
    const out = [];
    for (let i = dias - 1; i >= 0; i--) {
      const d = inicioDelDia(); d.setDate(d.getDate() - i);
      const iso = d.toISOString().slice(0, 10);
      const delDia = vendidos.filter(p => p.fecha === iso);
      out.push({
        etiqueta: `${d.getDate()}/${d.getMonth() + 1}`,
        kilos: delDia.reduce((s, p) => s + p.kilosTotal, 0),
        dinero: delDia.reduce((s, p) => s + p.precioTotal, 0),
      });
    }
    return out;
  }

  const meses = dias === 0 ? 12 : Math.max(1, Math.round(dias / 30));
  const out = [];
  const base = new Date(); base.setDate(1); base.setHours(0,0,0,0);
  for (let i = meses - 1; i >= 0; i--) {
    const d = new Date(base); d.setMonth(d.getMonth() - i);
    const clave = d.toISOString().slice(0, 7);
    const delMes = vendidos.filter(p => (p.fecha || '').slice(0, 7) === clave);
    out.push({
      etiqueta: d.toLocaleDateString('es-MX', { month: 'short' }),
      kilos: delMes.reduce((s, p) => s + p.kilosTotal, 0),
      dinero: delMes.reduce((s, p) => s + p.precioTotal, 0),
    });
  }
  return out;
}

function pintarChart(contId, buckets, campo, formato) {
  const cont = document.getElementById(contId);
  if (!cont) return;
  if (!buckets.length || buckets.every(b => b[campo] === 0)) {
    cont.innerHTML = `<div class="chart-vacio">Sin datos en este periodo</div>`;
    return;
  }
  const max = Math.max(...buckets.map(b => b[campo]), 1);
  const paso = Math.max(1, Math.ceil(buckets.length / 10));
  cont.innerHTML = buckets.map((b, i) => `
    <div class="chart-col">
      <span class="chart-tip">${b.etiqueta} · ${formato(b[campo])}</span>
      <div class="chart-bar" style="height:${Math.max(2, (b[campo] / max) * 100)}%; --delay:${i * 0.025}s"></div>
      <span class="chart-label">${i % paso === 0 ? b.etiqueta : ''}</span>
    </div>
  `).join('');
}

function pintarCatList(contId, entradas, formato, colorPorNombre, denominador) {
  const cont = document.getElementById(contId);
  if (!cont) return;
  if (entradas.length === 0) {
    cont.innerHTML = `<div class="cat-vacio">Sin datos todavía.</div>`;
    return;
  }
  // por defecto la barra se llena relativa al valor más alto de la lista;
  // si se pasa un denominador (ej. el total, o una capacidad fija como 32),
  // la barra queda a la misma escala que el porcentaje mostrado en el texto.
  const max = denominador || Math.max(...entradas.map(e => e[1]), 1);
  cont.innerHTML = entradas.map(([nombre, valor]) => {
    const c = colorPorNombre ? colorPorNombre(nombre) : 'var(--ink)';
    return `
      <div class="cat-row">
        <div class="cat-row-top">
          <span class="cat-nombre"><span class="cat-punto" style="background:${c}"></span>${nombre}</span>
          <span class="cat-valor">${formato(valor)}</span>
        </div>
        <div class="cat-barra"><div class="cat-barra-fill" data-width="${Math.min(100, (valor / max) * 100)}" style="background:${c}"></div></div>
      </div>
    `;
  }).join('');
  animarBarras(cont);
}

function renderReportes() {
  if (!document.getElementById('rep-kpis')) return;
  renderRepKPIs();

  const buckets = bucketsDeReporte();
  pintarChart('rep-chart-kilos', buckets, 'kilos', v => v.toLocaleString('es-MX') + ' kg');
  pintarChart('rep-chart-dinero', buckets, 'dinero', v => dinero(v));

  // inventario actual por material
  const invMat = {};
  data.jumbos.forEach(j => { invMat[j.material] = (invMat[j.material] || 0) + j.kilos; });
  const totalInv = Object.values(invMat).reduce((a, b) => a + b, 0) || 1;
  pintarCatList('rep-inventario-material',
    Object.entries(invMat).sort((a, b) => b[1] - a[1]),
    v => `${v.toLocaleString('es-MX')} kg · ${Math.round((v / totalInv) * 100)}%`,
    colorMaterial, totalInv);

  // kilos vendidos por material en el periodo
  const { desde } = rangoReporte();
  const vendidasRango = ventasEnRango(desde, null);
  const vendMat = {};
  vendidasRango.forEach(p => p.items.forEach(it => {
    vendMat[it.material] = (vendMat[it.material] || 0) + (Number(it.kilos) || 0);
  }));
  const totalVend = Object.values(vendMat).reduce((a, b) => a + b, 0) || 1;
  pintarCatList('rep-vendido-material',
    Object.entries(vendMat).sort((a, b) => b[1] - a[1]),
    v => `${v.toLocaleString('es-MX')} kg · ${Math.round((v / totalVend) * 100)}%`,
    colorMaterial, totalVend);

  // ocupación por rack
  const ocup = RACKS.map(r => {
    const n = data.jumbos.filter(j => j.posicion && j.posicion.rack === r).length;
    return [`Rack ${r}`, n];
  });
  pintarCatList('rep-ocupacion', ocup, v => `${v} / 32 · ${Math.round((v / 32) * 100)}%`, null, 32);

  // mejores clientes
  const tbodyCli = document.getElementById('rep-clientes');
  if (tbodyCli) {
    const porCliente = {};
    vendidasRango.forEach(p => {
      const k = p.cliente || '—';
      if (!porCliente[k]) porCliente[k] = { pedidos: 0, kilos: 0, total: 0 };
      porCliente[k].pedidos++;
      porCliente[k].kilos += p.kilosTotal;
      porCliente[k].total += p.precioTotal;
    });
    const filas = Object.entries(porCliente).sort((a, b) => b[1].total - a[1].total).slice(0, 8);
    tbodyCli.innerHTML = filas.length
      ? filas.map(([n, v]) => `<tr><td>${n}</td><td>${v.pedidos}</td><td>${v.kilos.toLocaleString('es-MX')} kg</td><td>${dinero(v.total)}</td></tr>`).join('')
      : `<tr><td colspan="4" class="inv-empty">Sin ventas en este periodo.</td></tr>`;
  }

  // jumbos más antiguos en almacén
  const tbodyAnt = document.getElementById('rep-antiguos');
  if (tbodyAnt) {
    const filas = [...data.jumbos]
      .sort((a, b) => diasEnAlmacen(b.fechaIngreso) - diasEnAlmacen(a.fechaIngreso))
      .slice(0, 8);
    tbodyAnt.innerHTML = filas.length
      ? filas.map(j => `<tr>
          <td class="inv-folio">${j.folio}</td>
          <td>${j.material} · ${j.color}</td>
          <td>${j.kilos.toLocaleString('es-MX')} kg</td>
          <td class="inv-ubicacion ${j.posicion ? '' : 'sin-ubicar'}">${j.posicion ? codigoPosicion(j.posicion) : 'Sin ubicar'}</td>
          <td>${diasEnAlmacen(j.fechaIngreso)}d</td>
        </tr>`).join('')
      : `<tr><td colspan="5" class="inv-empty">No hay jumbos en almacén.</td></tr>`;
  }
}

/* ==========================================================
   ROLES (solo administrador)
   ========================================================== */
async function cargarYRenderizarRoles() {
  const tbody = document.getElementById('roles-tbody');
  if (!tbody || miRol() !== 'administrador') return;

  const { data: rows, error } = await db.from('profiles').select('*').order('created_at');
  if (error) { console.error(error); return; }

  tbody.innerHTML = '';
  rows.forEach(p => {
    const tr = document.createElement('tr');

    const tdCorreo = document.createElement('td');
    tdCorreo.textContent = p.email;
    if (currentUser && p.id === currentUser.id) tdCorreo.textContent += ' (tú)';

    const tdActual = document.createElement('td');
    tdActual.innerHTML = `<span class="rol-badge ${p.role === 'pendiente' ? 'is-pendiente' : ''}">${p.role}</span>`;

    const tdSelect = document.createElement('td');
    const sel = document.createElement('select');
    sel.className = 'rol-select';
    ROLES_ASIGNABLES.forEach(r => {
      const opt = document.createElement('option');
      opt.value = r; opt.textContent = r;
      if (r === p.role) opt.selected = true;
      sel.appendChild(opt);
    });
    sel.addEventListener('change', async () => {
      const nuevoRol = sel.value;
      const { error: err2 } = await db.from('profiles').update({ role: nuevoRol }).eq('id', p.id);
      if (err2) { showToast('No se pudo cambiar el rol: ' + err2.message, 'error'); cargarYRenderizarRoles(); return; }
      showToast(`${p.email} ahora es ${nuevoRol}`);
      cargarYRenderizarRoles();
      if (currentUser && p.id === currentUser.id) cargarPerfilYArrancar();
    });
    tdSelect.appendChild(sel);

    tr.appendChild(tdCorreo);
    tr.appendChild(tdActual);
    tr.appendChild(tdSelect);
    tbody.appendChild(tr);
  });
}

/* ==========================================================
   AUTENTICACIÓN
   ========================================================== */
const authScreen = document.getElementById('auth-screen');
const pendingScreen = document.getElementById('pending-screen');
const appRoot = document.getElementById('app-root');

function mostrarPantalla(nombre) {
  authScreen.hidden = nombre !== 'auth';
  pendingScreen.hidden = nombre !== 'pending';
  appRoot.hidden = nombre !== 'app';
}

document.querySelectorAll('.auth-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.auth-tab').forEach(t => t.classList.remove('is-active'));
    tab.classList.add('is-active');
    const esLogin = tab.dataset.authTab === 'login';
    document.getElementById('login-form').hidden = !esLogin;
    document.getElementById('signup-form').hidden = esLogin;
  });
});

document.getElementById('login-form').addEventListener('submit', async e => {
  e.preventDefault();
  const errEl = document.getElementById('login-error');
  errEl.hidden = true;
  const { error } = await db.auth.signInWithPassword({
    email: document.getElementById('login-email').value.trim(),
    password: document.getElementById('login-password').value,
  });
  if (error) { errEl.textContent = 'Correo o contraseña incorrectos.'; errEl.hidden = false; }
});

document.getElementById('signup-form').addEventListener('submit', async e => {
  e.preventDefault();
  const errEl = document.getElementById('signup-error');
  errEl.hidden = true;
  const { error } = await db.auth.signUp({
    email: document.getElementById('signup-email').value.trim(),
    password: document.getElementById('signup-password').value,
  });
  if (error) { errEl.textContent = error.message; errEl.hidden = false; }
});

document.getElementById('btn-logout').addEventListener('click', () => db.auth.signOut());
document.getElementById('btn-logout-pending').addEventListener('click', () => db.auth.signOut());

function aplicarPermisosDeRol(role) {
  let primerVisible = null;
  document.querySelectorAll('.nav-item').forEach(btn => {
    const permitido = (btn.dataset.roles || '').split(',').includes(role);
    btn.hidden = !permitido;
    if (permitido && !primerVisible) primerVisible = btn;
  });

  // Supabase revisa la sesión cada que la pestaña recupera el foco, y eso
  // vuelve a llamar esta función — si ya hay una sección activa y sigue
  // siendo válida para el rol, no tocamos nada para no perder tu lugar.
  const activo = document.querySelector('.nav-item.is-active');
  if (activo && !activo.hidden) return;

  document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('is-active'));
  document.querySelectorAll('.view').forEach(v => v.classList.remove('is-active'));
  if (primerVisible) {
    primerVisible.classList.add('is-active');
    document.getElementById(`view-${primerVisible.dataset.section}`).classList.add('is-active');
  }
}

async function cargarPerfilYArrancar() {
  const { data: { user } } = await db.auth.getUser();
  currentUser = user;

  if (!user) { currentProfile = null; mostrarPantalla('auth'); return; }

  const { data: perfil, error } = await db.from('profiles').select('*').eq('id', user.id).single();
  if (error || !perfil) {
    console.error('No se pudo cargar el perfil:', error);
    mostrarPantalla('auth');
    return;
  }
  currentProfile = perfil;

  if (perfil.role === 'pendiente') { mostrarPantalla('pending'); return; }

  aplicarPermisosDeRol(perfil.role);
  document.getElementById('sidebar-user-email').textContent = perfil.email;
  document.getElementById('sidebar-user-role').textContent = perfil.role;

  mostrarPantalla('app');
  if (primeraCarga) {
    renderEsqueletoBoard();
    renderEsqueletoTabla('inv-tbody', 5, 5);
    primeraCarga = false;
  }
  await cargarDatos();
  if (perfil.role === 'administrador') cargarYRenderizarRoles();
  suscribirRealtime();
  if (!uiRestaurada) { restaurarUbicacionUI(); uiRestaurada = true; }
}

db.auth.onAuthStateChange(() => { cargarPerfilYArrancar(); });

/* ==========================================================
   ARRANQUE
   ========================================================== */
cargarPerfilYArrancar();

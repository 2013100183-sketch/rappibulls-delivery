
let client = null;
let access = '';
let data = { riders: [], orders: [], zones: [] };
let busy = false;
let loggingIn = false;

const values = [
  'local', 'products', 'instructions', 'address',
  'reference', 'phone', 'map', 'notes', 'payment',
  'productAmount', 'deliveryAmount', 'etaMinutes',
  'rider', 'assignment', 'reason', 'raw', 'zoneId', 'realDeliveryAmount'
];

function get(id) {
  return $(id).value.trim();
}

function set(id, value) {
  $(id).value = value ?? '';
}

function check() {
  if (!access) {
    throw Error('Primero debes iniciar sesión.');
  }
}

async function call(action, body = {}) {
  check();
  return api(action, body, access);
}

function showError(id, error) {
  const element = $(id);
  if (element) {
    element.textContent = error?.message || String(error);
  }
}

async function load() {
  if (!access || busy) return;

  const focused = document.activeElement;

  if (
    ['INPUT', 'TEXTAREA', 'SELECT'].includes(focused?.tagName) &&
    focused.closest('#orders')
  ) {
    return;
  }

  busy = true;

  try {
    data = await call('list');
    render();
  } catch (error) {
    console.error('Error al cargar pedidos:', error);
    showError('formError', error);
  } finally {
    busy = false;
  }
}

function render() {
  const rs = data.riders || [];
  const os = data.orders || [];
  const zones = data.zones || [];
  const selectedZone=get('zone');
  $('zone').innerHTML='<option value="">Sin zona definida</option>'+zones.filter(z=>z.active).map(z=>`<option value="${esc(z.id)}">${esc(z.name)}</option>`).join('');
  if(zones.some(z=>z.id===selectedZone && z.active)) set('zone',selectedZone);
  $('zones').innerHTML=zones.map(z=>`<div class="row item"><b>${esc(z.name)}</b><span>${z.active?'Activa':'Desactivada'}</span><button class="secondary" data-zone-edit="${z.id}">Editar</button><button class="secondary" data-zone-toggle="${z.id}">${z.active?'Desactivar':'Activar'}</button></div>`).join('')||'<p>Agrega una zona para comenzar.</p>';


  $('riders').innerHTML = rs.map((r, i) => `
    <div class="item">
      <b>${i + 1}. ${esc(r.name)}</b>
      · ${
        r.retired ? '⛔ Inactivo' : r.active
          ? r.busy
            ? '🔴 Ocupado'
            : r.pending
              ? '🟡 Solicitud pendiente'
              : '🟢 Disponible'
          : '⚪ Pausado'
      }

      <button class="secondary" data-toggle="${r.id}" ${r.retired?'disabled':''}>
        ${r.active ? 'Fuera de turno' : 'En turno'}
      </button>

      <button class="secondary" data-retire="${r.id}">${r.retired?'Restaurar registro':'Retirar del listado'}</button>
      <button class="secondary" data-rider-link="${r.token}">
        Copiar enlace único
      </button>
    </div>
  `).join('') || '<p>Sin motorizados</p>';

  const current = get('rider');

  $('rider').innerHTML = '<option value="">📥 Recibido por asignar</option>' + rs
    .filter(r => r.active && !r.retired)
    .map(r => `
      <option value="${r.id}">
        ${esc(r.name)}
        ${r.busy ? ' (ocupado)' : ''}
        ${r.pending ? ' (pendiente)' : ''}
      </option>
    `).join('');

  if (rs.some(r => r.id === current)) {
    set('rider', current);
  }

  const renderOrder = o => `
    <div class="item">
      <div class="row">
        <h3>${esc(o.code)} · ${esc(o.local)}</h3>
        ${pill(o)}
      </div>

      <p>
        <b>Motorizado:</b> ${esc(o.riderName)}
        · <b>Entrega:</b> ${esc(o.address)}
        · <b>Zona:</b> ${esc(o.zoneName || 'Sin zona')}
      </p>

      <p>${esc(o.products)}</p>

      ${total(o)}
      ${eta(o)}
      <p><b>Delivery real (interno):</b> ${o.realDeliveryAmount == null ? 'Sin definir' : money(o.realDeliveryAmount)}</p>
      <div class="row"><label>Delivery real S/<input type="number" min="0" step="0.01" data-real-input="${o.id}" value="${o.realDeliveryAmount ?? ''}"></label><button class="secondary" data-real-save="${o.id}">Guardar delivery real</button></div>
      ${!o.cancelled && o.stage===0 ? `<div class="row"><label>Asignar motorizado<select data-assign-rider="${o.id}"><option value="">Seleccionar</option>${rs.filter(r=>r.active&&!r.retired).map(r=>`<option value="${r.id}">${esc(r.name)}${os.some(x=>x.riderId===r.id&&x.stage>=1&&x.stage<5&&!x.cancelled&&!x.rejected&&x.zoneId&&x.zoneId===o.zoneId)?' · 🛵 MISMA ZONA EN RUTA':''}</option>`).join('')}</select></label><button data-assign="${o.id}">Designar</button>${o.riderId?`<button class="secondary" data-unassign="${o.id}">Devolver a recibidos</button>`:''}</div>` : ''}

      <div class="row">
        <label>
          Productos S/
          <input
            data-p="${o.id}"
            type="number"
            min="0"
            step="0.01"
            value="${o.productAmount}"
          >
        </label>

        <label>
          Delivery S/
          <input
            data-d="${o.id}"
            type="number"
            min="0"
            step="0.01"
            value="${o.deliveryAmount}"
          >
        </label>

        <button class="secondary" data-prices="${o.id}">
          Guardar importes
        </button>
      </div>

      <div class="row">
        <label>
          ETA minutos
          <input
            data-eta="${o.id}"
            type="number"
            min="1"
            max="360"
            value="${o.etaMinutes ?? ''}"
          >
        </label>

        <button class="secondary" data-saveeta="${o.id}">
          Actualizar ETA
        </button>
      </div>

      <p>
        <button class="secondary" data-copyr="${o.id}">
          Enlace motorizado
        </button>

        <button class="secondary" data-copyc="${o.id}">
          Enlace cliente
        </button>

        ${
          o.stage === 0 && !o.rejected && !o.cancelled
            ? `<button data-sent="${o.id}">
                 Confirmar WhatsApp enviado
               </button>`
            : ''
        }

        <button
          class="danger"
          data-cancel="${o.id}"
          ${o.cancelled || o.stage === 5 ? 'disabled' : ''}
        >
          Cancelar
        </button>
      </p>

    </div>
  `;
  const groups = [
    ['📥 Pedidos recibidos por asignar', o => !o.riderId && !o.cancelled && o.stage===0],
    ['📋 Pedidos designados', o => o.riderId && o.stage === 0 && !o.cancelled && !o.rejected],
    ['🏍️ Pedidos aceptados', o => o.stage >= 1 && o.stage < 5 && !o.cancelled && !o.rejected],
    ['✅ Pedidos entregados', o => o.stage === 5 && !o.cancelled]
  ];
  $('orders').innerHTML = groups.map(([name, filter]) => {
    const list = os.filter(filter);
    return `<section class="order-group"><h3>${name} (${list.length})</h3>${list.map(renderOrder).join('') || '<p class="muted">Sin pedidos en esta sección.</p>'}</section>`;
  }).join('') + (os.some(o => o.cancelled || o.rejected) ? `<details><summary>Historial de rechazados y cancelados (${os.filter(o => o.cancelled || o.rejected).length})</summary>${os.filter(o => o.cancelled || o.rejected).map(renderOrder).join('')}</details>` : '');
}

async function run(action, body) {
  try {
    await call(action, body);
    await load();
  } catch (error) {
    console.error('Error de operación:', error);
    alert(error.message);
  }
}

// ==========================================
// INICIO DE SESIÓN CORREGIDO
// ==========================================

$('enter').onclick = async () => {
  if (loggingIn) return;

  loggingIn = true;

  $('enter').disabled = true;
  $('enter').textContent = 'Ingresando...';

  try {
    $('loginError').textContent = '';

    const email = get('email');
    const password = get('password');

    if (!email || !password) {
      throw Error('Ingresa tu correo y contraseña.');
    }

    const conf = await api('config');

    if (!conf || !conf.url || !conf.anonKey) {
      throw Error(
        'Netlify no está entregando SUPABASE_URL o SUPABASE_ANON_KEY. Revisa las variables de entorno.'
      );
    }

    // Evita crear varias conexiones de Supabase.
    if (!client) {
      client = supabase.createClient(
        conf.url,
        conf.anonKey
      );
    }

    const result = await client.auth.signInWithPassword({
      email,
      password
    });

    if (result.error) {
      throw Error(
        'Supabase rechazó el inicio de sesión: ' +
        result.error.message
      );
    }

    if (!result.data?.session?.access_token) {
      throw Error(
        'No se recibió una sesión válida desde Supabase.'
      );
    }

    access = result.data.session.access_token;

    // Verificar acceso a los datos.
    try {
      data = await call('list');
    } catch (error) {
      throw Error(
        'Supabase inició sesión, pero no se pudieron consultar los pedidos: ' +
        error.message
      );
    }

    // CORREGIDO: el CSS utiliza .hide
    $('login').classList.add('hide');
    $('app').classList.remove('hide');

    render();

    console.log('Inicio de sesión completado.');

  } catch (error) {
    console.error('Error de ingreso:', error);
    showError('loginError', error);

  } finally {
    loggingIn = false;
    $('enter').disabled = false;
    $('enter').textContent = 'Ingresar';
  }
};

// ==========================================
// CERRAR SESIÓN
// ==========================================

$('logout').onclick = async () => {
  try {
    if (client) {
      await client.auth.signOut();
    }
  } catch (error) {
    console.warn('Error al cerrar sesión:', error);
  }

  access = '';
  data = { riders: [], orders: [] };

  $('app').classList.add('hide');
  $('login').classList.remove('hide');
};

// ==========================================
// MOTORIZADOS
// ==========================================

$('addRider').onclick = () => {
  run('add_rider', {
    name: get('riderName')
  });
};

$('riders').onclick = event => {
  const target = event.target;

  if (target.dataset.riderLink) {
    copy(
      link('motorizado.html', target.dataset.riderLink)
    );
  }

  if (target.dataset.retire) { const r=data.riders.find(x=>x.id===target.dataset.retire); if(r&&confirm(r.retired?'¿Restaurar registro?':'¿Retirar motorizado del listado sin borrar su historial?')) run(r.retired?'restore_rider':'retire_rider',{id:r.id}); }
  if (target.dataset.toggle) {
    run('toggle_rider', {
      id: target.dataset.toggle
    });
  }
};

$('addZone').onclick=async()=>{const name=get('zoneName');if(!name)return alert('Escribe la zona');await run('zone_add',{name});set('zoneName','');};
$('zones').onclick=e=>{const b=e.target.closest('button');if(!b)return;const id=b.dataset.zoneToggle||b.dataset.zoneEdit;const z=(data.zones||[]).find(x=>x.id===id);if(!z)return;if(b.dataset.zoneEdit){const name=prompt('Nuevo nombre de la zona:',z.name);if(name&&name.trim())run('zone_update',{id,name:name.trim()});}else if(b.dataset.zoneToggle)run('zone_update',{id,active:!z.active});};
// ==========================================
// EXTRAER DATOS DE WHATSAPP
// ==========================================

$('extract').onclick = () => {
  try {
    const fields = parseV3(get('raw'));

    for (const key of Object.keys(fields)) {
      if ($(key)) {
        set(key, fields[key]);
      }
    }

    recalc();

    alert(
      'Datos extraídos. Revisa productos, dirección y referencias antes de guardar.'
    );

  } catch (error) {
    showError('formError', error);
  }
};

// ==========================================
// CALCULAR TOTAL
// ==========================================

function recalc() {
  const products = Number(get('productAmount')) || 0;
  const delivery = Number(get('deliveryAmount')) || 0;

  $('total').textContent =
    'Total: ' + money(products + delivery);
}

for (const key of [
  'productAmount',
  'deliveryAmount'
]) {
  $(key).oninput = recalc;
}

// ==========================================
// REGISTRAR PEDIDO
// ==========================================

$('create').onclick = async () => {
  try {
    $('formError').textContent = '';

    const body = {};

    for (const key of values) {
      body[key] = key==='zoneId' ? get('zone') : get(key);
    }

    await call('create', body);

    for (const key of values) {
      const el=$(key);if(el) set(key, '');
    }
    set('zone','');
    set('rider','');
    set('assignment','turno');
    set('productAmount', '0');
    set('deliveryAmount', '0');
    recalc();
    $('local').focus();

    $('formError').textContent =
      'Pedido registrado correctamente.';

    await load();

  } catch (error) {
    console.error('Error al registrar pedido:', error);
    showError('formError', error);
  }
};

// ==========================================
// ACTUALIZAR PEDIDOS
// ==========================================

$('refresh').onclick = load;

// ==========================================
// ACCIONES DE PEDIDOS
// ==========================================

$('orders').onclick = event => {
  const target = event.target;

  const id =
    target.dataset.assign ||
    target.dataset.unassign ||
    target.dataset.realSave ||
    target.dataset.prices ||
    target.dataset.saveeta ||
    target.dataset.copyr ||
    target.dataset.copyc ||
    target.dataset.sent ||
    target.dataset.cancel;

  if (!id) return;

  const order = data.orders.find(o => o.id === id);

  if (!order) return;

  const item = target.closest('.item');

  if(target.dataset.assign){
    const riderId=item.querySelector('[data-assign-rider]').value;
    if(!riderId)return alert('Selecciona un motorizado');
    const r=data.riders.find(x=>x.id===riderId);
    const active=data.orders.filter(x=>x.riderId===riderId&&x.stage>=1&&x.stage<5&&!x.cancelled&&!x.rejected);
    const assignment=active.length?'manual':'turno';
    const reason=active.length?'Pedido adicional en ruta por zona: '+(order.zoneName||'sin zona'):'';
    if(active.length&&!confirm('Motorizado '+r.name+' tiene '+active.length+' pedido(s) activo(s). ¿Asignar adicional en ruta?'))return;
    run('assign_order',{id,riderId,assignment,reason});
  } else if(target.dataset.unassign){if(confirm('¿Devolver pedido a recibidos por asignar?'))run('unassign_order',{id});
  } else if(target.dataset.realSave){run('real_delivery',{id,amount:item.querySelector('[data-real-input]').value});
  } else if (target.dataset.prices) {
    run('prices', {
      id,
      productAmount:
        item.querySelector('[data-p]').value,
      deliveryAmount:
        item.querySelector('[data-d]').value
    });

  } else if (target.dataset.saveeta) {
    run('eta', {
      id,
      etaMinutes:
        item.querySelector('[data-eta]').value
    });

  } else if (target.dataset.copyr) {
    copy(
      link('motorizado.html', order.riderToken)
    );

  } else if (target.dataset.copyc) {
    copy(
      link('seguimiento.html', order.clientToken)
    );

  } else if (target.dataset.sent) {
    if (
      confirm(
        '¿Confirmas que enviaste el enlace al motorizado? No existe límite automático de respuesta.'
      )
    ) {
      run('mark_sent', { id });
    }

  } else if (target.dataset.cancel) {
    if (confirm('¿Cancelar pedido?')) {
      run('cancel', { id });
    }
  }
};

// ==========================================
// ACTUALIZACIÓN AUTOMÁTICA CADA 3 SEGUNDOS
// ==========================================

setInterval(async () => {
  if (!client || !access || loggingIn) {
    return;
  }

  try {
    const result = await client.auth.getSession();

    if (!result.data?.session?.access_token) {
      access = '';

      $('app').classList.add('hide');
      $('login').classList.remove('hide');

      return;
    }

    access = result.data.session.access_token;

    await load();

  } catch (error) {
    console.warn(
      'Error de actualización:',
      error
    );
  }
}, 3000);
